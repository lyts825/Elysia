/**
 * 管理终端控制服务及相关接口。
 * 持有终端独立凭据和配置，串行协调保险库/数据库并冻结实际绑定；迟到探测重查版本，公开视图不含密钥，原生账号不参与。
 * EN: Manages terminal connection control and related routes. Owns isolated terminal credentials/settings with serialized vault/database writes and frozen bindings; late probes recheck revisions and views expose no secrets/native accounts.
 */
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
  TerminalConnectionHealth,
  TerminalConnectionHealthResult,
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
/**
 * 生成终端连接健康元数据键，与原生服务商配置分离。
 * EN: Builds terminal connection-health metadata keys separate from native provider settings.
 */
const healthKey = (id: string) => `surface:terminal:control:health:${id}`;
const deletedConnectionsKey = 'surface:terminal:control:deleted-connections:v1';
const appsKey = 'surface:terminal:control:apps:v1';
/**
 * 生成项目的终端偏好键，不影响原生项目模型路由。
 * EN: Builds project terminal-preference keys independent of native model routing.
 */
const projectKey = (projectId: string) => `surface:terminal:control:project:${projectId}`;
/**
 * 使调用方可取消等待一个已有承诺，并在结算时移除监听；不会凭此终止底层工作，底层须有自己的取消机制。
 * EN: Makes waiting for an existing promise cancellable and cleans listeners on settlement; underlying work needs its own cancellation mechanism.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    /**
     * 用信号的原始 reason 拒绝当前等待，不包装或吞掉取消原因。
     * EN: Rejects this wait with the signal's original reason.
     */
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    /**
     * 移除本次等待的取消监听，防止已结束承诺继续保留闭包。
     * EN: Removes this wait's cancellation listener after settlement.
     */
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
/**
 * 复用 ProviderKeys 加密，但所有保险库操作均指向终端独立保险库。 构造仅访问终端独立密钥库的凭据服务。
 * EN: ProviderKeys encryption is reused, but every vault operation targets the terminal vault. Builds a credential service restricted to the terminal vault.
 */
export function terminalProviderKeys(desktop?: DesktopServices): ProviderKeys {
  return new ProviderKeys(
    desktop && {
      /**
       * 只接受通用密钥库读写操作并改写到终端独立保险库；其他桌面能力直接拒绝。
       * EN: Accepts only generic key-vault read/write operations and maps them to the terminal vault, rejecting other desktop capabilities.
       */
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
/**
 * 管理终端连接、配置、凭据探测及项目偏好，探测关闭时可取消。
 * EN: Manages terminal connections, settings, credential probes and project preferences; probes can be cancelled on close.
 */
export class TerminalControlService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly keys: ProviderKeys;
  private readonly probes = new Map<string, AbortController>();
  private closed = false;
  /**
   * 绑定终端存储、探测能力和独立凭据保险库；不实例化原生账号服务。
   * EN: Binds terminal storage/probe options and isolated credential vault without native account services.
   */
  constructor(
    private readonly store: Store,
    desktop?: DesktopServices,
    private readonly probeOptions: TerminalConnectionProbeOptions = {},
  ) {
    this.keys = terminalProviderKeys(desktop);
  }
  /**
   * 按指定 schema 读取一条终端元数据，缺失调用新默认值工厂，损坏则抛错而非覆盖。
   * EN: Reads terminal metadata through its schema, using a fresh fallback only when absent and throwing on damage rather than overwriting it.
   */
  private read<T>(key: string, schema: z.ZodType<T>, fallback: () => T): T {
    const row = this.store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(key) as
      | { value: string }
      | undefined;
    return row ? schema.parse(JSON.parse(row.value)) : fallback();
  }
  /**
   * 稳定序列化并 upsert 一条终端元数据，事务由调用方管理。
   * EN: Stable-serializes and upserts terminal metadata under caller-owned transactions.
   */
  private write(key: string, value: unknown) {
    this.store.db
      .prepare(
        'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, stable(value));
  }
  /**
   * 读取并校验最多 100 个终端连接绑定，缺省返回独立空数组。
   * EN: Reads/validates at most 100 terminal bindings, defaulting to a fresh empty array.
   */
  connections() {
    return this.read(connectionsKey, z.array(TerminalConnectionBinding).max(100), () => []);
  }
  /**
   * 返回兼容规范化的终端应用选择视图，不持久化兼容修正。
   * EN: Returns normalized compatibility app selections without persisting compatibility repairs.
   */
  apps(): TerminalControlApps {
    return terminalControlApps(this.store);
  }
  /**
   * 先确认项目存在，再读取终端偏好；未保存时返回零版本环境继承配置。
   * EN: Requires the project then reads terminal preferences, defaulting to revision-zero inherited/environment choices.
   */
  preferences(projectId: string): TerminalProjectPreferences {
    this.store.require<Project>('projects', projectId);
    return this.read(projectKey(projectId), TerminalProjectPreferences, () => ({
      revision: 0,
      defaultProfileId: null,
      connectionId: null,
    }));
  }
  /**
   * 删除指定项目的终端偏好元数据，供项目删除收尾；不删除连接或凭据。
   * EN: Removes project terminal preferences during deletion cleanup without deleting connections or secrets.
   */
  removeProjectPreferences(projectId: string) {
    this.store.db.prepare('DELETE FROM storage_meta WHERE key=?').run(projectKey(projectId));
  }
  /**
   * 给冻结连接附加密钥是否配置、凭据来源及健康摘要；不返回明文密钥。
   * EN: Adds configured-key state, credential source and health to a binding without exposing plaintext secrets.
   */
  private async view(connection: TerminalConnectionBinding): Promise<TerminalConnectionView> {
    return {
      ...connection,
      keyConfigured: await this.keys.configured(this.keyConfig(connection)),
      credentialSource: connection.auth.kind,
      health: this.connectionHealth(connection),
    };
  }
  /**
   * 并行组装目录、应用和保存连接的公开状态，不主动发在线探测请求。
   * EN: Assembles public catalog/apps/connection states in parallel without initiating online probes.
   */
  async overview(): Promise<TerminalControlOverview> {
    return {
      catalog: terminalAppCatalog(),
      apps: this.apps(),
      connections: await Promise.all(this.connections().map((connection) => this.view(connection))),
    };
  }
  /**
   * 把终端 auth 形态转换成 ProviderKeys 所需的两个引用字段，仅适配接口，不查原生服务商记录。
   * EN: Adapts terminal auth to the two reference fields ProviderKeys needs without consulting native providers.
   */
  private keyConfig(connection: TerminalConnectionBinding): ProviderConfig {
    /**
     * ProviderKeys 仅读取这两个字段，从不查询原生服务商记录。
     * EN: ProviderKeys reads only these two fields. Native provider records are never consulted.
     */
    return {
      credentialId: connection.auth.kind === 'vault' ? connection.auth.credentialRef : null,
      apiKeyEnv: connection.auth.kind === 'environment' ? connection.auth.env : 'ELYSIA_TERMINAL_API_KEY',
    } as ProviderConfig;
  }
  /**
   * 只按冻结 binding 的环境变量/密钥库引用取值，当前连接列表变化不改写旧任务凭据身份。
   * EN: Resolves credentials solely from the frozen binding's environment/vault reference; edits to current connection lists never change old run identity.
   */
  async credential(binding: TerminalConnectionBinding): Promise<string> {
    const connection = TerminalConnectionBinding.parse(binding);
    return (await this.keys.credential(this.keyConfig(connection))).token;
  }
  /**
   * 读取保存健康记录并将外层身份/版本对齐当前绑定；各项探测记录仍保留自身受检版本，不能以此改写为已验证。
   * EN: Reads saved health and aligns outer identity/revision with the binding; individual probe observations retain tested revisions rather than becoming newly verified.
   */
  private connectionHealth(binding: TerminalConnectionBinding): TerminalConnectionHealth {
    const recorded = this.read(healthKey(binding.id), TerminalConnectionHealth, () => ({
      connectionId: binding.id,
      revision: binding.revision,
    }));
    return TerminalConnectionHealth.parse({
      ...recorded,
      connectionId: binding.id,
      revision: binding.revision,
    });
  }
  /**
   * 校验连接 ID 并返回其当前健康视图；连接已删除时拒绝读取旧记录。
   * EN: Validates connection ID and returns current health, rejecting deleted bindings rather than serving orphaned history.
   */
  health(connectionId: string) {
    const id = z.string().uuid().parse(connectionId),
      binding = this.connections().find((entry) => entry.id === id);
    invariant(binding, 'TERMINAL_CONNECTION_MISSING', '所选 API 连接已删除，请刷新');
    return this.connectionHealth(binding);
  }
  /**
   * 每连接最多一个在线检测，联合调用方取消、服务关闭和超时信号。 检测结果绑定发起时 revision；配置变化后拒绝写健康状态，避免迟到响应验证新配置。 check 与 models 分别存储安全摘要，不将远端正文或凭据写入健康记录。
   * EN: Allows one online probe per connection and combines caller, shutdown and timeout cancellation. Results bind the initiating revision and cannot validate edited configuration. Check/models store separate safe summaries without remote bodies or secrets.
   */
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
      const result = TerminalConnectionProbeResult.parse({
        ...outcome,
        connectionId: id,
        revision: binding.revision,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.max(0, Date.now() - started),
      });
      if (!caller?.aborted && !this.closed && result.code !== 'TERMINAL_API_CANCELLED') {
        const { models, resolvedModel: _ignored, ...summary } = result;
        const safe = TerminalConnectionHealthResult.parse({
          ...summary,
          ...(models ? { modelCount: models.length } : {}),
        });
        /**
         * 读取、复核和写入同步执行；迟到响应不能核验更新后的绑定。
         * EN: Read/recheck/write is synchronous. A late response can never validate a newer binding.
         */
        this.store.tx(() => {
          const latest = this.connections().find((entry) => entry.id === id);
          if (!latest || latest.revision !== binding.revision)
            throw new AppError('TERMINAL_CONNECTION_STALE', '连接已修改，请重新验证', false, null, 409);
          this.write(healthKey(id), { ...this.connectionHealth(latest), [operation]: safe });
        });
      }
      return result;
    } finally {
      this.probes.delete(id);
    }
  }
  /**
   * 关闭探测入口并取消所有活动控制器，迟到探测由后续版本/关闭检查拒绝写入。
   * EN: Closes probe admission and aborts controllers; later lifecycle/revision checks reject late writes.
   */
  close() {
    this.closed = true;
    for (const controller of this.probes.values()) controller.abort();
  }
  /**
   * 汇总模板→项目→应用→环境的连接选择与缺失配置，只用占位凭据生成命令预览。 异步密钥检查后重新核对全部参与配置版本；该本地诊断不发模型请求，也不证明真实认证成功。
   * EN: Explains template/project/app/environment connection selection using placeholder keys only. Rechecks all configuration revisions after asynchronous key lookup; local diagnosis sends no model request and proves no authentication.
   */
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
  /**
   * 根据显式选择或应用配置冻结连接。丢弃客户端自带 connection 内容，只从宿主保存的 连接表复制兼容绑定；null 显式选择环境变量模式，undefined 才允许应用默认选择。
   * EN: Freezes a saved compatible connection from explicit choice or app defaults; ignores client-supplied connection bodies. Null selects environment mode, while undefined allows app defaults.
   */
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
    /**
     * 客户端不能自行提供冻结凭据引用或端点。
     * EN: A client cannot supply its own frozen credential reference or endpoint.
     */
    const { connection: _ignored, connectionId: _selection, ...clean } = supplied;
    if (!selected) return AgentTerminalProfile.parse(clean);
    const binding = this.connections().find((connection) => connection.id === selected);
    invariant(binding, 'TERMINAL_CONNECTION_MISSING', '所选 API 连接已删除，请在终端管理中重新选择');
    assertTerminalConnectionCompatible(profile, binding);
    return AgentTerminalProfile.parse({ ...clean, connectionId: selected, connection: binding });
  }
  /**
   * 比较配置预期版本，冲突返回当前版本的 409，避免跨窗口覆盖。
   * EN: Checks expected configuration revision and returns 409/current revision to prevent multi-window overwrite.
   */
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
  /**
   * 串行处理跨密钥库和数据库的修改；失败只影响该次请求，队列后续动作仍可执行。
   * EN: Serializes vault/database mutations; a failed request does not block later queued work.
   */
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  /**
   * 连接协议变化前核验全部引用模板、应用和项目默认仍兼容；任一不兼容阻止保存，避免破坏现有选择。
   * EN: Before protocol edits, verifies every selecting template/app/project default remains compatible, blocking edits that break existing choices.
   */
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
  /**
   * 串行保存连接；命令记录使用密钥摘要，避免明文进入数据库记录。
   * EN: Saves connections serially and hashes secrets for command records instead of persisting plaintext.
   */
  saveConnection(connectionId: string, input: unknown, route: string) {
    const id = z.string().uuid().parse(connectionId);
    const body = TerminalConnectionWrite.parse(input);
    const { apiKey, ...nonsecret } = body;
    /**
     * 密钥不得以明文进入命令结果、数据库 JSON 或指纹。
     * EN: Secrets never enter command results, database JSON or fingerprints as plaintext.
     */
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
        /**
         * 编辑协议后，已有应用和项目选择仍需保持有效。
         * EN: Existing app/project selections remain valid after a protocol edit.
         */
        this.assertActiveSelections(next);
        this.write(connectionsKey, [...connections.filter((connection) => connection.id !== id), next]);
        return response;
      });
    });
  }
  /**
   * 按预期版本及命令 ID 删除连接，并校验当前配置。
   * EN: Deletes a connection under expected revision and command ID after validating current configuration.
   */
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
        this.store.db.prepare('DELETE FROM storage_meta WHERE key=?').run(healthKey(id));
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
              /**
               * 移除覆盖项后，新任务可继承仍有效的项目或应用连接。
               * EN: Removing the override allows new tasks to inherit a surviving project/app connection.
               */
              const { connectionId, connection, ...remaining } = profile;
              return {
                ...remaining,
                ...(connectionId !== undefined && connectionId !== id ? { connectionId } : {}),
                ...(connection && connection.id !== id ? { connection } : {}),
              };
            }),
          });
        /**
         * 旧加密引用为已有任务快照保留。
         * EN: Old encrypted references are retained for already-created task snapshots.
         */
        return { deleted: true, id };
      }),
    );
  }
  /**
   * 严格校验应用选择后串行执行幂等事务，核对版本及连接存在/协议，再与模板设置同步保存。
   * EN: Validates app choices then serially runs an idempotent transaction checking revision, connection presence/protocol and synchronized template settings.
   */
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
  /**
   * 按项目版本保存默认模板与连接偏好。
   * EN: Saves project default template and connection preferences under project revision.
   */
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
/**
 * 注册终端连接、探测、应用及项目偏好接口；在线探测绑定请求取消，服务关闭时取消探测。
 * EN: Registers terminal connections/probes/apps/project preferences, binding probe cancellation to HTTP requests and service shutdown.
 */
export function registerTerminalControl(app: FastifyInstance, control: TerminalControlService) {
  const root = '/api/terminal/control';
  app.get(root, () => control.overview());
  app.put<{ Params: { id: string } }>(root + '/connections/:id', (request) =>
    control.saveConnection(request.params.id, request.body, request.url),
  );
  app.delete<{ Params: { id: string } }>(root + '/connections/:id', (request) =>
    control.deleteConnection(request.params.id, request.body, request.url),
  );
  /**
   * 为 check/models HTTP 调用安装取消与提前关闭监听，将信号交给控制服务，并在 finally 移除监听。
   * EN: Installs abort/premature-close listeners for check/models HTTP calls, forwards the signal and always detaches in finally.
   */
  const probe = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    operation: 'check' | 'models',
  ) => {
    const controller = new AbortController();
    /**
     * 中止当前 HTTP 触发的连接探测。
     * EN: Aborts this HTTP-triggered connection probe.
     */
    const abort = () => controller.abort();
    /**
     * 只有响应未正常结束时才因连接关闭取消探测。
     * EN: Cancels on connection closure only before normal response completion.
     */
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
  app.get<{ Params: { id: string } }>(root + '/connections/:id/health', (request) =>
    control.health(request.params.id),
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
