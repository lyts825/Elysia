import Fastify, { type FastifyRequest, type FastifyReply, type FastifyInstance } from 'fastify';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AppError,
  Command,
  Contract,
  Limits,
  Budget,
  Permissions,
  ProviderConfig,
  ModelChoice,
  ContextPolicy,
  ExecutionBinding,
  AgentTerminalProfile,
  VERSION,
  invariant,
  type Run,
  type Task,
  type Project,
  type Agent,
  type Message,
  type Operation,
  type Artifact,
  type RequestRecord,
  type Attempt,
  type ContextSnapshot,
} from '../../../packages/contracts/src/index.js';
import { Store, id, now, stable } from '../../../packages/storage/src/index.js';
import { Kernel } from '../../../packages/kernel/src/index.js';
import { NativeExecutor } from '../../../packages/runtime/src/index.js';
import { DockerAgentService } from '../../../packages/runtime/src/docker-agent.js';
import { terminalBinding } from './terminal-binding.js';
import { NativeProvider, providerBaseUrl } from '../../../packages/providers/src/index.js';
import { PreviewService } from './preview.js';
import { SubscriptionService } from './subscription.js';
import { desktopServices, type DesktopServices } from './desktop.js';
import {
  inspectFolder,
  projectFiles,
  projectResource,
  projectTextEncodings,
  sameDirectory,
} from './projects.js';
import { TEXT_PAGE_BYTES } from '../../../packages/contracts/src/files.js';
import type { FileResource } from './file-reader.js';
import { ArtifactPreviewService } from './artifact-preview.js';
import { CodexSubscription } from './codex-subscription.js';
import { ProviderKeys } from './provider-keys.js';
import { registerManagement } from './management.js';
import { registerWorkbench, workbenchScope } from './workbench.js';
import { BoundedEventStream, eventFrame } from './event-stream.js';
import { availableModels, resolveModelChoice } from './model-choice.js';
import { apiModels, officialDeepSeek } from './api-model-catalog.js';
import { createSurfaceAuth, type SurfaceAuth, type WorkbenchSurface } from './surfaces.js';
import { registerTerminalSettings, terminalSettings } from './terminal-settings.js';
import { registerTerminalLogSearchRoutes } from './terminal-log-search.js';
import { TerminalControlService, registerTerminalControl, terminalAppCatalog } from './terminal-control.js';
import { registerCliManagement } from './cli-management.js';
import { RunReads, registerRunRecordRoutes } from './run-reads.js';
import { registerTaskCenter } from './task-center.js';
import { registerContextPreview } from './context-preview.js';
import { registerLocalAgentRoutes } from './local-agents.js';
import { registerPreviewLocationRoutes } from './preview-location.js';
import { registerTerminalMaintenance } from './terminal-maintenance.js';
import { RunSourceSelection, RunDeliveryItems } from '../../../packages/contracts/src/workflow.js';
import { attachRunSource, captureRunSource, registerWorkflow } from './workflow.js';
const textPageQuery = z.object({
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(TEXT_PAGE_BYTES).optional(),
  version: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  encoding: z.enum(projectTextEncodings).default('auto'),
});
function fileRequestSignal(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once('aborted', abort);
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) abort();
    request.raw.removeListener('aborted', abort);
  });
  return controller.signal;
}
function sendFileResource(reply: FastifyReply, resource: FileResource) {
  reply
    .code(resource.status)
    .type(resource.mediaType)
    .header('Cache-Control', 'no-store')
    .header('ETag', '"' + resource.version + '"');
  if (resource.acceptRanges) reply.header('Accept-Ranges', 'bytes');
  if (resource.contentRange) reply.header('Content-Range', resource.contentRange);
  if (resource.contentLength !== undefined) reply.header('Content-Length', resource.contentLength);
  return reply.send(resource.stream);
}
const restrictedResourcePolicy =
  "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
export function defaultProviders(): ProviderConfig[] {
  return [
    {
      id: 'openai',
      kind: 'openai',
      label: 'OpenAI',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      account: 'openai-default',
      contextLimit: 32000,
      outputLimit: 4096,
      concurrency: 2,
      rpm: 60,
      tpm: 200000,
      cache: { mode: 'unknown', minTokens: null, ttl: null, parameters: {} },
      prices: null,
      revision: 0,
      checkedRevision: null,
    },
    {
      id: 'deepseek',
      kind: 'deepseek',
      label: 'DeepSeek',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      account: 'deepseek-default',
      contextLimit: 1048576,
      outputLimit: 8192,
      concurrency: 2,
      rpm: 60,
      tpm: 200000,
      cache: { mode: 'automatic', minTokens: null, ttl: null, parameters: {} },
      prices: null,
      revision: 0,
      checkedRevision: null,
    },
  ];
}
export function createServer(
  store: Store,
  options: {
    port: number;
    dev?: boolean;
    subscription?: SubscriptionService;
    codex?: CodexSubscription;
    keys?: ProviderKeys;
    terminal?: ConstructorParameters<typeof DockerAgentService>[2];
    terminalDesktop?: DesktopServices;
    app?: FastifyInstance;
    prefix?: '' | '/terminal';
    surface?: WorkbenchSurface;
    auth?: SurfaceAuth;
    serveWeb?: boolean;
  },
) {
  const app = options.app ?? Fastify({ logger: false, bodyLimit: 3 * 1024 * 1024 });
  const prefix = options.prefix ?? '';
  const localUrl = (url: string) =>
    prefix
      ? url.startsWith(prefix + '/')
        ? url.slice(prefix.length)
        : null
      : url.startsWith('/terminal/')
        ? null
        : url;
  const kernel = new Kernel(store),
    executor = new NativeExecutor(kernel);
  executor.acceptRun = (run) =>
    options.surface === 'native'
      ? run.execution?.kind !== 'docker-agent'
      : options.surface === 'terminal'
        ? run.execution?.kind === 'docker-agent'
        : true;
  const terminalControl =
    options.surface === 'terminal'
      ? new TerminalControlService(store, options.terminalDesktop ?? desktopServices())
      : undefined;
  const terminal = new DockerAgentService(kernel, executor.gateway, {
    ...options.terminal,
    ...(terminalControl ? { resolveConnection: (binding) => terminalControl.credential(binding) } : {}),
  });
  const boundTerminalProfile = (profile: AgentTerminalProfile, projectId?: string | null) => {
    if (!terminalControl) return profile;
    if (profile.connectionId === undefined && projectId) {
      const selected = terminalControl.preferences(projectId).connectionId;
      const connection = terminalControl.connections().find((entry) => entry.id === selected);
      if (
        connection &&
        terminalAppCatalog()
          .find((entry) => entry.id === profile.agent)
          ?.protocols.includes(connection.protocol)
      )
        return terminalControl.bindProfile(profile, connection.id);
    }
    return terminalControl.bindProfile(profile);
  };
  executor.terminalRunner = (task, signal) => terminal.run(task, signal);
  executor.terminalInterrupt = (runId, taskId) => terminal.interrupt(runId, taskId);
  executor.terminalDispose = () => terminal.dispose();
  executor.terminalResources = terminal.resources;
  executor.terminalCapacityRefresh = (signal) => terminal.refreshResourceCapacity(signal);
  const nativeService = <T extends object>(factory: () => T): T =>
    options.surface === 'terminal'
      ? new Proxy({} as T, {
          get() {
            throw new AppError('SURFACE_EXECUTION', 'Agent 终端入口不访问原生模型和账号');
          },
        })
      : factory();
  const subscription = nativeService(
    () => options.subscription ?? new SubscriptionService(desktopServices()),
  );
  const codex = nativeService(
    () => options.codex ?? new CodexSubscription(store.directory, desktopServices()),
  );
  const keys = nativeService(() => options.keys ?? new ProviderKeys(desktopServices()));
  const apiCatalog = (provider: ProviderConfig) => apiModels(provider, keys);
  const providerAdapter = (provider: ProviderConfig) =>
    provider.authMode === 'codex'
      ? codex.adapter(provider)
      : new NativeProvider(
          provider,
          provider.authMode === 'chatgpt'
            ? () => subscription.credential(provider.subscriptionAccountId!)
            : provider.credentialId
              ? () => keys.credential(provider)
              : undefined,
        );
  executor.adapterFactory = (agent) => {
    invariant(options.surface !== 'terminal', 'SURFACE_EXECUTION', 'Agent 终端入口不调用原生模型');
    return providerAdapter(agent.providerBinding);
  };
  if (options.surface !== 'terminal')
    for (const config of defaultProviders())
      if (!store.get('providers', config.id)) store.put('providers', config);
  const selectionScope = randomBytes(16).toString('hex');
  const stableWorkbenchScope = workbenchScope(store);
  const auth = options.auth ?? createSurfaceAuth(options.port, options.dev);
  const { bootstrapToken, sessions, origins, hosts } = auth;
  const previews = new PreviewService(store, executor.gateway, prefix);
  const artifactPreviews = new ArtifactPreviewService(store, prefix);
  app.addHook('onClose', async () => {
    await artifactPreviews.close();
  });
  const cookieSession = (header?: string) =>
    header
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('elysia_session='))
      ?.slice(15);
  app.addHook('onRequest', async (request, reply) => {
    const address = app.server.address();
    if (address && typeof address !== 'string') {
      hosts.delete(`127.0.0.1:${options.port}`);
      origins.delete(`http://127.0.0.1:${options.port}`);
      hosts.add(`127.0.0.1:${address.port}`);
      origins.add(`http://127.0.0.1:${address.port}`);
    }
    invariant(hosts.has(request.headers.host ?? ''), 'HOST_DENIED', 'Host 不允许');
    const url = localUrl(request.url);
    if (url === null) return;
    // Capability-scoped sandbox frames have opaque origins and no app session.
    if (url.startsWith('/preview/')) return;
    const origin = request.headers.origin;
    if (origin) invariant(origins.has(origin), 'ORIGIN_DENIED', 'Origin 不允许');
    const pathname = url.split('?')[0];
    if (!pathname.startsWith('/api/')) return;
    if (pathname === '/api/health') return;
    if (pathname === '/api/session' && request.method === 'POST') {
      invariant(origin && origins.has(origin), 'ORIGIN_REQUIRED', '引导会话需要本机 Origin');
      return;
    }
    const token = cookieSession(request.headers.cookie);
    invariant(token && sessions.has(token), 'SESSION_REQUIRED', '请使用启动终端的引导链接打开工作台');
    if (!['GET', 'HEAD'].includes(request.method)) {
      invariant(origin && origins.has(origin), 'ORIGIN_REQUIRED', '修改请求必须有本机 Origin');
      const csrf = request.headers['x-elysia-csrf'];
      invariant(typeof csrf === 'string' && csrf === sessions.get(token), 'CSRF_DENIED', '修改凭据无效');
    }
    reply.header('Cache-Control', 'no-store');
    if (
      (options.surface === 'terminal' &&
        (/^\/api\/(?:providers|subscription|codex)(?:\/|$)/.test(pathname) ||
          /^\/api\/runs\/[^/]+\/context$/.test(pathname))) ||
      (options.surface === 'native' && /^\/api\/terminal(?:\/|$)/.test(pathname))
    )
      throw new AppError('NOT_FOUND', '当前入口不提供此接口', false, null, 404);
    if (options.surface === 'native' && !['GET', 'HEAD'].includes(request.method)) {
      const match = /^\/api\/runs\/([^/]+)(?:\/|$)/.exec(pathname);
      const run = match ? store.get<Run>('runs', decodeURIComponent(match[1])) : undefined;
      if (run?.execution?.kind === 'docker-agent')
        throw new AppError(
          'LEGACY_TERMINAL_READ_ONLY',
          '旧版终端任务已保留为只读历史；请切换到 Agent 终端入口创建独立任务',
          false,
          null,
          409,
        );
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    const url = localUrl(_request.url);
    if (url === null) return payload;
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        requestPreviewPolicy(url, reply.getHeader('Content-Security-Policy')) ??
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'",
      );
    return payload;
  });
  app.addHook('preHandler', async (request) => {
    if (options.surface !== 'native' || ['GET', 'HEAD'].includes(request.method)) return;
    const url = localUrl(request.url);
    const match = url ? /^\/api\/projects\/([^/?]+)(?:\?|$)/.exec(url) : null;
    if (!match || (request.method !== 'DELETE' && (request.body as any)?.archived !== true)) return;
    if (
      store
        .all<Run>('runs')
        .some(
          (run) => run.projectId === decodeURIComponent(match[1]) && run.execution?.kind === 'docker-agent',
        )
    )
      throw new AppError(
        'LEGACY_TERMINAL_READ_ONLY',
        '此项目包含保留的旧版终端历史，当前入口不能删除或归档；请保留历史并在 Agent 终端入口新建项目',
        false,
        null,
        409,
      );
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as any;
    const code =
      e instanceof AppError ? e.code : e instanceof z.ZodError ? 'VALIDATION_ERROR' : 'SERVER_ERROR';
    const rangeDetails =
      e instanceof AppError && e.details && typeof e.details === 'object'
        ? (e.details as { totalBytes?: number })
        : null;
    if (e instanceof AppError && e.httpStatus === 416 && Number.isSafeInteger(rangeDetails?.totalBytes))
      reply.header('Content-Range', `bytes */${rangeDetails!.totalBytes}`);
    reply
      .code(e instanceof AppError ? e.httpStatus : e instanceof z.ZodError ? 400 : (e.statusCode ?? 500))
      .send({
        code,
        message:
          e instanceof z.ZodError
            ? e.issues.map((i: any) => i.path.join('.') + ': ' + i.message).join('; ')
            : e.message,
        retryable: e instanceof AppError && e.retryable,
        details: e instanceof AppError ? e.details : null,
      });
  });
  if (options.surface !== 'terminal') registerLocalAgentRoutes(app, store, executor.gateway, prefix);
  const command = <T>(body: unknown, route: string, fn: (b: any) => T) => {
    const b = Command.parse(body);
    return store.command(b.commandId, { route, body }, () => fn(body));
  };
  const revision = (body: any, entity: { revision: number }) => {
    invariant(Number.isInteger(body.expectedRevision), 'REVISION_REQUIRED', '需要 expectedRevision');
    if (body.expectedRevision !== entity.revision)
      throw new AppError(
        'REVISION_CONFLICT',
        '记录已更新，请刷新后重试',
        false,
        { currentRevision: entity.revision },
        409,
      );
  };
  const contextBoundaries = (snapshot: ContextSnapshot): ContextSnapshot => ({
    ...snapshot,
    agents: snapshot.agents.map((context) =>
      executorHasActive(executor, snapshot.runId, context.taskId)
        ? { ...context, safeToConfigure: false, configureReason: '请先暂停代理并等待当前请求和操作结束' }
        : context,
    ),
  });
  app.get('/api/health', async () => ({
    version: VERSION,
    status: 'ok',
    surface: options.surface ?? 'native',
  }));
  registerWorkbench(app, store);
  registerTerminalLogSearchRoutes(app, store, artifactPreviews);
  if (options.surface !== 'native') registerTerminalSettings(app, store);
  if (terminalControl) {
    registerTerminalControl(app, terminalControl);
    registerCliManagement(app, store, terminal.cliManager);
    registerTerminalMaintenance(app, store, {
      snapshot: terminal.maintenanceSnapshot.bind(terminal),
      guard: terminal.withMaintenanceGuard.bind(terminal),
      isActive: (runId) =>
        executor.runtimeSnapshot(runId).activeTaskIds.length > 0 || terminal.hasActive(runId),
    });
    app.get('/api/terminal/capabilities', () => terminal.capabilities());
    app.get('/api/terminal/runtime', (request) => {
      const query = z.object({ runId: z.string().uuid().optional() }).strict().parse(request.query);
      if (query.runId) store.require<Run>('runs', query.runId);
      return {
        executor: executor.runtimeSnapshot(query.runId),
        terminal: terminal.runtimeSnapshot(query.runId),
      };
    });
  }
  app.get<{ Params: { runId: string; taskId: string }; Querystring: { path?: string } }>(
    '/api/runs/:runId/tasks/:taskId/preview',
    async (request) =>
      previews.snapshot(
        request.params.runId,
        request.params.taskId,
        z.string().min(1).max(1000).optional().parse(request.query.path),
      ),
  );
  app.get<{
    Params: { runId: string; taskId: string };
    Querystring: { path: string; offset?: string; limit?: string; version?: string; encoding?: string };
  }>('/api/runs/:runId/tasks/:taskId/preview/file', async (request, reply) => {
    const { encoding, ...page } = textPageQuery.parse(request.query);
    return previews.file(
      request.params.runId,
      request.params.taskId,
      z.string().min(1).max(1000).parse(request.query.path),
      encoding,
      { ...page, signal: fileRequestSignal(request, reply) },
    );
  });
  app.get<{ Params: { token: string; '*': string } }>('/preview/:token/*', async (request, reply) => {
    const base = `http://${request.headers.host}${prefix}/preview/${encodeURIComponent(request.params.token)}/`;
    reply
      .header('Cache-Control', 'no-store')
      .header('Access-Control-Allow-Origin', '*')
      .header(
        'Content-Security-Policy',
        `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${base}; style-src 'unsafe-inline' ${base}; img-src data: ${base}; font-src ${base}; media-src ${base}; connect-src ${base}; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri ${base}; frame-ancestors 'self'`,
      );
    const result = await previews.resource(
      request.params.token,
      request.params['*'],
      ['iframe', 'document'].includes(String(request.headers['sec-fetch-dest'] || '')),
      {
        range: request.headers.range,
        version: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional()
          .parse((request.query as { version?: string }).version),
        signal: fileRequestSignal(request, reply),
      },
    );
    return sendFileResource(reply, result);
  });
  app.post('/api/session', async (request, reply) => {
    const body = z.object({ token: z.string() }).parse(request.body);
    const a = Buffer.from(body.token),
      b = Buffer.from(bootstrapToken);
    invariant(
      !auth.bootstrapUsed &&
        Date.now() < auth.bootstrapExpires &&
        a.length === b.length &&
        timingSafeEqual(a, b),
      'BOOTSTRAP_EXPIRED',
      '引导令牌无效、过期或已使用',
    );
    auth.bootstrapUsed = true;
    const session = randomBytes(32).toString('hex'),
      csrf = randomBytes(32).toString('hex');
    sessions.set(session, csrf);
    reply.header('Set-Cookie', `elysia_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
    return {
      csrf,
      version: VERSION,
      selectionScope,
      workbenchScope: stableWorkbenchScope,
      surface: options.surface ?? 'native',
    };
  });
  app.get('/api/session', async (request) => ({
    csrf: sessions.get(cookieSession(request.headers.cookie)!),
    version: VERSION,
    selectionScope,
    workbenchScope: stableWorkbenchScope,
    surface: options.surface ?? 'native',
  }));
  app.get('/api/projects', async () => store.all<Project>('projects'));
  app.post('/api/projects/inspect', async (request) => {
    const { workspaceRoot } = z.object({ workspaceRoot: z.string().min(1).max(4096) }).parse(request.body);
    const folder = await inspectFolder(workspaceRoot, executor.gateway.processes);
    return {
      ...folder,
      existing:
        store.all<Project>('projects').find((p) => sameDirectory(p.workspaceRoot, folder.workspaceRoot)) ??
        null,
    };
  });
  app.get<{
    Params: { id: string };
    Querystring: { path?: string; encoding?: string; offset?: string; limit?: string; version?: string };
  }>('/api/projects/:id/files', async (request, reply) => {
    const { encoding, ...page } = textPageQuery.parse(request.query);
    return projectFiles(
      store,
      request.params.id,
      z.string().max(4096).default('.').parse(request.query.path),
      encoding,
      { ...page, signal: fileRequestSignal(request, reply) },
      prefix,
    );
  });
  app.get<{ Params: { id: string; '*': string }; Querystring: { version?: string } }>(
    '/api/projects/:id/resources/*',
    async (request, reply) => {
      reply.header('Content-Security-Policy', restrictedResourcePolicy);
      return sendFileResource(
        reply,
        await projectResource(
          store,
          request.params.id,
          z.string().min(1).max(4096).parse(request.params['*']),
          {
            range: request.headers.range,
            version: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional()
              .parse(request.query.version),
            signal: fileRequestSignal(request, reply),
          },
        ),
      );
    },
  );
  app.get<{ Params: { id: string }; Querystring: { path: string; version?: string } }>(
    '/api/projects/:id/files/resource',
    async (request, reply) => {
      reply.header('Content-Security-Policy', restrictedResourcePolicy);
      return sendFileResource(
        reply,
        await projectResource(
          store,
          request.params.id,
          z.string().min(1).max(4096).parse(request.query.path),
          {
            range: request.headers.range,
            version: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional()
              .parse(request.query.version),
            signal: fileRequestSignal(request, reply),
          },
        ),
      );
    },
  );
  app.post('/api/projects', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        name: z.string().min(1).max(80),
        workspaceRoot: z.string().min(1),
        baseline: z.string().optional(),
        spaceId: z.string().default('default'),
      })
      .parse(request.body);
    const folder = await inspectFolder(body.workspaceRoot, executor.gateway.processes);
    const root = folder.workspaceRoot;
    let baseline: string | null = folder.gitAvailable ? folder.baseline : null;
    if (body.baseline && body.baseline !== 'HEAD') {
      invariant(folder.gitAvailable, 'GIT_REQUIRED', '当前目录没有可用的 Git 基线');
      const probe = await executor.gateway.processes.run(
        'registration',
        'git',
        ['-C', root, 'rev-parse', '--verify', '--end-of-options', (body.baseline || 'HEAD') + '^{commit}'],
        root,
        10000,
        3000,
      );
      baseline = probe.exitCode === 0 ? probe.stdout.trim() : null;
    }
    invariant(!folder.gitAvailable || baseline, 'GIT_BASELINE', 'Git 基线无效，请填写有效 commit 或 ref');
    return command(body, '/projects', () => {
      store.require('project_spaces', body.spaceId);
      const existing = store
        .all<Project>('projects')
        .find((p) => p.spaceId === body.spaceId && sameDirectory(p.workspaceRoot, root));
      if (existing) return existing;
      return store.put<Project>('projects', {
        id: id(),
        revision: 0,
        name: body.name,
        workspaceRoot: root,
        baseline,
        configVersion: 1,
        spaceId: body.spaceId,
        archived: false,
      });
    });
  });
  const providerView = async (provider: ProviderConfig) => ({
    ...provider,
    keyConfigured:
      provider.authMode === 'codex'
        ? codex.configured(provider.subscriptionAccountId)
        : provider.authMode === 'chatgpt'
          ? subscription.configured(provider.subscriptionAccountId)
          : await keys.configured(provider),
  });
  app.get('/api/providers', async () => {
    await subscription.status().catch(() => {});
    const providers = store.all<ProviderConfig>('providers').filter((p) => !p.archived);
    const sources = new Set(
      providers.filter((p) => p.authMode === 'codex').map((p) => codex.source(p.subscriptionAccountId!)),
    );
    await Promise.all([...sources].map((s) => codex.status(s)));
    return Promise.all(providers.map(providerView));
  });
  app.get('/api/codex/status', (request) => {
    const query = z
      .object({
        source: z.enum(['local', 'elysia']).default('local'),
        refresh: z.enum(['1', '0']).optional(),
      })
      .parse(request.query);
    return codex.status(query.source, query.refresh === '1');
  });
  app.post('/api/codex/login', (request) =>
    codex.login(z.object({ method: z.enum(['browser', 'device']) }).parse(request.body).method),
  );
  app.post('/api/codex/cancel', async () => {
    await codex.cancel();
    return { ok: true };
  });
  app.post('/api/codex/logout', async () => {
    const result = await codex.logout();
    for (const p of store.all<ProviderConfig>('providers'))
      if (p.authMode === 'codex' && p.subscriptionAccountId?.startsWith('codex-elysia-'))
        store.put('providers', { ...p, checkedRevision: null });
    return result;
  });
  app.get<{ Params: { id: string } }>('/api/codex/:id/models', (request) => codex.models(request.params.id));
  app.get<{ Params: { id: string } }>('/api/codex/:id/usage', (request) => codex.usage(request.params.id));
  app.get('/api/subscription', () => subscription.status());
  app.post('/api/subscription/login', async (request) => {
    const body = z
      .object({ accountId: z.string().optional(), consent: z.boolean().default(false) })
      .parse(request.body);
    return subscription.start(body.accountId, body.consent);
  });
  app.post('/api/subscription/cancel', async () => {
    subscription.cancel();
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/subscription/:id/models', (request) =>
    subscription.models(request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/subscription/:id/welcome', async (request) => {
    await subscription.welcome(request.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/subscription/:id/retry', async (request) => {
    subscription.retryUsage(request.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/subscription/:id/logout', async (request) => {
    const result = await subscription.logout(request.params.id);
    for (const p of store.all<ProviderConfig>('providers'))
      if (p.authMode === 'chatgpt' && p.subscriptionAccountId === request.params.id)
        store.put('providers', { ...p, checkedRevision: null });
    return result;
  });
  app.put<{ Params: { id: string } }>('/api/providers/:id', async (request) => {
    const body = request.body as any;
    const parsedCommand = Command.parse(body);
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(parsedCommand.commandId))
      return providerView(command<ProviderConfig>(body, request.url, () => ({}) as ProviderConfig));
    const config = ProviderConfig.parse({ ...body, id: request.params.id });
    config.archived = false;
    const existing = store.get<ProviderConfig>('providers', config.id);
    if (existing) revision(body, existing);
    if (config.authMode === 'codex') {
      const models = await codex.models(config.subscriptionAccountId!);
      const model = models.find((m) => m.id === config.model);
      invariant(model, 'CODEX_MODEL', '请选择当前订阅模型目录中的模型');
      invariant(
        !config.reasoningEffort || model.efforts.includes(config.reasoningEffort),
        'CODEX_EFFORT',
        '该模型不支持所选思考强度',
      );
      config.account = 'codex:' + config.subscriptionAccountId!.split('-').at(-1);
      config.credentialId = null;
    }
    if (config.authMode === 'chatgpt') {
      config.credentialId = null;
      invariant(
        subscription.configured(config.subscriptionAccountId),
        'CHATGPT_ACCOUNT',
        '请先登录并授权使用 ChatGPT 订阅',
      );
      const models = await subscription.models(config.subscriptionAccountId!);
      invariant(
        models.some((m: { id: string }) => m.id === config.model),
        'CHATGPT_MODEL',
        '请选择当前订阅账号提供的模型',
      );
      config.account = 'chatgpt:' + config.subscriptionAccountId;
    }
    const endpoint = new URL(config.baseUrl);
    invariant(
      !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash &&
        (endpoint.protocol === 'https:' ||
          (endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname))),
      'PROVIDER_ENDPOINT',
      '模型端点需要 HTTPS；本机测试可使用 loopback HTTP',
    );
    config.baseUrl = providerBaseUrl(config);
    if (config.kind === 'deepseek' && endpoint.hostname === 'api.deepseek.com') {
      invariant(
        ['', '/', '/v1'].includes(new URL(config.baseUrl).pathname),
        'PROVIDER_ENDPOINT',
        'DeepSeek Chat Completions 端点请使用 https://api.deepseek.com 或 /v1；不支持其他协议路径',
      );
    }
    // Validate command/revision before saving secrets. Command storage retains only a hash of the body.
    Command.parse(body);
    if (body.apiKey !== undefined) {
      invariant(
        !['chatgpt', 'codex'].includes(config.authMode || ''),
        'PROVIDER_KEY',
        '订阅连接不使用 API Key',
      );
      config.credentialId = await keys.save(z.string().trim().min(1).max(8192).parse(body.apiKey));
    }
    const saved = command(body, request.url, () => {
      const old = store.get<ProviderConfig>('providers', config.id);
      if (old) revision(body, old);
      return store.put(
        'providers',
        { ...config, revision: old?.revision ?? 0, checkedRevision: null },
        old?.revision ?? 0,
      );
    });
    return providerView(saved);
  });
  app.delete<{ Params: { id: string } }>('/api/providers/:id', (request) =>
    command(request.body, request.url, (body) => {
      const config = store.require<ProviderConfig>('providers', request.params.id);
      revision(body, config);
      store.put('providers', { ...config, archived: true, checkedRevision: null });
      return { ok: true };
    }),
  );
  app.get<{ Params: { id: string } }>('/api/providers/:id/models', async (request) => {
    const config = store.require<ProviderConfig>('providers', request.params.id);
    return availableModels(subscription, codex, config, apiCatalog);
  });
  const pendingChecks = new Map<string, Promise<unknown>>();
  app.post<{ Params: { id: string } }>('/api/providers/:id/check', async (request) => {
    const body = Command.parse(request.body),
      route = request.url;
    const saved = store.db
      .prepare('SELECT result, fingerprint FROM commands WHERE id=?')
      .get(body.commandId) as any;
    if (saved) return store.command(body.commandId, { route, body: request.body }, () => ({}));
    const key = body.commandId;
    if (pendingChecks.has(key)) return pendingChecks.get(key);
    const provider = store.require<ProviderConfig>('providers', request.params.id);
    invariant(!provider.archived, 'PROVIDER_ARCHIVED', '该模型配置已删除');
    revision(body, provider);
    const perform = async () => {
      const adapter = providerAdapter(
        officialDeepSeek(provider) ? { ...provider, reasoningEffort: 'none' } : provider,
      );
      const compiled: Record<string, unknown> = adapter.compile({
        system: 'Reply with OK. This is an explicit connectivity check.',
        task: 'OK',
        history: [],
        tools: [],
        manifest: {},
        estimatedTokens: 64,
      });
      if (!['chatgpt', 'codex'].includes(provider.authMode || ''))
        compiled[provider.kind === 'openai' ? 'max_output_tokens' : 'max_tokens'] = 256;
      let result: any;
      for await (const e of adapter.stream(compiled, new AbortController().signal))
        if (e.type === 'completed') result = e;
      invariant(result, 'CHECK_FAILED', '连通性验证没有完整响应');
      return store.command(body.commandId, { route, body: request.body }, () => {
        const current = store.require<ProviderConfig>('providers', provider.id);
        revision(body, current);
        const updated = store.put('providers', {
          ...current,
          checkedRevision: current.revision + 1,
          checkedAt: now(),
        });
        return { provider: updated, usage: result.usage, response: result.text };
      });
    };
    const promise = perform().finally(() => pendingChecks.delete(key));
    pendingChecks.set(key, promise);
    return promise;
  });
  const runReads = new RunReads(store);
  registerRunRecordRoutes(app, store);
  registerTaskCenter(app, store);
  registerContextPreview(app, store);
  registerPreviewLocationRoutes(app, previews);
  app.get('/api/runs', async (request, reply) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        before: z.string().uuid().optional(),
        query: z.string().max(200).optional(),
        includeRunId: z.string().uuid().optional(),
        archived: z.enum(['true', 'false']).optional(),
        pinned: z.string().max(1600).optional(),
        retained: z.string().max(11100).optional(),
        summary: z.literal('deferred').optional(),
      })
      .strict()
      .parse(request.query);
    if (!query.limit) {
      invariant(!Object.keys(query).length, 'RECORD_PAGE_LIMIT', '会话筛选须指定分页数量');
      return store.all<Run>('runs').reverse();
    }
    const pinned = query.pinned ? z.array(z.string().uuid()).max(40).parse(query.pinned.split(',')) : [];
    const retained = query.retained
      ? z.array(z.string().uuid()).max(300).parse(query.retained.split(','))
      : [];
    return runReads.list(
      {
        ...query,
        archived: query.archived === undefined ? undefined : query.archived === 'true',
        limit: query.limit,
        pinned,
        retained,
      },
      fileRequestSignal(request, reply),
    );
  });
  app.post('/api/terminal/check', async (request) => {
    const body = z
      .object({
        profile: AgentTerminalProfile.optional(),
        profileId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
      })
      .strict()
      .parse(request.body);
    invariant(!body.profile || !body.profileId, 'TERMINAL_PROFILE_SELECTION', '请只指定一个终端模板');
    if (body.projectId) store.require<Project>('projects', body.projectId);
    const profile = body.profileId
      ? terminalSettings(store).profiles.find((value) => value.id === body.profileId)
      : body.profile;
    invariant(!body.profileId || profile, 'TERMINAL_PROFILE_MISSING', '终端模板已删除，请刷新后重试');
    return terminal.check(profile ? boundTerminalProfile(profile, body.projectId) : undefined);
  });
  const assertTerminalMutable = (runId: string) => {
    const run = store.require<Run>('runs', runId);
    management.assertMutable(run.id, run.projectId);
    invariant(
      !run.archived && (!run.projectId || !store.require<Project>('projects', run.projectId).archived),
      'ARCHIVED',
      '请先恢复归档的对话或项目',
    );
    return run;
  };
  app.post<{ Params: { id: string } }>('/api/runs/:id/terminal/accept', async (request) => {
    const body = Command.extend({ expectedRevision: z.number().int().nonnegative() }).parse(request.body);
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
      return command(body, request.url, () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
    const run = store.require<Run>('runs', request.params.id);
    revision(body, run);
    management.assertMutable(run.id, run.projectId);
    invariant(
      !run.archived && (!run.projectId || !store.require<Project>('projects', run.projectId).archived),
      'ARCHIVED',
      '请先恢复归档的对话或项目',
    );
    invariant(!executorHasActive(executor, run.id), 'TERMINAL_ACTIVE', '请等待终端进程结束后再验收');
    const commit = await terminal.prepareAcceptance(run.id, body.expectedRevision);
    return command(body, request.url, () => {
      assertTerminalMutable(run.id);
      return commit();
    });
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/terminal/verify', async (request) => {
    const body = Command.extend({
      expectedRevision: z.number().int().nonnegative(),
      operationId: z.string().uuid(),
      outcome: z.enum(['confirmed', 'not_applied']),
      note: z.string().trim().min(1).max(4000),
    }).parse(request.body);
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
      return command(body, request.url, () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
    const run = store.require<Run>('runs', request.params.id);
    revision(body, run);
    assertTerminalMutable(run.id);
    invariant(!executorHasActive(executor, run.id), 'TERMINAL_ACTIVE', '请等待终端进程结束后再核验');
    const commit = await terminal.prepareVerification(
      run.id,
      body.expectedRevision,
      body.operationId,
      body.outcome,
      body.note,
    );
    return command(body, request.url, () => {
      assertTerminalMutable(run.id);
      return commit();
    });
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/terminal/session', async (request) =>
    terminal.sessionView(request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/runs/:id/terminal/continue', async (request) => {
    const body = Command.extend({
      expectedRevision: z.number().int().nonnegative(),
      mode: z.enum(['resume', 'new-session']),
      text: z.string().trim().min(1).max(60000),
    })
      .strict()
      .parse(request.body);
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
      return command(body, request.url, () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
    const run = assertTerminalMutable(request.params.id);
    invariant(options.surface !== 'native', 'TERMINAL_READ_ONLY', '旧终端记录仅供查看，请切换到 Agent 终端');
    revision(body, run);
    invariant(!executorHasActive(executor, run.id), 'TERMINAL_ACTIVE', '请等待终端进程结束后继续');
    const commit = await terminal.prepareContinuation(run.id, body.expectedRevision, body.mode, body.text);
    const result = command(body, request.url, () => {
      assertTerminalMutable(run.id);
      invariant(!executorHasActive(executor, run.id), 'TERMINAL_ACTIVE', '请等待终端进程结束后继续');
      return commit();
    });
    executor.resume(run.id);
    return result;
  });
  app.post('/api/runs', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        projectId: z.string().nullable().optional(),
        kind: z.enum(['task', 'chat']).default('task'),
        objective: z.string().min(1).max(20000),
        providerId: ModelChoice.shape.providerId.optional(),
        model: ModelChoice.shape.model,
        reasoningEffort: ModelChoice.shape.reasoningEffort,
        contextPolicy: ContextPolicy.optional(),
        planMode: z.boolean().default(true),
        execution: ExecutionBinding.default({ kind: 'native' }),
        permissionProfile: Permissions.default({
          read: true,
          write: false,
          exec: false,
          urls: [],
          writePaths: ['.'],
        }),
        budget: Budget.default({ maxRequests: 80, maxTokens: 500000, maxCost: null }),
        limits: Limits.default({
          maxDepth: 2,
          maxAgents: 12,
          concurrency: 4,
          toolConcurrency: 4,
          maxSteps: 20,
          maxMinutes: 30,
        }),
        inputs: z.array(z.string()).default([]),
        source: RunSourceSelection.optional(),
        deliverables: RunDeliveryItems.optional(),
        acceptanceCriteria: RunDeliveryItems.optional(),
      })
      .parse(request.body);
    invariant(
      options.surface !== 'native' || body.execution.kind === 'native',
      'SURFACE_EXECUTION',
      'Elysia 入口仅使用原生模型；请在 Agent 终端入口创建 Docker 任务',
    );
    invariant(
      !body.source ||
        (options.surface !== 'terminal' && body.kind === 'task' && body.execution.kind === 'native'),
      'SOURCE_SURFACE',
      '带来源创建仅支持原生项目任务，请重新确认项目与授权范围',
    );
    invariant(
      (!body.deliverables && !body.acceptanceCriteria) ||
        (options.surface !== 'terminal' && body.kind === 'task' && body.execution.kind === 'native'),
      'DELIVERY_SURFACE',
      '具体交付物和验收标准仅用于原生项目任务',
    );
    invariant(
      options.surface !== 'terminal' ||
        (body.kind === 'task' && body.execution.kind === 'docker-agent' && body.planMode === false),
      'SURFACE_EXECUTION',
      'Agent 终端入口仅支持项目 Docker 任务，并由终端调度执行',
    );
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
      return command(body, '/runs', () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
    const execution =
      body.execution.kind === 'docker-agent'
        ? {
            kind: 'docker-agent' as const,
            profile: boundTerminalProfile(body.execution.profile, body.projectId),
          }
        : body.execution;
    const provider =
      execution.kind === 'docker-agent'
        ? terminalBinding(execution.profile)
        : await resolveModelChoice(store, subscription, codex, ModelChoice.parse(body), apiCatalog);
    return command(body, '/runs', () => {
      invariant(
        body.kind === 'chat' ? !body.projectId : !!body.projectId,
        'RUN_OWNERSHIP',
        '独立聊天不绑定项目，项目任务必须选择项目',
      );
      const project = body.kind === 'chat' ? null : store.require<Project>('projects', body.projectId!);
      management.assertMutable(null, project?.id);
      invariant(!project?.archived, 'PROJECT_ARCHIVED', '请先恢复已归档的项目');
      const source = body.source ? captureRunSource(store, body.source) : undefined;
      const contract = Contract.parse({
        objective: body.objective,
        scope: [body.objective],
        nonGoals: ['发布、push、修改主目录', '未经授权的访问'],
        inputs: body.inputs,
        deliverables:
          body.deliverables ?? (body.kind === 'chat' ? ['聊天回复'] : ['可检查的文件、差异或报告']),
        acceptanceCriteria:
          body.acceptanceCriteria ??
          (body.kind === 'chat' ? ['回答用户消息'] : ['交付产物可读取，并有实际验证证据']),
        constraints: ['遵守用户指定的授权和预算'],
        permissionProfile:
          body.kind === 'chat'
            ? { read: false, write: false, exec: false, urls: [], writePaths: [] }
            : body.permissionProfile,
        budget: body.budget,
        assumptions: [],
      });
      const created = kernel.createRun(
        project,
        body.objective,
        provider,
        contract,
        body.limits,
        body.kind,
        body.contextPolicy,
        body.planMode,
        execution,
      );
      if (!source) return created;
      const sourced = attachRunSource(store, created, source);
      kernel.event(sourced.id, 'run.updated', sourced);
      return sourced;
    });
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/context', async (request) =>
    contextBoundaries(kernel.contextSnapshot(request.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/runs/:id/context', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        expectedRevision: z.number().int().nonnegative(),
        agentId: z.string().min(1),
        expectedAgentRevision: z.number().int().nonnegative(),
        policy: ContextPolicy,
      })
      .parse(request.body);
    return command(body, request.url, () => {
      const run = store.require<Run>('runs', request.params.id);
      const agent = store.require<Agent>('agents', body.agentId);
      management.assertMutable(run.id, run.projectId);
      revision(body, run);
      invariant(agent.runId === run.id, 'CONTEXT_SCOPE', '上下文配置不属于当前对话');
      invariant(
        run.execution?.kind !== 'docker-agent',
        'TERMINAL_CONTEXT_FROZEN',
        '外部 Agent 管理上下文，调整配置请新建任务',
      );
      invariant(
        !executorHasActive(executor, run.id, agent.taskId),
        'CONTEXT_BOUNDARY',
        '请先暂停代理并等待当前请求和操作结束',
      );
      return contextBoundaries(
        kernel.setContextPolicy(
          run.id,
          agent.id,
          body.expectedRevision,
          body.expectedAgentRevision,
          body.policy,
        ),
      );
    });
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    const eventCursor = Number(
      (
        store.db
          .prepare('SELECT COALESCE(MAX(seq),0) n FROM events WHERE run_id=?')
          .get(request.params.id) as { n: number }
      ).n,
    );
    const run = store.require<Run>('runs', request.params.id);
    const query = z
      .object({
        messageLimit: z.coerce.number().int().min(40).max(240).optional(),
        beforeMessage: z.string().uuid().optional(),
        aroundMessage: z.string().uuid().optional(),
        retainedMessages: z.string().max(8880).optional(),
        view: z.literal('conversation').optional(),
        summary: z.literal('deferred').optional(),
      })
      .strict()
      .parse(request.query);
    invariant(
      !(query.beforeMessage || query.aroundMessage) || query.messageLimit !== undefined,
      'MESSAGE_CURSOR_LIMIT',
      '历史分页须指定消息数量',
    );
    invariant(
      !query.aroundMessage || !query.beforeMessage,
      'MESSAGE_CURSOR_MODE',
      '目标定位与历史分页不能同时使用',
    );
    invariant(
      !query.summary || (query.view === 'conversation' && query.messageLimit !== undefined),
      'CONVERSATION_SUMMARY_LIMIT',
      '延后统计须使用分页对话视图',
    );
    invariant(
      !query.retainedMessages || (query.view === 'conversation' && query.messageLimit !== undefined),
      'CONVERSATION_LINK_LIMIT',
      '消息关联读取须使用分页对话视图',
    );
    const retainedMessages = query.retainedMessages
      ? z.array(z.string().uuid()).max(240).parse(query.retainedMessages.split(','))
      : [];
    const history =
      query.messageLimit === undefined
        ? { messages: store.all<Message>('messages', run.id) }
        : query.aroundMessage
          ? store.messageAroundPage<Message>(run.id, query.messageLimit, query.aroundMessage)
          : store.messagePage<Message>(run.id, query.messageLimit, query.beforeMessage);
    return {
      run,
      eventCursor,
      ...(options.surface === 'terminal'
        ? {
            terminalRuntime: {
              executor: executor.runtimeSnapshot(run.id),
              terminal: terminal.runtimeSnapshot(run.id),
            },
          }
        : {}),
      readOnly: options.surface === 'native' && run.execution?.kind === 'docker-agent',
      readOnlyReason:
        options.surface === 'native' && run.execution?.kind === 'docker-agent'
          ? '旧版终端任务保留为只读历史，请在 Agent 终端入口创建独立任务'
          : null,
      tasks: store.all<Task>('tasks', run.id),
      agents: store.all<Agent>('agents', run.id),
      contexts:
        options.surface === 'terminal' || query.summary === 'deferred'
          ? []
          : contextBoundaries(kernel.contextSnapshot(run.id)).agents,
      ...history,
      ...(query.view === 'conversation'
        ? runReads.conversation(
            run,
            [...history.messages, ...store.messageConversationLinks(run.id, retainedMessages)],
            query.summary === 'deferred',
          )
        : {
            artifacts: store.all<Artifact>('artifacts', run.id),
            snapshots: store.all('snapshots', run.id),
            requests: store.all<RequestRecord>('requests', run.id),
            operations: store.all<Operation>('tool_operations', run.id),
            decisions: store.all('decisions', run.id),
          }),
      events: store.events(
        run.id,
        Math.max(
          0,
          Number((store.db.prepare('SELECT MAX(seq) n FROM events WHERE run_id=?').get(run.id) as any).n) -
            100,
        ),
      ),
      edges: store.db
        .prepare(
          'SELECT task_id taskId,dependency_id dependencyId FROM task_edges WHERE task_id IN (SELECT id FROM tasks WHERE run_id=?)',
        )
        .all(run.id),
    };
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/messages', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        expectedRevision: z.number().int(),
        text: z.string().min(1).max(20000),
        contract: Contract.optional(),
      })
      .parse(request.body);
    const result = command(body, request.url, () => {
      const run = store.require<Run>('runs', request.params.id);
      // Plain messages append to the inbox and cannot overwrite a run; streaming status
      // revisions may advance while the user is typing. Contract edits remain optimistic.
      if (body.contract) revision(body, run);
      else
        invariant(
          body.expectedRevision >= 0 && body.expectedRevision <= run.revision,
          'REVISION_CONFLICT',
          '消息版本无效，请刷新后重试',
        );
      management.assertMutable(run.id, run.projectId);
      invariant(
        !run.archived && (!run.projectId || !store.require<Project>('projects', run.projectId).archived),
        'ARCHIVED',
        '请先恢复归档的对话或项目',
      );
      invariant(!['DONE', 'CANCELLED'].includes(run.status), 'INVALID_STATE', '运行已结束');
      if (body.contract) {
        invariant(
          run.execution?.kind !== 'docker-agent',
          'TERMINAL_CONTRACT_FROZEN',
          '终端任务约定已冻结，请新建任务调整交付要求',
        );
        invariant(
          stable(body.contract.permissionProfile) === stable(run.contract.permissionProfile) &&
            stable(body.contract.budget) === stable(run.contract.budget) &&
            body.contract.version === run.contract.version,
          'CONTRACT_AUTHORITY',
          '编辑约定不能扩大权限或预算',
        );
        kernel.updateRun(run, { contract: body.contract });
      }
      return kernel.inbox(run.id, body.text);
    });
    executor.resume(request.params.id);
    return result;
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/plan/accept', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        expectedRevision: z.number().int(),
        version: z.number().int(),
        assignments: z
          .array(ModelChoice.extend({ key: z.string().min(1), contextPolicy: ContextPolicy.optional() }))
          .max(11)
          .default([]),
      })
      .parse(request.body);
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
      return command(body, request.url, () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
    const run = store.require<Run>('runs', request.params.id);
    management.assertMutable(run.id, run.projectId);
    revision(body, run);
    invariant(
      !run.archived &&
        !!run.plan &&
        (!run.projectId || !store.require<Project>('projects', run.projectId).archived),
      'INVALID_STATE',
      '当前没有可接受的计划，或所属项目已归档',
    );
    invariant(
      new Set(body.assignments.map((a) => a.key)).size === body.assignments.length &&
        body.assignments.every((a) => run.plan!.tasks.some((t) => t.key === a.key)),
      'MODEL_ASSIGNMENTS',
      '模型分配需要唯一的计划一级任务 key',
    );
    const planAlignment = await executor.gateway.planAlignment.load();
    const bindings = new Map<string, ProviderConfig>();
    for (const task of run.plan.tasks) {
      const choice = body.assignments.find((a) => a.key === task.key) ?? task;
      bindings.set(task.key, await resolveModelChoice(store, subscription, codex, choice, apiCatalog));
    }
    const result = command(body, request.url, () =>
      planAlignment.accept(
        request.params.id,
        body.version,
        body.expectedRevision,
        body.assignments,
        bindings,
      ),
    );
    executor.resume(request.params.id);
    return result;
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/actions', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        expectedRevision: z.number().int(),
        action: z.enum(['start', 'pause', 'resume', 'cancel', 'switch_model', 'resume_task']),
        taskId: z.string().optional(),
        providerId: ModelChoice.shape.providerId.optional(),
        model: ModelChoice.shape.model,
        reasoningEffort: ModelChoice.shape.reasoningEffort,
        switchMode: z.enum(['apply', 'resume']).optional(),
      })
      .parse(request.body);
    const switching = body.action === 'switch_model' || body.providerId !== undefined;
    invariant(
      body.action !== 'switch_model' || (body.taskId && body.providerId && body.switchMode),
      'MODEL_SWITCH_CHOICE',
      '切换模型需要指定代理、模型配置以及仅应用或继续执行',
    );
    invariant(
      switching
        ? ['switch_model', 'pause', 'resume'].includes(body.action)
        : body.model === undefined && body.reasoningEffort === undefined && body.switchMode === undefined,
      'MODEL_SWITCH_CHOICE',
      '模型选择仅用于显式模型切换',
    );
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
      return command(body, request.url, () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
    let binding: ProviderConfig | undefined;
    if (switching) {
      const run = store.require<Run>('runs', request.params.id);
      revision(body, run);
      management.assertMutable(run.id, run.projectId);
      invariant(body.taskId && body.providerId, 'MODEL_SWITCH_CHOICE', '切换模型需要指定代理和模型配置');
      binding = await resolveModelChoice(
        store,
        subscription,
        codex,
        {
          providerId: body.providerId,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
        },
        apiCatalog,
      );
    }
    const result = command(body, request.url, () => {
      const run = store.require<Run>('runs', request.params.id);
      revision(body, run);
      management.assertMutable(run.id, run.projectId);
      invariant(
        !run.archived && (!run.projectId || !store.require<Project>('projects', run.projectId).archived),
        'ARCHIVED',
        '请先恢复归档的对话或项目',
      );
      if (body.action === 'resume_task') {
        invariant(
          body.taskId && !executorHasActive(executor, run.id, body.taskId),
          'TASK_RESUME_BOUNDARY',
          '请选择已暂停或失败的代理，并等待当前操作结束',
        );
        return kernel.resumeTask(run.id, body.taskId);
      }
      if (binding) {
        invariant(
          body.taskId && !executorHasActive(executor, run.id, body.taskId),
          'MODEL_SWITCH_BOUNDARY',
          '该代理仍在执行，请先暂停并等待当前操作结束',
        );
        const switched = kernel.switchModel(
          run.id,
          body.taskId,
          binding,
          body.action === 'switch_model' ? body.switchMode! : body.action === 'resume' ? 'resume' : 'apply',
        );
        // Legacy providerId + pause still means a saved pause, without pausing descendants.
        if (body.action === 'pause') {
          const task = store.require<Task>('tasks', body.taskId);
          if (task.waitReason === 'user' && run.kind === 'chat') kernel.wait(task, 'paused');
          return store.require<Run>('runs', run.id);
        }
        return switched;
      }
      invariant(body.action !== 'switch_model', 'MODEL_SWITCH_CHOICE', '模型选择未完成');
      return kernel.action(run.id, body.action, body.taskId);
    });
    if (!switching && ['pause', 'cancel'].includes(body.action))
      await executor.interrupt(request.params.id, body.taskId);
    if (!switching || body.action === 'resume' || body.switchMode === 'resume')
      executor.resume(request.params.id);
    return result;
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/decisions', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        expectedRevision: z.number().int(),
        operationId: z.string().optional(),
        requestId: z.string().optional(),
        outcome: z.enum(['confirmed', 'not_applied']),
        result: z.unknown().optional(),
        usage: z.any().optional(),
        note: z.string().min(1),
      })
      .parse(request.body);
    return command(body, request.url, () => {
      const run = store.require<Run>('runs', request.params.id);
      revision(body, run);
      management.assertMutable(run.id, run.projectId);
      invariant(
        !run.archived &&
          !['DONE', 'CANCELLED'].includes(run.status) &&
          (!run.projectId || !store.require<Project>('projects', run.projectId).archived),
        'INVALID_STATE',
        '请先恢复归档记录；已结束的对话不能修改核验结果',
      );
      invariant(body.operationId || body.requestId, 'DECISION_TARGET', '需要具体操作或请求引用');
      if (body.operationId) {
        const op = store.require<Operation>('tool_operations', body.operationId);
        invariant(
          op.name !== 'terminal_agent',
          'TERMINAL_VERIFICATION_ROUTE',
          '请使用终端专用核验入口处理容器与文件副作用',
        );
        const task = store.require<Task>('tasks', op.taskId);
        invariant(
          op.runId === run.id && op.status === 'UNCERTAIN',
          'DECISION_SCOPE',
          '操作不属于当前待核验集合',
        );
        invariant(
          !['DONE', 'CANCELLED'].includes(task.status),
          'INVALID_STATE',
          '已结束的任务不能修改核验结果',
        );
        const updated = store.put('tool_operations', {
          ...op,
          status: body.outcome === 'confirmed' ? 'DONE' : 'FAILED',
          result: body.result ?? { note: body.note, userVerified: true },
          error: body.outcome === 'confirmed' ? undefined : body.note,
        });
        if (
          task.status === 'WAITING' &&
          task.waitReason === 'verification' &&
          !store
            .all<Operation>('tool_operations', run.id)
            .some((o) => o.taskId === task.id && o.status === 'UNCERTAIN')
        )
          kernel.updateTask(task, 'READY', { waitReason: undefined });
        kernel.event(run.id, 'tool.completed', updated, task.id);
      }
      if (body.requestId) {
        const r = store.require<RequestRecord>('requests', body.requestId);
        invariant(r.runId === run.id && r.status === 'UNKNOWN', 'DECISION_SCOPE', '请求不属于待核验集合');
        invariant(
          body.usage &&
            typeof body.usage.inputTotal === 'number' &&
            typeof body.usage.outputTotal === 'number',
          'USAGE_REQUIRED',
          '用量核验需实际 usage',
        );
        kernel.settle(r.id, body.usage);
      }
      const decision = store.put('decisions', {
        id: id(),
        revision: 0,
        runId: run.id,
        ...body,
        source: 'user',
        createdAt: now(),
      });
      const current = store.require<Run>('runs', run.id);
      const root = store.require<Task>('tasks', run.rootTaskId);
      if (current.status === 'WAITING' && current.reason === 'verification' && root.status === 'READY')
        kernel.updateRun(current, { status: 'READY', reason: undefined });
      return decision;
    });
  });
  const streams = new Map<string, Set<any>>();
  const boundedStreams = new WeakMap<object, BoundedEventStream>();
  const management = registerManagement(
    app,
    store,
    kernel,
    executor,
    (runId) => {
      for (const stream of streams.get(runId) ?? []) stream.end();
      streams.delete(runId);
    },
    (projectId) => terminalControl?.removeProjectPreferences(projectId),
  );
  if (options.surface !== 'terminal') registerWorkflow(app, store, management.assertMutable);
  executor.onDelta = (runId, taskId, text, requestId, offset) => {
    for (const stream of streams.get(runId) ?? [])
      boundedStreams
        .get(stream)
        ?.write(
          'event: message.delta\ndata: ' +
            JSON.stringify({ runId, taskId, text, requestId, offset }) +
            '\n\n',
          true,
        );
  };
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/runs/:id/events',
    async (request, reply) => {
      store.require<Run>('runs', request.params.id);
      const runId = request.params.id;
      let after = Math.max(Number(request.headers['last-event-id'] ?? request.query.after ?? 0), 0);
      invariant(Number.isSafeInteger(after), 'EVENT_CURSOR', '事件游标无效');
      reply.hijack();
      const stream = reply.raw;
      const bounded = new BoundedEventStream(stream, runId);
      boundedStreams.set(stream, bounded);
      stream.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      });
      stream.write(': connected\n\n');
      if (!streams.has(runId)) streams.set(runId, new Set());
      streams.get(runId)!.add(stream);
      const flush = () => {
        if (!bounded.available) return;
        for (const event of store.eventNotifications(runId, after)) {
          if (!bounded.available || !bounded.write(eventFrame(event))) break;
          after = event.seq;
        }
      };
      flush();
      const timer = setInterval(flush, 350),
        heartbeat = setInterval(() => bounded.write(': heartbeat\n\n'), 15000);
      stream.on('close', () => {
        clearInterval(timer);
        clearInterval(heartbeat);
        streams.get(runId)?.delete(stream);
      });
    },
  );
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request, reply) => {
    const artifact = store.require<Artifact>('artifacts', request.params.id);
    store.require<Run>('runs', artifact.runId);
    reply
      .header(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(artifact.name.replace(/[\r\n]/g, ''))}`,
      )
      .header('Content-Security-Policy', restrictedResourcePolicy);
    return sendFileResource(
      reply,
      await artifactPreviews.resource(artifact, {
        range: request.headers.range,
        signal: fileRequestSignal(request, reply),
      }),
    );
  });
  app.get<{
    Params: { id: string };
    Querystring: { offset?: string; limit?: string; version?: string; encoding?: string };
  }>('/api/artifacts/:id/preview', async (request, reply) => {
    const artifact = store.require<Artifact>('artifacts', request.params.id);
    store.require<Run>('runs', artifact.runId);
    const { encoding, ...page } = textPageQuery.parse(request.query);
    return artifactPreviews.preview(artifact, encoding, {
      ...page,
      signal: fileRequestSignal(request, reply),
    });
  });
  const webRoot = path.join(process.cwd(), 'apps', 'web', 'dist');
  if (options.serveWeb !== false && existsSync(webRoot)) {
    void app.register(staticFiles, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (/^\/(?:terminal\/)?api(?:\/|$)/.test(request.url))
        return reply
          .code(404)
          .send({ code: 'NOT_FOUND', message: '接口不存在', retryable: false, details: null });
      return reply.sendFile('index.html');
    });
  } else if (options.serveWeb !== false)
    app.get('/', async () => ({ message: '前端未构建，执行 pnpm build 或使用 pnpm dev', version: VERSION }));
  if (options.serveWeb === false)
    app.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({
        code: 'NOT_FOUND',
        message: '接口不存在',
        retryable: false,
        details: null,
      }),
    );
  app.addHook('preClose', async () => {
    for (const set of streams.values()) for (const stream of set) stream.end();
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => (options.surface === 'terminal' ? undefined : codex.close())),
      Promise.resolve().then(() => (options.surface === 'terminal' ? undefined : subscription.close())),
      Promise.resolve().then(() => executor.dispose()),
    ]);
    const failure = stopped.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  });
  return {
    app,
    kernel,
    executor,
    terminal,
    auth,
    bootstrapToken,
    origins,
    allowFrontendOrigin: (origin: string) => {
      origins.add(origin);
      hosts.add(new URL(origin).host);
    },
    refreshBootstrapExpiry: () => {
      auth.bootstrapExpires = Date.now() + 15 * 60000;
    },
  };
}
function requestPreviewPolicy(url: string, policy: unknown) {
  return url.startsWith('/preview/') ||
    /^\/api\/projects\/[^/]+\/(?:resources\/|files\/resource(?:\?|$))/.test(url) ||
    /^\/api\/artifacts\/[^/?]+(?:\?|$)/.test(url)
    ? typeof policy === 'string'
      ? policy
      : "default-src 'none'; sandbox; frame-ancestors 'self'"
    : undefined;
}
function executorHasActive(executor: NativeExecutor, runId: string, taskId?: string) {
  return (
    (executor as any).active &&
    [...(executor as any).active.entries()].some(
      ([key, a]: [string, any]) => a.runId === runId && (!taskId || key === taskId),
    )
  );
}
