/**
 * 创建服务端并组装路由和依赖。
 * 装配单数据目录/入口的认证、路由、内核和执行器，限制原生/终端能力及资源生命周期；只创建服务对象，实际监听由调用方管理。
 * EN: Creates the server and composes routes and dependencies. Composes auth/routes/kernel/executor per directory/surface with native/terminal and resource-lifecycle boundaries; callers own actual listening.
 */
import { RunApplicationService } from './run-application.js';
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
  type ContextSnapshot,
} from '../../../packages/contracts/src/index.js';
import { Store, id, now, stable } from '../../../packages/storage/src/index.js';
import { createKernel } from './kernel-services.js';
import { NativeExecutor } from '../../../packages/runtime/src/index.js';
import { DockerAgentService, type TerminalSessionView } from '../../../packages/runtime/src/docker-agent.js';
import { registerTerminalCommunication } from './terminal-communication.js';
import { terminalBinding } from './terminal-binding.js';
import { providerBaseUrl, ProviderRegistry } from '../../../packages/providers/src/index.js';
import { serverProviderPlugins } from './provider-plugins.js';
import { terminalExecutionPlugin } from '../../../packages/runtime/src/terminal-plugin.js';
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
import { reasoningMessagePreview, reasoningPrefixLength } from '../../../packages/contracts/src/reasoning.js';
import { CodexSubscription } from './codex-subscription.js';
import { ProviderKeys } from './provider-keys.js';
import { registerManagement } from './management.js';
import { registerWorkbench, workbenchScope } from './workbench.js';
import { BoundedEventStream, eventFrame } from './event-stream.js';
import { availableModels, resolveModelChoice, resolveModelChoices } from './model-choice.js';
import { apiModels, officialDeepSeek } from './api-model-catalog.js';
import { createSurfaceAuth, type SurfaceAuth, type WorkbenchSurface } from './surfaces.js';
import { registerTerminalSettings, terminalSettings } from './terminal-settings.js';
import { registerTerminalLogSearchRoutes } from './terminal-log-search.js';
import { TerminalControlService, registerTerminalControl, terminalAppCatalog } from './terminal-control.js';
import { registerCliManagement } from './cli-management.js';
import { RunReads, registerRunRecordRoutes } from './run-reads.js';
import type { RunStopCurrentResult } from '../../../packages/contracts/src/run-reads.js';
import { registerTaskCenter } from './task-center.js';
import { registerContextPreview } from './context-preview.js';
import { registerLocalAgentRoutes } from './local-agents.js';
import { registerModelRouting } from './model-routing.js';
import { registerProjectIntelligenceRoutes } from './project-intelligence.js';
import { registerTaskWorkingStateRoutes } from './task-working-state.js';
import { registerReadiness } from './readiness.js';
import { registerProjectSchedules } from './project-schedules.js';
import { registerPreviewLocationRoutes } from './preview-location.js';
import { registerTerminalMaintenance } from './terminal-maintenance.js';
import { RunSourceSelection, RunDeliveryItems } from '../../../packages/contracts/src/workflow.js';
import { attachRunSource, captureRunSource, registerWorkflow } from './workflow.js';
import { ProjectDeliveryBinding } from '../../../packages/contracts/src/project-delivery.js';
import { attachProjectDeliveryRun, registerProjectDelivery } from './project-delivery.js';
import { registerProjectUsage } from './project-usage.js';
import { registerRuntimeDiagnostics } from './runtime-diagnostics.js';
import { registerNativeInboxReceipts } from './inbox-receipts.js';
import { createAutomationPlugins, registerAutomationPluginRoutes } from './automation-plugins.js';
import type { AutomationPlugin } from '../../../packages/plugins/src/automation.js';
const textPageQuery = z.object({
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(TEXT_PAGE_BYTES).optional(),
  version: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  encoding: z.enum(projectTextEncodings).default('auto'),
});
/**
 * 下载中断或响应提前关闭时取消文件读取；正常发送完成不误判为取消。
 * EN: Cancels file reads on download abort or premature response closure without treating a completed send as cancellation.
 */
function fileRequestSignal(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  /**
   * 中止当前资源响应的文件读取控制器。
   * EN: Aborts file reading for this resource response.
   */
  const abort = () => controller.abort();
  request.raw.once('aborted', abort);
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) abort();
    request.raw.removeListener('aborted', abort);
  });
  return controller.signal;
}
/**
 * 将已校验文件资源的范围、版本和长度信息传给 HTTP 层，不在此重新解释路径。
 * EN: Passes validated range, revision and length metadata to HTTP without reinterpreting paths.
 */
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
/**
 * 构造内置供应商的初始配置；实际凭据由后续连接流程提供。
 * EN: Builds initial built-in provider configuration; credentials arrive through the connection flow.
 */
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
/**
 * 为一个数据目录和界面入口装配 HTTP 服务、内核及执行器。可注入已有 Fastify 实例， prefix 用于共享监听器下的路径归属，surface 决定原生/终端能力边界；鉴权在路由前统一执行。 本函数只创建服务对象，监听端口和上层关闭由调用方管理。
 * EN: Assembles HTTP, kernel and executor for one data directory and surface. Supports an injected Fastify instance; prefix scopes shared listeners and surface defines native/terminal capabilities. Authentication runs before routes. Listening and outer lifecycle remain caller-owned.
 */
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
    automationPlugins?: readonly AutomationPlugin[];
  },
) {
  const app = options.app ?? Fastify({ logger: false, bodyLimit: 3 * 1024 * 1024 });
  const prefix = options.prefix ?? '';
  const diagnostics = registerRuntimeDiagnostics(app, options.surface ?? 'native');
  /**
   * 把请求 URL 映射到本入口局部路径，其他入口返回 null，防止共享监听器上的路由越界。
   * EN: Maps URLs to this surface's local path and returns null for other surfaces, preserving shared-listener route ownership.
   */
  const localUrl = (url: string) =>
    prefix
      ? url.startsWith(prefix + '/')
        ? url.slice(prefix.length)
        : null
      : url.startsWith('/terminal/')
        ? null
        : url;
  const kernel = createKernel(store);
  const automation =
    options.surface === 'terminal' ? undefined : createAutomationPlugins(store, options.automationPlugins);
  const terminalControl =
    options.surface === 'terminal'
      ? new TerminalControlService(store, options.terminalDesktop ?? desktopServices())
      : undefined;
  /**
   * 原生入口才实例化账号服务；终端入口返回拒绝所有属性访问的代理，使误用立即失败且不加载凭据能力。
   * EN: Instantiates account services only for native access; terminal receives a rejecting proxy so misuse fails without loading credential capabilities.
   */
  const nativeService = <T extends object>(factory: () => T): T =>
    /**
     * 终端入口连原生凭据服务都不实例化；误调用通过代理立即失败，避免隐藏的账号访问。
     * EN: The terminal surface never instantiates native credential services; accidental access fails immediately through a proxy.
     */
    options.surface === 'terminal'
      ? new Proxy({} as T, {
          /**
           * 拒绝终端入口访问原生账号代理的任意属性，抛明确入口边界错误。
           * EN: Rejects every native-account proxy property access from terminal with an explicit surface-boundary error.
           */
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
  /**
   * 通过服务器持有的密钥能力读取指定 API 配置的模型目录，不把密钥服务传给运行时。
   * EN: Reads an API binding's model catalog through server-held key capability without exposing it to runtime.
   */
  const apiCatalog = (provider: ProviderConfig) => apiModels(provider, keys);
  const providerPlugins =
    options.surface === 'terminal'
      ? new ProviderRegistry([])
      : serverProviderPlugins({ codex, subscription, keys });
  /**
   * 按冻结配置从已注册服务商插件取得适配器，协议与认证不匹配会由注册表拒绝。
   * EN: Resolves adapters from provider plugins for frozen bindings, rejecting unsupported protocol/auth pairs.
   */
  const providerAdapter = (provider: ProviderConfig) => providerPlugins.adapter(provider);
  let terminal!: DockerAgentService;
  const executor = new NativeExecutor(kernel, {
    /**
     * 只允许原生执行器按代理冻结绑定创建模型适配器，终端入口调用立即失败。
     * EN: Allows native execution to create adapters from frozen agent bindings and rejects terminal-surface calls.
     */
    adapterFactory: (agent) => {
      invariant(options.surface !== 'terminal', 'SURFACE_EXECUTION', 'Agent 终端入口不调用原生模型');
      return providerAdapter(agent.providerBinding);
    },
    /**
     * 按服务入口筛选可调度的执行类型，未指定隔离入口时兼容接受两类运行。
     * EN: Filters schedulable execution kinds by surface, accepting both when no isolated surface is specified.
     */
    acceptRun: (run) =>
      options.surface === 'native'
        ? run.execution?.kind !== 'docker-agent'
        : options.surface === 'terminal'
          ? run.execution?.kind === 'docker-agent'
          : true,
    /**
     * 使用内核和受控网关创建 Docker 终端服务，注入可选终端凭据解析后返回执行插件。
     * EN: Creates Docker terminal service from kernel/gateway, injects optional terminal credential resolution and returns its execution plugin.
     */
    executionPlugins: (gateway) => {
      terminal = new DockerAgentService(kernel, gateway, {
        ...options.terminal,
        ...(terminalControl
          ? {
              /**
               * 把冻结终端绑定交给终端独立凭据服务解析，不读取原生账号存储。
               * EN: Resolves frozen terminal bindings through terminal-only credentials rather than native account storage.
               */
              resolveConnection: (binding) => terminalControl.credential(binding),
            }
          : {}),
      });
      return [terminalExecutionPlugin(terminal)];
    },
  });
  const runService = new RunApplicationService(kernel, executor, (runId, projectId) =>
    management.assertMutable(runId, projectId),
  );
  /**
   * 优先绑定项目明确选择且协议兼容的连接；最终由控制服务冻结凭据引用而非复制明文。
   * EN: Prefers an explicitly selected protocol-compatible project connection; control services freeze credential references rather than plaintext.
   */
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
  /**
   * 从 Cookie 头提取会话值，仅负责语法提取，真实性由认证钩子核验。
   * EN: Extracts the session cookie value only; authentication hooks validate authenticity.
   */
  const cookieSession = (header?: string) =>
    header
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('elysia_session='))
      ?.slice(15);
  /**
   * 第一层边界：本机 Host/Origin → 会话 Cookie → 修改请求 CSRF → 入口能力与旧历史只读。
   * EN: Applies boundaries in order: local Host/Origin, session cookie, mutation CSRF, then surface capabilities and read-only legacy history.
   */
  app.addHook('onRequest', async (request, reply) => {
    const address = app.server.address();
    /**
     * 端口可由系统分配，鉴权集合必须采用实际监听端口，而不是启动参数中的旧占位端口。
     * EN: Authentication must use the actual listening port when the OS assigns it, not the initial placeholder.
     */
    if (address && typeof address !== 'string') {
      hosts.delete(`127.0.0.1:${options.port}`);
      origins.delete(`http://127.0.0.1:${options.port}`);
      hosts.add(`127.0.0.1:${address.port}`);
      origins.add(`http://127.0.0.1:${address.port}`);
    }
    invariant(hosts.has(request.headers.host ?? ''), 'HOST_DENIED', 'Host 不允许');
    const url = localUrl(request.url);
    if (url === null) return;
    /**
     * 能力限定的沙箱框架拥有不透明来源，且不携带应用会话。
     * EN: Capability-scoped sandbox frames have opaque origins and no app session.
     */
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
  /**
   * 普通工作台使用统一 CSP；资源预览保留其更严格的沙箱策略，避免外部正文获得应用权限。
   * EN: Applies the workbench CSP while preserving stricter resource-preview sandbox policies so external bodies gain no app authority.
   */
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
  /**
   * 原生入口保留旧终端历史时禁止通过项目级归档/删除间接修改这批只读历史。
   * EN: Native project archival/deletion cannot indirectly modify retained read-only legacy terminal history.
   */
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
  /**
   * 统一业务错误与输入校验的 HTTP 形态；范围错误保留 Content-Range 供客户端正确恢复读取。
   * EN: Normalizes domain and validation errors into HTTP responses and retains Content-Range for range recovery.
   */
  app.setErrorHandler((error, request, reply) => {
    const e = error as any;
    const code =
      e instanceof AppError ? e.code : e instanceof z.ZodError ? 'VALIDATION_ERROR' : 'SERVER_ERROR';
    const requestId = diagnostics.recordError(request, code);
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
        requestId,
        message:
          e instanceof z.ZodError
            ? e.issues.map((i: any) => i.path.join('.') + ': ' + i.message).join('; ')
            : e.message,
        retryable: e instanceof AppError && e.retryable,
        details: e instanceof AppError ? e.details : null,
      });
  });
  if (options.surface !== 'terminal') registerLocalAgentRoutes(app, store, executor.gateway, prefix);
  /**
   * 修改入口的幂等包装：commandId 绑定路由和原始正文，重试返回已提交结果。
   * EN: Binds commandId to route and original body; idempotent retries return the committed result.
   */
  const command = <T>(body: unknown, route: string, fn: (b: any) => T) => {
    const b = Command.parse(body);
    return store.command(b.commandId, { route, body }, () => fn(body));
  };
  /**
   * 对覆盖式修改执行乐观并发检查，客户端缺失版本时不能按“最新”默默提交。
   * EN: Requires optimistic revisions for replacement writes rather than silently treating absent versions as current.
   */
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
  /**
   * 运行中的代理只能查看上下文，必须等当前请求和副作用结束后才允许配置窗口。
   * EN: Active agents can preview context, but configuration requires current requests and side effects to settle.
   */
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
  app.get('/api/diagnostics', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return diagnostics.snapshot();
  });
  registerWorkbench(app, store);
  registerReadiness(app, store, options.surface ?? 'native');
  registerTerminalLogSearchRoutes(app, store, artifactPreviews);
  if (options.surface !== 'native') registerTerminalSettings(app, store);
  if (terminalControl) {
    registerTerminalControl(app, terminalControl);
    registerCliManagement(app, store, terminal.cliManager);
    registerTerminalMaintenance(app, store, {
      snapshot: terminal.maintenanceSnapshot.bind(terminal),
      guard: terminal.withMaintenanceGuard.bind(terminal),
      /**
       * 合并原生调度快照和 Docker 宿主活动状态，维护操作必须等两者都停止。
       * EN: Combines native scheduler and Docker host activity so maintenance waits for both to stop.
       */
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
  /**
   * 给保存的配置附凭据是否配置的公开状态；按认证类型选择账号缓存或保险库检查，不返回密钥。
   * EN: Adds public credential-configuration state using auth-specific account caches or vault checks without returning secrets.
   */
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
    /**
     * 保存密钥前先验证命令和版本；命令存储仅保留正文哈希。
     * EN: Validate command/revision before saving secrets. Command storage retains only a hash of the body.
     */
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
    /**
     * 执行用户明确触发的最小模型调用并等待完整响应，再在命令事务内重查配置版本后保存验证状态；网络成功但配置变化也不能验证新版绑定。
     * EN: Runs an explicit minimal inference and requires completion, then revision-checks configuration inside the command transaction before saving verification; a late success cannot validate edited bindings.
     */
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
  const executionReadOnlyReason = '部分执行记录暂时无法读取，当前仅供查看。修复后请重试读取。';
  /**
   * 在幂等业务事务前核验恢复和执行记录可读性，使坏记录隔离独立保留；通过后才执行命令。
   * EN: Checks recovery/execution readability before the idempotent business transaction so damaged-record isolation survives rejection, then runs the command.
   */
  const executionCommand = <T>(runId: string, body: unknown, route: string, work: (body: any) => T) => {
    /**
     * 在业务事务外预检，使隔离损坏记录的结果不会随被拒绝的命令回滚。
     * EN: Preflight outside the business transaction so quarantined failures survive a rejected command.
     */
    store.recovery.assertReadable(runId);
    runReads.assertExecutionReadable(runId);
    return command(body, route, work);
  };
  registerRunRecordRoutes(app, store);
  registerTaskCenter(app, store);
  if (options.surface !== 'terminal') registerNativeInboxReceipts(app, store);
  if (options.surface !== 'terminal') {
    const jobParams = z.object({ id: z.string().uuid(), jobId: z.string().uuid() });
    const nativeJobRun = (runId: string) => {
      const run = store.require<Run>('runs', runId);
      invariant(run.execution?.kind !== 'docker-agent', 'NATIVE_JOBS_ONLY', '后台作业仅用于原生执行');
      return run;
    };
    app.get<{ Params: { id: string } }>('/api/runs/:id/jobs', async (request) => {
      const run = nativeJobRun(z.string().uuid().parse(request.params.id));
      const query = z.object({ before: z.string().uuid().optional() }).strict().parse(request.query);
      return { runId: run.id, ...executor.gateway.backgroundJobs.listPage(run.id, query.before) };
    });
    app.get('/api/runs/:id/jobs/:jobId', async (request) => {
      const { id, jobId } = jobParams.parse(request.params);
      nativeJobRun(id);
      return executor.gateway.backgroundJobs.read(id, jobId);
    });
    app.post('/api/runs/:id/jobs/:jobId/cancel', async (request) => {
      const { id, jobId } = jobParams.parse(request.params);
      const body = z
        .object({ commandId: z.string().uuid(), expectedRevision: z.number().int() })
        .strict()
        .parse(request.body);
      executionCommand(id, body, request.url, () => {
        const run = nativeJobRun(id);
        revision(body, run);
        management.assertMutable(run.id, run.projectId);
        invariant(
          !run.archived && !['DONE', 'CANCELLED'].includes(run.status),
          'INVALID_STATE',
          '已结束或归档的运行不能取消作业',
        );
        executor.gateway.backgroundJobs.read(id, jobId);
        return { jobId, accepted: true };
      });
      return executor.gateway.backgroundJobs.cancel(id, jobId);
    });
  }
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
        retryProjections: z.enum(['true', 'false']).optional(),
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
  /**
   * 核对运行执行资料可读、删除守卫及运行/项目非归档，返回当前运行供终端写操作使用。
   * EN: Checks execution readability, deletion guards and run/project archival before returning the run for terminal mutations.
   */
  const assertTerminalMutable = (runId: string) => {
    const run = store.require<Run>('runs', runId);
    runReads.assertExecutionReadable(run.id);
    management.assertMutable(run.id, run.projectId);
    invariant(
      !run.archived && (!run.projectId || !store.require<Project>('projects', run.projectId).archived),
      'ARCHIVED',
      '请先恢复归档的对话或项目',
    );
    return run;
  };
  if (options.surface !== 'native')
    registerTerminalCommunication(app, store, kernel, {
      /**
       * 复用恢复层和运行记录的完整可读检查，供终端命令在写入前统一拒绝残缺历史。
       * EN: Combines recovery and run-record readability checks so terminal commands reject incomplete history before writes.
       */
      assertReadable: (runId) => {
        store.recovery.assertReadable(runId);
        runReads.assertExecutionReadable(runId);
      },
      assertMutable: assertTerminalMutable,
    });
  /**
   * 终端验收采用准备/提交两阶段；异步核对完成后，命令事务内仍重查所有可变边界。
   * EN: Terminal acceptance uses prepare/commit phases; the command transaction rechecks mutable boundaries after asynchronous verification.
   */
  app.post<{ Params: { id: string } }>('/api/runs/:id/terminal/accept', async (request) => {
    const body = Command.extend({ expectedRevision: z.number().int().nonnegative() }).parse(request.body);
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
      return command(body, request.url, () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
    const run = store.require<Run>('runs', request.params.id);
    revision(body, run);
    runReads.assertExecutionReadable(run.id);
    management.assertMutable(run.id, run.projectId);
    invariant(
      !run.archived && (!run.projectId || !store.require<Project>('projects', run.projectId).archived),
      'ARCHIVED',
      '请先恢复归档的对话或项目',
    );
    invariant(!executorHasActive(executor, run.id), 'TERMINAL_ACTIVE', '请等待终端进程结束后再验收');
    const commit = await terminal.prepareAcceptance(run.id, body.expectedRevision);
    return executionCommand(run.id, body, request.url, () => {
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
    return executionCommand(run.id, body, request.url, () => {
      assertTerminalMutable(run.id);
      return commit();
    });
  });
  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/terminal/session',
    async (request): Promise<TerminalSessionView> => {
      const run = store.require<Run>('runs', request.params.id);
      if (options.surface === 'native' && run.execution?.kind === 'docker-agent')
        return {
          supported: false,
          canResume: false,
          canStartNew: false,
          revision: run.revision,
          reason: '旧版终端任务已保留为只读历史；请切换到 Agent 终端入口创建独立任务',
        };
      return terminal.sessionView(run.id);
    },
  );
  /**
   * 续接只消费用户明确选择的待收消息，事务提交后才释放本地停止标记并唤醒调度器。
   * EN: Continuation consumes only explicitly selected inbox messages; local stop flags clear and scheduling wakes only after commit.
   */
  app.post<{ Params: { id: string } }>('/api/runs/:id/terminal/continue', async (request) => {
    const body = Command.extend({
      expectedRevision: z.number().int().nonnegative(),
      mode: z.enum(['resume', 'new-session']),
      text: z.string().trim().max(60000),
      inboxIds: z.array(z.string().uuid()).max(100).default([]),
    })
      .strict()
      .refine((body) => !!body.text || body.inboxIds.length > 0, '请输入补充需求或选择待处理消息')
      .parse(request.body);
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
      return command(body, request.url, () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
    const run = assertTerminalMutable(request.params.id);
    invariant(options.surface !== 'native', 'TERMINAL_READ_ONLY', '旧终端记录仅供查看，请切换到 Agent 终端');
    revision(body, run);
    invariant(!executorHasActive(executor, run.id), 'TERMINAL_ACTIVE', '请等待终端进程结束后继续');
    const commit = await terminal.prepareContinuation(
      run.id,
      body.expectedRevision,
      body.mode,
      body.text,
      body.inboxIds,
    );
    const result = executionCommand(run.id, body, request.url, () => {
      assertTerminalMutable(run.id);
      invariant(!executorHasActive(executor, run.id), 'TERMINAL_ACTIVE', '请等待终端进程结束后继续');
      const result = commit();
      executor.releaseLocalStop(run.id);
      return result;
    });
    executor.resume(run.id);
    return result;
  });
  /**
   * 创建流程先解析模型和冻结执行配置，再在幂等事务中创建合同、来源和项目交付关联。
   * EN: Creation resolves models and freezes execution settings before idempotently creating the contract, source and project-delivery association.
   */
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
        allowSameModelReview: z.boolean().optional(),
        peerReview: Contract.shape.peerReview,
        toolReview: Contract.shape.toolReview,
        commandBackend: Contract.shape.commandBackend,
        sameModelReviewConfirmed: z.boolean().optional(),
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
        projectDelivery: ProjectDeliveryBinding.optional(),
        deliverables: RunDeliveryItems.optional(),
        acceptanceCriteria: RunDeliveryItems.optional(),
      })
      .parse(request.body);
    invariant(
      !body.allowSameModelReview ||
        (body.kind === 'task' && body.execution.kind === 'native' && body.sameModelReviewConfirmed === true),
      'REVIEW_MODEL_CONFIRMATION',
      '允许同模型审计需要用户明确确认，且仅适用于原生项目任务',
    );
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
      !body.projectDelivery ||
        (options.surface !== 'terminal' &&
          !!body.projectId &&
          body.kind === 'task' &&
          body.execution.kind === 'native'),
      'PROJECT_RUN_SCOPE',
      '项目交付项仅能关联本项目的原生任务',
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
        nonGoals: ['未经用户明确授权的发布、push或对外发送', '任务授权目录之外的写入', '未经授权的访问'],
        inputs: body.inputs,
        deliverables:
          body.deliverables ?? (body.kind === 'chat' ? ['聊天回复'] : ['可检查的文件、差异或报告']),
        acceptanceCriteria:
          body.acceptanceCriteria ??
          (body.kind === 'chat' ? ['回答用户消息'] : ['交付产物可读取，并有实际验证证据']),
        constraints: ['遵守用户指定的授权和预算'],
        allowSameModelReview: body.allowSameModelReview,
        peerReview: body.peerReview,
        toolReview: body.toolReview,
        commandBackend: body.commandBackend,
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
      const result = source ? attachRunSource(store, created, source) : created;
      if (source) kernel.event(result.id, 'run.updated', result);
      if (body.projectDelivery) attachProjectDeliveryRun(store, result, body.projectDelivery);
      return result;
    });
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/context', async (request) => {
    runReads.assertExecutionReadable(request.params.id);
    return contextBoundaries(kernel.contextSnapshot(request.params.id));
  });
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
    return executionCommand(request.params.id, body, request.url, () => {
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
    let run = store.require<Run>('runs', request.params.id);
    const query = z
      .object({
        messageLimit: z.coerce.number().int().min(40).max(240).optional(),
        beforeMessage: z.string().uuid().optional(),
        aroundMessage: z.string().uuid().optional(),
        retainedMessages: z.string().max(8880).optional(),
        view: z.literal('conversation').optional(),
        summary: z.literal('deferred').optional(),
        retryProjections: z.enum(['true', 'false']).optional(),
      })
      .strict()
      .parse(request.query);
    if (query.retryProjections === 'true') {
      await runReads.retry(run.id);
      run = store.require<Run>('runs', request.params.id);
    }
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
    const records =
      query.view === 'conversation' ? { tasks: runReads.tasks(run.id) } : runReads.executionRecords(run.id);
    const conversation =
      query.view === 'conversation'
        ? runReads.conversation(
            run,
            [...history.messages, ...store.messageConversationLinks(run.id, retainedMessages)],
            query.summary === 'deferred',
          )
        : undefined;
    let scope: 'all' | 'selected' = conversation ? 'selected' : 'all';
    let contexts: ContextSnapshot['agents'] = [];
    if (options.surface !== 'terminal' && query.summary !== 'deferred' && !runReads.hasUnavailable(run.id)) {
      try {
        contexts = contextBoundaries(kernel.contextSnapshot(run.id)).agents;
      } catch (error) {
        /**
         * 旧版上下文计算可能访问当前消息页之外更早的正文。
         * EN: Legacy context calculation may reach an older body outside this message page.
         */
        runReads.executionRecords(run.id);
        scope = 'all';
        if (!runReads.hasUnavailable(run.id)) throw error;
      }
    }
    const unavailable = runReads.hasUnavailable(run.id);
    /**
     * 首次用量投影后，上下文展开仍可能发现更早的损坏请求。
     * EN: Context expansion can discover an older damaged request after the first usage projection.
     */
    if (conversation && 'usageSummary' in conversation && unavailable)
      conversation.usageSummary = runReads.usage(run.id);
    return {
      run,
      eventCursor,
      ...(options.surface === 'terminal' && !unavailable
        ? {
            terminalRuntime: {
              executor: executor.runtimeSnapshot(run.id),
              terminal: terminal.runtimeSnapshot(run.id),
            },
          }
        : {}),
      readOnly: unavailable || (options.surface === 'native' && run.execution?.kind === 'docker-agent'),
      localExecutionStopped: executor.isLocallyStopped(run.id),
      executionHold: store.getExecutionHold(run.id),
      readOnlyReason: unavailable
        ? executionReadOnlyReason
        : options.surface === 'native' && run.execution?.kind === 'docker-agent'
          ? '旧版终端任务保留为只读历史，请在 Agent 终端入口创建独立任务'
          : null,
      tasks: records.tasks,
      currentQuestions: runReads.currentQuestions(run, records.tasks),
      agents: store.all<Agent>('agents', run.id),
      contexts,
      ...history,
      messages: history.messages.map(reasoningMessagePreview),
      ...(conversation
        ? conversation
        : {
            artifacts: store.all<Artifact>('artifacts', run.id),
            snapshots: store.all('snapshots', run.id),
            requests:
              'requests' in records ? records.requests.map((record) => runReads.requestPreview(record)) : [],
            operations: 'operations' in records ? records.operations : [],
            decisions: store.all('decisions', run.id),
          }),
      readCoverage: runReads.readCoverage(run.id),
      detailCoverage: runReads.detailCoverage(run.id, scope),
      ...runReads.eventPreview(run.id),
      edges: store.db
        .prepare(
          'SELECT task_id taskId,dependency_id dependencyId FROM task_edges WHERE task_id IN (SELECT id FROM tasks WHERE run_id=?)',
        )
        .all(run.id),
    };
  });
  /**
   * 普通消息可基于较早版本追加；合同/重规划属于覆盖式修改，必须匹配当前版本。
   * EN: Plain messages may append against an older revision; contract/replan replacements require the current revision.
   */
  app.post<{ Params: { id: string } }>('/api/runs/:id/messages', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        expectedRevision: z.number().int(),
        text: z.string().min(1).max(20000),
        intent: z.enum(['continue', 'replan']).optional(),
        /**
         * 命令指纹保持未提供字段缺省，兼容升级前请求的重试。
         * EN: Keep omitted fields omitted in the command fingerprint for pre-upgrade retries.
         */
        contract: Contract.extend({ allowSameModelReview: z.boolean().optional() }).optional(),
        sameModelReviewConfirmed: z.boolean().optional(),
      })
      .parse(request.body);
    const result = executionCommand(request.params.id, body, request.url, () => {
      const run = store.require<Run>('runs', request.params.id);
      const intent =
        body.contract && run.kind === 'task' && run.planMode !== false
          ? 'replan'
          : (body.intent ?? 'continue');
      /**
       * 普通消息只追加收件箱，不能覆盖运行；用户输入期间 流式状态可能推进版本。合同修改仍使用乐观并发校验。
       * EN: Plain messages append to the inbox and cannot overwrite a run; streaming status revisions may advance while the user is typing. Contract edits remain optimistic.
       */
      if (body.contract || intent === 'replan') revision(body, run);
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
          stable(body.contract.peerReview ?? null) === stable(run.contract.peerReview ?? null),
          'PEER_REVIEW_FROZEN',
          '评审模型、通过分数及轮次已冻结，请新建任务调整评审模式',
        );
        invariant(
          !body.contract.allowSameModelReview ||
            run.contract.allowSameModelReview === true ||
            (run.kind === 'task' && body.sameModelReviewConfirmed === true),
          'REVIEW_MODEL_CONFIRMATION',
          '请先确认同模型审计可能重复执行模型的盲点，再开启此选项',
        );
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
        kernel.updateRun(run, { contract: Contract.parse(body.contract) });
      }
      return kernel.inbox(run.id, body.text, { intent });
    });
    if (store.require<Run>('runs', request.params.id).execution?.kind !== 'docker-agent')
      executor.resume(request.params.id);
    return result;
  });
  /**
   * 模型目录解析和计划模块加载在事务外，最终 accept 负责重新验证计划版本及模型绑定。
   * EN: Model catalog resolution and planning modules load outside transactions; accept revalidates the plan revision and model bindings.
   */
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
    runReads.assertExecutionReadable(run.id);
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
    const choices = run.plan.tasks.map((task) => body.assignments.find((a) => a.key === task.key) ?? task);
    const resolved = await resolveModelChoices(store, subscription, codex, choices, apiCatalog);
    const bindings = new Map(run.plan.tasks.map((task, index) => [task.key, resolved[index]]));
    const result = executionCommand(run.id, body, request.url, () =>
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
  /**
   * start/pause/resume 等状态规则交给应用服务；宿主取消和唤醒放在状态提交之后执行。
   * EN: Application services own start/pause/resume rules; host cancellation and wake-up follow state commit.
   */
  app.post<{ Params: { id: string } }>('/api/runs/:id/actions', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        expectedRevision: z.number().int(),
        action: z.enum(['start', 'pause', 'resume', 'cancel', 'switch_model', 'resume_task', 'stop_current']),
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
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId)) {
      const result = command(body, request.url, () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
      if (body.action !== 'stop_current') return result;
      const localExecutionStopped = executor.isLocallyStopped(request.params.id);
      return {
        ...(result as RunStopCurrentResult),
        replayed: true,
        localExecutionStopped,
        message: localExecutionStopped
          ? '这是原停止命令的历史结果；当前仍存在执行抑制，持久状态请以当前任务提示为准。本次重放未重复停止。'
          : '这是原停止命令的历史结果；当前没有执行抑制。本次重放未再次停止执行，如需停止请发起新的停止操作。',
      } satisfies RunStopCurrentResult;
    }
    if (body.action === 'stop_current') {
      /**
       * 停止优先于严格版本匹配：允许用户根据较早但真实的视图及时阻止当前副作用。
       * EN: Stop takes precedence over strict revision matching so an older genuine view can still halt current effects promptly.
       */
      const run = store.require<Run>('runs', request.params.id);
      management.assertMutable(run.id, run.projectId);
      invariant(!body.taskId, 'STOP_RUN_SCOPE', '停止当前执行作用于本机当前任务，不能指定其他代理');
      invariant(
        body.expectedRevision >= 0 && body.expectedRevision <= run.revision,
        'REVISION_CONFLICT',
        '任务版本已变化，请重新读取',
      );
      const stopped = await executor.stopCurrent(run.id);
      return command(body, request.url, () => stopped);
    }
    runReads.assertExecutionReadable(request.params.id);
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
    let releasedFinishedHold = false;
    const result = executionCommand(request.params.id, body, request.url, () => {
      const applied = runService.apply(request.params.id, body, binding);
      releasedFinishedHold = applied.releasedFinishedHold;
      return applied.result;
    });
    await runService.afterAction(request.params.id, body, releasedFinishedHold);
    return result;
  });
  /**
   * 这里只处理原生工具和请求的人工核验；容器停止及文件证据必须走终端专用核验入口。
   * EN: Handles manual verification of native tools/requests only; container shutdown and file evidence require terminal-specific verification.
   */
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
        processStopped: z.boolean().optional(),
      })
      .parse(request.body);
    return executionCommand(request.params.id, body, request.url, () => {
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
        let op = store.require<Operation>('tool_operations', body.operationId);
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
        if (op.name === 'job_execution') {
          const job = executor.gateway.backgroundJobs.findByOperation(run.id, op.id);
          invariant(job, 'JOB_NOT_FOUND', '后台作业证据缺失，不能放行');
          if (!job.stopConfirmed) {
            invariant(body.processStopped === true, 'JOB_STOP_EVIDENCE', '请先核验进程已停止，再确认副作用');
            executor.gateway.backgroundJobs.confirmStopped(run.id, job.id, body.note);
            op = store.require<Operation>('tool_operations', op.id);
          }
        }
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
  /**
   * 持久事件通过游标补读，临时文本增量只供实时展示；两者都受每连接输出预算约束。
   * EN: Replays persistent events by cursor and exposes ephemeral text deltas only live; both share per-connection output budgets.
   */
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
    automation,
  );
  if (options.surface !== 'terminal') registerWorkflow(app, store, management.assertMutable);
  if (automation) registerAutomationPluginRoutes(app, automation, management.assertMutable);
  if (options.surface !== 'terminal') registerModelRouting(app, store, management.assertMutable);
  if (options.surface !== 'terminal') registerProjectIntelligenceRoutes(app, store, management.assertMutable);
  if (options.surface !== 'terminal')
    registerTaskWorkingStateRoutes(app, store, kernel, management.assertMutable, (runId) =>
      runReads.assertExecutionReadable(runId),
    );
  if (options.surface !== 'terminal') registerProjectDelivery(app, store, management.assertMutable);
  if (options.surface !== 'terminal') registerProjectUsage(app, store);
  const scheduler =
    options.surface === 'terminal'
      ? undefined
      : registerProjectSchedules(app, store, kernel, {
          assertMutable: management.assertMutable,
          /**
           * 将已提交的计划创建结果交给执行器唤醒，实际可运行性仍由调度守卫判断。
           * EN: Wakes the executor after schedule creation commits; scheduler guards still decide run eligibility.
           */
          resume: (runId) => executor.resume(runId),
          /**
           * 记录计划检查的安全领域错误，诊断不承担任务重试或状态修改。
           * EN: Logs safe schedule-check domain errors without retrying tasks or mutating state.
           */
          onError: (error) => {
            diagnostics.backgroundError(error);
            app.log.error(error, '项目定时任务检查失败');
          },
        });
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
  executor.onReasoningDelta = (value) => {
    /**
     * JSON 可将每个 UTF-16 单元转义为六字节；每个公开增量必须低于帧上限。
     * EN: JSON can escape each UTF-16 unit to six bytes; keep every public delta under the frame bound.
     */
    for (let offset = 0; offset < value.text.length; ) {
      const end = reasoningPrefixLength(value.text, offset + 8192);
      if (end <= offset) break;
      const frame =
        'event: message.reasoning.delta\ndata: ' +
        JSON.stringify({ ...value, text: value.text.slice(offset, end), offset: value.offset + offset }) +
        '\n\n';
      for (const stream of streams.get(value.runId) ?? []) boundedStreams.get(stream)?.write(frame, true);
      offset = end;
    }
  };
  /**
   * Last-Event-ID 优先于查询游标；只有帧成功交给有界流时才推进 after，防止背压时漏事件。
   * EN: Last-Event-ID overrides the query cursor; after advances only once the bounded stream accepts a frame, preserving events under backpressure.
   */
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
      /**
       * 仅在有界 SSE 流可写时按持久游标补读事件；成功接受一帧才推进 after，背压时留待下一次排空。
       * EN: Replays persisted events only while bounded SSE is writable, advancing after only once a frame is accepted and resuming after drain.
       */
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
  const webRoot = process.env.ELYSIA_WEB_ROOT || path.join(process.cwd(), 'apps', 'web', 'dist');
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
  /**
   * 先停止新定时任务并关闭事件连接，再并行等待凭据通道和执行器退出；局部失败仍尝试其余关闭。
   * EN: Stops new schedules and closes event streams before awaiting credential channels and executors in parallel; each close still runs after another fails.
   */
  app.addHook('preClose', async () => {
    scheduler?.stop();
    for (const set of streams.values()) for (const stream of set) stream.end();
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => automation?.close()),
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
    providerPlugins,
    automation,
    scheduler,
    auth,
    bootstrapToken,
    origins,
    /**
     * 将已由宿主指定的前端来源及其 Host 加入当前会话允许集合。
     * EN: Adds the host-supplied frontend origin and Host to this session's allowlists.
     */
    allowFrontendOrigin: (origin: string) => {
      origins.add(origin);
      hosts.add(new URL(origin).host);
    },
    /**
     * 把当前引导令牌有效期延长到此刻后十五分钟，供宿主重新展示启动入口。
     * EN: Extends bootstrap expiry to fifteen minutes from now for host reopening of the launch entry.
     */
    refreshBootstrapExpiry: () => {
      auth.bootstrapExpires = Date.now() + 15 * 60000;
    },
  };
}
/**
 * 识别资源预览路由并保留已设置的字符串 CSP，缺失时返回最小沙箱策略；普通路由返回 undefined 由工作台策略处理。
 * EN: Recognizes preview routes, preserves existing string CSP or supplies minimal sandbox policy; ordinary routes return undefined for workbench policy.
 */
function requestPreviewPolicy(url: string, policy: unknown) {
  return url.startsWith('/preview/') ||
    /^\/api\/projects\/[^/]+\/(?:resources\/|files\/resource(?:\?|$))/.test(url) ||
    /^\/api\/artifacts\/[^/?]+(?:\?|$)/.test(url)
    ? typeof policy === 'string'
      ? policy
      : "default-src 'none'; sandbox; frame-ancestors 'self'"
    : undefined;
}
/**
 * 兼容读取执行器活动映射并判断运行/任务占用；无活动映射时返回其缺省假值。
 * EN: Compatibly checks executor active-map occupancy for a run/optional task, returning a falsy default when the map is absent.
 */
function executorHasActive(executor: NativeExecutor, runId: string, taskId?: string) {
  return executor.hasActiveWork(runId, taskId);
}
