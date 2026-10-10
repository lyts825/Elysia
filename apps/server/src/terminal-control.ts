import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AgentTerminalProfile,
  AppError,
  Command,
  invariant,
  type Project,
  type ProviderConfig,
} from '../../../packages/contracts/src/index.js';
import {
  TerminalAppId,
  TerminalConnectionBinding,
  TerminalConnectionWrite,
  TerminalControlApps,
  TerminalProjectPreferences,
  TerminalConnectionProbeRequest,
  TerminalConnectionProbeResult,
  TerminalProfileDiagnostics,
  type TerminalAppCatalogEntry,
  type TerminalConnectionView,
  type TerminalControlOverview,
} from '../../../packages/contracts/src/terminal-control.js';
import { type Store, stable } from '../../../packages/storage/src/index.js';
import type { DesktopServices } from './desktop.js';
import { ProviderKeys } from './provider-keys.js';
import { terminalConnectionConfiguration } from '../../../packages/runtime/src/terminal-connection.js';
import {
  terminalConnectionProbe,
  terminalProbeFailure,
  type TerminalConnectionProbeOptions,
} from './terminal-connection-probe.js';
import {
  terminalSettings,
  terminalControlApps,
  writeTerminalControlApps,
  writeTerminalSettings,
} from './terminal-settings.js';
import {
  terminalAppCatalog,
  terminalAppForProfile,
  assertTerminalConnectionCompatible,
  terminalProtocols as protocols,
} from './terminal-catalog.js';
export {
  terminalAppCatalog,
  terminalAppForProfile,
  assertTerminalConnectionCompatible,
} from './terminal-catalog.js';

const connectionsKey = 'surface:terminal:control:connections:v1';
const deletedConnectionsKey = 'surface:terminal:control:deleted-connections:v1';
const appsKey = 'surface:terminal:control:apps:v1';
const projectKey = (projectId: string) => `surface:terminal:control:project:${projectId}`;
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const clean = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) {
      clean();
      reject(signal.reason);
      return;
    }
    promise.then(
      (value) => {
        clean();
        resolve(value);
      },
      (error) => {
        clean();
        reject(error);
      },
    );
  });
}
/** ProviderKeys encryption is reused, but every vault operation targets the terminal vault. */
export function terminalProviderKeys(desktop?: DesktopServices): ProviderKeys {
  return new ProviderKeys(
    desktop && {
      request(operation, value) {
        invariant(
          operation === 'key-vault-read' || operation === 'key-vault-write',
          'TERMINAL_VAULT_OPERATION',
          '终端凭据仅使用独立密钥库',
        );
        return desktop.request(
          operation === 'key-vault-read' ? 'terminal-key-vault-read' : 'terminal-key-vault-write',
          value,
        );
      },
    },
  );
}
export class TerminalControlService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly keys: ProviderKeys;
  private readonly probes = new Map<string, AbortController>();
  private closed = false;
  constructor(
    private readonly store: Store,
    desktop?: DesktopServices,
    private readonly probeOptions: TerminalConnectionProbeOptions = {},
  ) {
    this.keys = terminalProviderKeys(desktop);
  }
  private read<T>(key: string, schema: z.ZodType<T>, fallback: () => T): T {
    const row = this.store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(key) as
      | { value: string }
      | undefined;
    return row ? schema.parse(JSON.parse(row.value)) : fallback();
  }
  private write(key: string, value: unknown) {
    this.store.db
      .prepare(
        'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, stable(value));
  }
  connections() {
    return this.read(connectionsKey, z.array(TerminalConnectionBinding).max(100), () => []);
  }
  apps(): TerminalControlApps {
    return terminalControlApps(this.store);
  }
  preferences(projectId: string): TerminalProjectPreferences {
    this.store.require<Project>('projects', projectId);
    return this.read(projectKey(projectId), TerminalProjectPreferences, () => ({
      revision: 0,
      defaultProfileId: null,
      connectionId: null,
    }));
  }
  removeProjectPreferences(projectId: string) {
    this.store.db.prepare('DELETE FROM storage_meta WHERE key=?').run(projectKey(projectId));
  }
  private async view(connection: TerminalConnectionBinding): Promise<TerminalConnectionView> {
    return {
      ...connection,
      keyConfigured: await this.keys.configured(this.keyConfig(connection)),
      credentialSource: connection.auth.kind,
    };
  }
  async overview(): Promise<TerminalControlOverview> {
    return {
      catalog: terminalAppCatalog(),
      apps: this.apps(),
      connections: await Promise.all(this.connections().map((connection) => this.view(connection))),
    };
  }
  private keyConfig(connection: TerminalConnectionBinding): ProviderConfig {
    // ProviderKeys reads only these two fields. Native provider records are never consulted.
    return {
      credentialId: connection.auth.kind === 'vault' ? connection.auth.credentialRef : null,
      apiKeyEnv: connection.auth.kind === 'environment' ? connection.auth.env : 'ELYSIA_TERMINAL_API_KEY',
    } as ProviderConfig;
  }
  async credential(binding: TerminalConnectionBinding): Promise<string> {
    const connection = TerminalConnectionBinding.parse(binding);
    return (await this.keys.credential(this.keyConfig(connection))).token;
  }
  async probe(connectionId: string, input: unknown, operation: 'check' | 'models', caller?: AbortSignal) {
    const id = z.string().uuid().parse(connectionId);
    const body = TerminalConnectionProbeRequest.parse(input);
    const binding = this.connections().find((connection) => connection.id === id);
    invariant(binding, 'TERMINAL_CONNECTION_MISSING', '所选 API 连接已删除，请刷新');
    this.revision(body.expectedRevision, binding.revision);
    if (this.closed)
      throw new AppError('TERMINAL_CONTROL_CLOSED', '服务正在退出，请稍后重试', false, null, 409);
    if (this.probes.has(id))
      throw new AppError('TERMINAL_API_BUSY', '此连接已有请求正在进行，请等待或取消后重试', false, null, 409);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.probeOptions.timeoutMs ?? 20000),
      ...(caller ? [caller] : []),
    ]);
    this.probes.set(id, controller);
    const started = Date.now();
    try {
      let outcome;
      try {
        signal.throwIfAborted();
        const credential = await abortable(this.credential(binding), signal);
        signal.throwIfAborted();
        outcome = await terminalConnectionProbe(binding, credential, operation, signal, this.probeOptions);
      } catch (error) {
        outcome = terminalProbeFailure(error, signal);
      }
      const current = this.connections().find((connection) => connection.id === id);
      if (!current || current.revision !== binding.revision)
        throw new AppError(
          'TERMINAL_CONNECTION_STALE',
          '连接已修改或删除，请使用最新配置重新操作',
          false,
          null,
          409,
        );
      return TerminalConnectionProbeResult.parse({
        ...outcome,
        connectionId: id,
        revision: binding.revision,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.max(0, Date.now() - started),
      });
    } finally {
      this.probes.delete(id);
    }
  }
  close() {
    this.closed = true;
    for (const controller of this.probes.values()) controller.abort();
  }
  async diagnostics(profileId: string, input: unknown = {}) {
    const id = z.string().uuid().parse(profileId);
    const body = z.object({ projectId: z.string().uuid().optional() }).strict().parse(input);
    const settings = terminalSettings(this.store);
    const profile = settings.profiles.find((entry) => entry.id === id);
    invariant(profile, 'TERMINAL_PROFILE_MISSING', '所选终端模板不存在，请刷新');
    const apps = this.apps();
    const preferences = body.projectId ? this.preferences(body.projectId) : null;
    const connections = this.connections();
    const issues: TerminalProfileDiagnostics['issues'] = [];
    let source: TerminalProfileDiagnostics['source'] = 'environment';
    let selected: string | null = null;
    if (profile.connectionId !== undefined) {
      selected = profile.connectionId;
      source = selected ? 'template' : 'environment';
    } else {
      const projectConnection = connections.find((entry) => entry.id === preferences?.connectionId);
      if (projectConnection && protocols[profile.agent].includes(projectConnection.protocol)) {
        selected = projectConnection.id;
        source = 'project';
      } else {
        if (preferences?.connectionId)
          issues.push({
            severity: 'warning',
            code: 'TERMINAL_PROJECT_CONNECTION_FALLBACK',
            message: '项目连接已删除或与当前 CLI 不兼容，当前模板沿用应用连接或环境变量',
          });
        selected = apps.entries.find((entry) => entry.id === terminalAppForProfile(profile))!.connectionId;
        source = selected ? 'app' : 'environment';
      }
    }
    const connection = connections.find((entry) => entry.id === selected) ?? null;
    let keyConfigured: boolean | null = null;
    let environmentNames = [...profile.environment];
    let missingEnvironment: string[] = [];
    let commandPreview = [...profile.command];
    if (selected && !connection)
      issues.push({
        severity: 'error',
        code: 'TERMINAL_CONNECTION_MISSING',
        message: '所选 API 连接已删除，请重新选择',
      });
    if (connection) {
      keyConfigured = await this.keys.configured(this.keyConfig(connection));
      if (!keyConfigured)
        issues.push({
          severity: 'error',
          code: 'API_KEY_MISSING',
          message: '此连接未配置可用凭据，请保存 API Key 或配置环境变量',
        });
      try {
        const configuration = terminalConnectionConfiguration(
          profile,
          connection,
          'elysia-diagnostic-placeholder',
        );
        environmentNames = Object.keys(configuration.environment);
        commandPreview = configuration.command;
      } catch (error) {
        issues.push({
          severity: 'error',
          code: error instanceof AppError ? error.code : 'TERMINAL_CONNECTION_CONFIG',
          message: error instanceof AppError ? error.message : '无法生成终端配置，请检查模板命令与 API 连接',
        });
      }
    } else if (!selected) {
      for (const name of environmentNames)
        if (!(await this.keys.configured({ apiKeyEnv: name, credentialId: null } as ProviderConfig)))
          missingEnvironment.push(name);
      if (missingEnvironment.length)
        issues.push({
          severity: 'error',
          code: 'TERMINAL_ENVIRONMENT_MISSING',
          message: '模板所需环境变量尚未配置：' + missingEnvironment.join('、'),
        });
    }
    if (
      terminalSettings(this.store).revision !== settings.revision ||
      this.apps().revision !== apps.revision ||
      (body.projectId && this.preferences(body.projectId).revision !== preferences!.revision) ||
      (connection &&
        this.connections().find((entry) => entry.id === connection.id)?.revision !== connection.revision)
    )
      throw new AppError('TERMINAL_DIAGNOSTIC_STALE', '配置已更新，请重新读取诊断', false, null, 409);
    return TerminalProfileDiagnostics.parse({
      profileId: profile.id,
      profileLabel: profile.label,
      appId: profile.agent,
      image: profile.image,
      settingsRevision: settings.revision,
      appsRevision: apps.revision,
      projectId: body.projectId ?? null,
      projectRevision: preferences?.revision ?? null,
      source,
      connection,
      keyConfigured,
      environmentNames,
      missingEnvironment,
      commandPreview,
      issues,
      ready: !issues.some((issue) => issue.severity === 'error'),
    });
  }
  bindProfile(profile: AgentTerminalProfile, connectionId?: string | null): AgentTerminalProfile {
    const supplied = profile as AgentTerminalProfile & {
      connectionId?: string | null;
      connection?: TerminalConnectionBinding;
    };
    const selected =
      connectionId !== undefined
        ? connectionId
        : supplied.connectionId !== undefined
          ? supplied.connectionId
          : this.apps().entries.find((entry) => entry.id === terminalAppForProfile(profile))!.connectionId;
    // A client cannot supply its own frozen credential reference or endpoint.
    const { connection: _ignored, connectionId: _selection, ...clean } = supplied;
    if (!selected) return AgentTerminalProfile.parse(clean);
    const binding = this.connections().find((connection) => connection.id === selected);
    invariant(binding, 'TERMINAL_CONNECTION_MISSING', '所选 API 连接已删除，请在终端管理中重新选择');
    assertTerminalConnectionCompatible(profile, binding);
    return AgentTerminalProfile.parse({ ...clean, connectionId: selected, connection: binding });
  }
  private revision(expected: number, actual: number) {
    if (expected !== actual)
      throw new AppError(
        'REVISION_CONFLICT',
        '配置已更新，请刷新后重试',
        false,
        { currentRevision: actual },
        409,
      );
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private assertActiveSelections(connection: TerminalConnectionBinding) {
    for (const profile of terminalSettings(this.store).profiles) {
      if (profile.connectionId !== connection.id) continue;
      invariant(
        protocols[profile.agent].includes(connection.protocol),
        'TERMINAL_CONNECTION_PROTOCOL',
        `此连接正在被终端模板“${profile.label}”使用，请先更改模板连接`,
      );
    }
    for (const app of this.apps().entries.filter((entry) => entry.connectionId === connection.id))
      invariant(
        protocols[app.id].includes(connection.protocol),
        'TERMINAL_CONNECTION_PROTOCOL',
        '该连接正在被不兼容的 CLI 使用，请先更改应用连接',
      );
    for (const project of this.store.all<Project>('projects')) {
      const preferences = this.preferences(project.id);
      if (preferences.connectionId !== connection.id || !preferences.defaultProfileId) continue;
      const profile = terminalSettings(this.store).profiles.find(
        (entry) => entry.id === preferences.defaultProfileId,
      );
      if (profile) assertTerminalConnectionCompatible(profile, connection);
    }
  }
  saveConnection(connectionId: string, input: unknown, route: string) {
    const id = z.string().uuid().parse(connectionId);
    const body = TerminalConnectionWrite.parse(input);
    const { apiKey, ...nonsecret } = body;
    // Secrets never enter command results, database JSON or fingerprints as plaintext.
    const payload = {
      route,
      body: nonsecret,
      apiKeyDigest: apiKey === undefined ? null : createHash('sha256').update(apiKey).digest('hex'),
    };
    return this.serialize(async () => {
      if (this.store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
        return this.store.command<TerminalConnectionView>(body.commandId, payload, () => {
          throw new AppError('COMMAND_MISSING', '命令结果不存在');
        });
      const previous = this.connections().find((connection) => connection.id === id);
      invariant(
        previous || !this.read(deletedConnectionsKey, z.array(z.string().uuid()), () => []).includes(id),
        'TERMINAL_CONNECTION_DELETED',
        '此连接已删除，请使用新连接 ID',
      );
      this.revision(body.expectedRevision, previous?.revision ?? 0);
      invariant(
        previous || this.connections().length < 100,
        'TERMINAL_CONNECTION_LIMIT',
        '最多保存 100 个 API 连接',
      );
      const candidate = {
        id,
        revision: (previous?.revision ?? 0) + 1,
        name: body.connection.name,
        protocol: body.connection.protocol,
        baseUrl: body.connection.baseUrl,
        model: body.connection.model,
      };
      this.assertActiveSelections({
        ...candidate,
        auth: { kind: 'environment', env: body.connection.apiKeyEnv },
      });
      let auth: TerminalConnectionBinding['auth'];
      if (body.connection.credentialMode === 'environment') {
        auth = { kind: 'environment', env: body.connection.apiKeyEnv };
      } else if (apiKey !== undefined) {
        auth = { kind: 'vault', credentialRef: await this.keys.save(apiKey) };
      } else {
        invariant(previous?.auth.kind === 'vault', 'API_KEY_MISSING', '首次加密保存请填写 API Key');
        auth = previous.auth;
      }
      const next = TerminalConnectionBinding.parse({
        ...candidate,
        auth,
      });
      const response = await this.view(next);
      return this.store.command(body.commandId, payload, () => {
        const connections = this.connections();
        this.revision(
          body.expectedRevision,
          connections.find((connection) => connection.id === id)?.revision ?? 0,
        );
        // Existing app/project selections remain valid after a protocol edit.
        this.assertActiveSelections(next);
        this.write(connectionsKey, [...connections.filter((connection) => connection.id !== id), next]);
        return response;
      });
    });
  }
  deleteConnection(connectionId: string, input: unknown, route: string) {
    const id = z.string().uuid().parse(connectionId);
    const body = Command.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(input);
    return this.serialize(async () =>
      this.store.command(body.commandId, { route, id, body }, () => {
        const connections = this.connections();
        const previous = connections.find((connection) => connection.id === id);
        invariant(previous, 'TERMINAL_CONNECTION_MISSING', 'API 连接不存在');
        this.revision(body.expectedRevision, previous.revision);
        this.write(
          connectionsKey,
          connections.filter((connection) => connection.id !== id),
        );
        this.write(deletedConnectionsKey, [
          ...this.read(deletedConnectionsKey, z.array(z.string().uuid()), () => []),
          id,
        ]);
        const apps = this.apps();
        if (apps.entries.some((entry) => entry.connectionId === id))
          this.write(appsKey, {
            ...apps,
            revision: apps.revision + 1,
            entries: apps.entries.map((entry) =>
              entry.connectionId === id ? { ...entry, connectionId: null } : entry,
            ),
          });
        for (const project of this.store.all<Project>('projects')) {
          const preferences = this.preferences(project.id);
          if (preferences.connectionId === id)
            this.write(projectKey(project.id), {
              ...preferences,
              revision: preferences.revision + 1,
              connectionId: null,
            });
        }
        const settings = terminalSettings(this.store);
        if (settings.profiles.some((profile) => profile.connectionId === id || profile.connection?.id === id))
          writeTerminalSettings(this.store, {
            expectedRevision: settings.revision,
            defaultProfileId: settings.defaultProfileId,
            profiles: settings.profiles.map((profile) => {
              // Removing the override allows new tasks to inherit a surviving project/app connection.
              const { connectionId, connection, ...remaining } = profile;
              return {
                ...remaining,
                ...(connectionId !== undefined && connectionId !== id ? { connectionId } : {}),
                ...(connection && connection.id !== id ? { connection } : {}),
              };
            }),
          });
        // Old encrypted references are retained for already-created task snapshots.
        return { deleted: true, id };
      }),
    );
  }
  saveApps(input: unknown, route: string) {
    const body = Command.extend({
      expectedRevision: z.number().int().nonnegative(),
      defaultAppId: TerminalAppId,
      entries: TerminalControlApps.shape.entries,
    })
      .strict()
      .parse(input);
    const desired = TerminalControlApps.parse({
      revision: 0,
      defaultAppId: body.defaultAppId,
      entries: body.entries,
    });
    return this.serialize(async () =>
      this.store.command(body.commandId, { route, body }, () => {
        const previous = this.apps();
        this.revision(body.expectedRevision, previous.revision);
        for (const entry of desired.entries) {
          if (!entry.connectionId) continue;
          const connection = this.connections().find((connection) => connection.id === entry.connectionId);
          invariant(connection, 'TERMINAL_CONNECTION_MISSING', '所选 API 连接已删除，请刷新');
          invariant(
            protocols[entry.id].includes(connection.protocol),
            'TERMINAL_CONNECTION_PROTOCOL',
            `${entry.id} 与所选连接的 API 协议不兼容`,
          );
        }
        return writeTerminalControlApps(this.store, {
          expectedRevision: body.expectedRevision,
          defaultAppId: desired.defaultAppId,
          entries: desired.entries,
        });
      }),
    );
  }
  savePreferences(projectId: string, input: unknown, route: string) {
    const body = Command.extend({
      expectedRevision: z.number().int().nonnegative(),
      defaultProfileId: TerminalProjectPreferences.shape.defaultProfileId,
      connectionId: TerminalProjectPreferences.shape.connectionId,
    })
      .strict()
      .parse(input);
    return this.serialize(async () =>
      this.store.command(body.commandId, { route, projectId, body }, () => {
        const project = this.store.require<Project>('projects', projectId);
        invariant(!project.archived, 'PROJECT_ARCHIVED', '请先恢复已归档的项目');
        const previous = this.preferences(projectId);
        this.revision(body.expectedRevision, previous.revision);
        const profile = body.defaultProfileId
          ? terminalSettings(this.store).profiles.find((entry) => entry.id === body.defaultProfileId)
          : undefined;
        invariant(
          !body.defaultProfileId || profile,
          'TERMINAL_PROFILE_MISSING',
          '所选终端模板不存在，请刷新',
        );
        if (body.connectionId) {
          const connection = this.connections().find((entry) => entry.id === body.connectionId);
          invariant(connection, 'TERMINAL_CONNECTION_MISSING', '所选 API 连接已删除，请刷新');
          if (profile) assertTerminalConnectionCompatible(profile, connection);
        }
        const saved = TerminalProjectPreferences.parse({
          revision: previous.revision + 1,
          defaultProfileId: body.defaultProfileId,
          connectionId: body.connectionId,
        });
        this.write(projectKey(projectId), saved);
        return saved;
      }),
    );
  }
}
export function registerTerminalControl(app: FastifyInstance, control: TerminalControlService) {
  const root = '/api/terminal/control';
  app.get(root, () => control.overview());
  app.put<{ Params: { id: string } }>(root + '/connections/:id', (request) =>
    control.saveConnection(request.params.id, request.body, request.url),
  );
  app.delete<{ Params: { id: string } }>(root + '/connections/:id', (request) =>
    control.deleteConnection(request.params.id, request.body, request.url),
  );
  const probe = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    operation: 'check' | 'models',
  ) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', close);
    try {
      return await control.probe(request.params.id, request.body, operation, controller.signal);
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', close);
    }
  };
  app.post<{ Params: { id: string } }>(root + '/connections/:id/check', (request, reply) =>
    probe(request, reply, 'check'),
  );
  app.post<{ Params: { id: string } }>(root + '/connections/:id/models', (request, reply) =>
    probe(request, reply, 'models'),
  );
  app.post<{ Params: { id: string } }>(root + '/profiles/:id/diagnostics', (request) =>
    control.diagnostics(request.params.id, request.body ?? {}),
  );
  app.put(root + '/apps', (request) => control.saveApps(request.body, request.url));
  app.get<{ Params: { id: string } }>(root + '/projects/:id/preferences', (request) =>
    control.preferences(request.params.id),
  );
  app.put<{ Params: { id: string } }>(root + '/projects/:id/preferences', (request) =>
    control.savePreferences(request.params.id, request.body, request.url),
  );
  app.addHook('onClose', () => {
    control.close();
  });
}
