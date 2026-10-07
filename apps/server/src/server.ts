import Fastify from 'fastify';
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
} from '../../../packages/contracts/src/index.js';
import { Store, id, now, stable } from '../../../packages/storage/src/index.js';
import { Kernel } from '../../../packages/kernel/src/index.js';
import { NativeExecutor } from '../../../packages/runtime/src/index.js';
import { NativeProvider } from '../../../packages/providers/src/index.js';
import { PreviewService } from './preview.js';
import { SubscriptionService } from './subscription.js';
import { desktopServices } from './desktop.js';
import { inspectFolder, projectFiles, sameDirectory } from './projects.js';
import { CodexSubscription } from './codex-subscription.js';
import { ProviderKeys } from './provider-keys.js';
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
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      account: 'deepseek-default',
      contextLimit: 32000,
      outputLimit: 4096,
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
  },
) {
  const app = Fastify({ logger: false, bodyLimit: 3 * 1024 * 1024 });
  const kernel = new Kernel(store),
    executor = new NativeExecutor(kernel);
  const subscription = options.subscription ?? new SubscriptionService(desktopServices());
  const codex = options.codex ?? new CodexSubscription(store.directory, desktopServices());
  const keys = options.keys ?? new ProviderKeys(desktopServices());
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
  executor.adapterFactory = (agent) => providerAdapter(agent.providerBinding);
  for (const config of defaultProviders())
    if (!store.get('providers', config.id)) store.put('providers', config);
  const bootstrapToken = randomBytes(32).toString('hex'),
    sessions = new Map<string, string>();
  let bootstrapUsed = false;
  let bootstrapExpires = Date.now() + 15 * 60000;
  const origins = new Set([
    `http://127.0.0.1:${options.port}`,
    ...(options.dev ? ['http://127.0.0.1:5173'] : []),
  ]);
  const hosts = new Set([`127.0.0.1:${options.port}`, ...(options.dev ? ['127.0.0.1:5173'] : [])]);
  const previews = new PreviewService(store, executor.gateway);
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
    // Capability-scoped sandbox frames have opaque origins and no app session.
    if (request.url.startsWith('/preview/')) return;
    const origin = request.headers.origin;
    if (origin) invariant(origins.has(origin), 'ORIGIN_DENIED', 'Origin 不允许');
    const pathname = request.url.split('?')[0];
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
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        requestPreviewPolicy(_request.url, reply.getHeader('Content-Security-Policy')) ??
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'",
      );
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as any;
    const code =
      e instanceof AppError ? e.code : e instanceof z.ZodError ? 'VALIDATION_ERROR' : 'SERVER_ERROR';
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
  app.get('/api/health', async () => ({ version: VERSION, status: 'ok' }));
  app.get<{ Params: { runId: string; taskId: string } }>(
    '/api/runs/:runId/tasks/:taskId/preview',
    async (request) => previews.snapshot(request.params.runId, request.params.taskId),
  );
  app.get<{ Params: { runId: string; taskId: string }; Querystring: { path: string } }>(
    '/api/runs/:runId/tasks/:taskId/preview/file',
    async (request) =>
      previews.file(
        request.params.runId,
        request.params.taskId,
        z.string().min(1).max(1000).parse(request.query.path),
      ),
  );
  app.get<{ Params: { token: string; '*': string } }>('/preview/:token/*', async (request, reply) => {
    const result = await previews.resource(request.params.token, request.params['*']);
    const base = `http://${request.headers.host}/preview/${request.params.token}/`;
    reply
      .header('Cache-Control', 'no-store')
      .header('Access-Control-Allow-Origin', '*')
      .header(
        'Content-Security-Policy',
        `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${base}; style-src 'unsafe-inline' ${base}; img-src data: ${base}; font-src ${base}; media-src ${base}; connect-src ${base}; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri ${base}; frame-ancestors 'self'`,
      )
      .type(result.mediaType);
    return result.bytes;
  });
  app.post('/api/session', async (request, reply) => {
    const body = z.object({ token: z.string() }).parse(request.body);
    const a = Buffer.from(body.token),
      b = Buffer.from(bootstrapToken);
    invariant(
      !bootstrapUsed && Date.now() < bootstrapExpires && a.length === b.length && timingSafeEqual(a, b),
      'BOOTSTRAP_EXPIRED',
      '引导令牌无效、过期或已使用',
    );
    bootstrapUsed = true;
    const session = randomBytes(32).toString('hex'),
      csrf = randomBytes(32).toString('hex');
    sessions.set(session, csrf);
    reply.header('Set-Cookie', `elysia_session=${session}; HttpOnly; SameSite=Strict; Path=/api`);
    return { csrf, version: VERSION };
  });
  app.get('/api/session', async (request) => ({
    csrf: sessions.get(cookieSession(request.headers.cookie)!),
    version: VERSION,
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
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/files',
    async (request) =>
      projectFiles(store, request.params.id, z.string().max(4096).default('.').parse(request.query.path)),
  );
  app.post('/api/projects', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        name: z.string().min(1).max(80),
        mode: z.enum(['code', 'work']),
        workspaceRoot: z.string().min(1),
        baseline: z.string().optional(),
      })
      .parse(request.body);
    const folder = await inspectFolder(body.workspaceRoot, executor.gateway.processes);
    const root = folder.workspaceRoot;
    let baseline: string | null = folder.codeAvailable ? folder.baseline : null;
    if (body.mode === 'code' && body.baseline && body.baseline !== 'HEAD') {
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
    invariant(
      body.mode !== 'code' || (baseline && folder.codeAvailable),
      'GIT_REQUIRED',
      'Code 模式需要选择有提交的 Git 根目录；普通文件夹可使用 Work 模式',
    );
    return command(body, '/projects', () => {
      const existing = store.all<Project>('projects').find((p) => sameDirectory(p.workspaceRoot, root));
      if (existing) return existing;
      return store.put<Project>('projects', {
        id: id(),
        revision: 0,
        name: body.name,
        mode: body.mode,
        workspaceRoot: root,
        baseline,
        configVersion: 1,
      });
    });
  });
  app.get('/api/providers', async () => {
    await subscription.status().catch(() => {});
    const providers = store.all<ProviderConfig>('providers').filter((p) => !p.archived);
    const sources = new Set(
      providers.filter((p) => p.authMode === 'codex').map((p) => codex.source(p.subscriptionAccountId!)),
    );
    await Promise.all([...sources].map((s) => codex.status(s)));
    return Promise.all(
      providers.map(async (p) => ({
        ...p,
        keyConfigured:
          p.authMode === 'codex'
            ? codex.configured(p.subscriptionAccountId)
            : p.authMode === 'chatgpt'
              ? subscription.configured(p.subscriptionAccountId)
              : await keys.configured(p),
      })),
    );
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
      return command(body, request.url, () => ({}));
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
    return command(body, request.url, () => {
      const old = store.get<ProviderConfig>('providers', config.id);
      if (old) revision(body, old);
      return store.put(
        'providers',
        { ...config, revision: old?.revision ?? 0, checkedRevision: null },
        old?.revision ?? 0,
      );
    });
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
    if (config.authMode === 'codex') return codex.models(config.subscriptionAccountId!);
    if (config.authMode === 'chatgpt') return subscription.models(config.subscriptionAccountId!);
    const { token } = await keys.credential(config);
    let response: Response;
    try {
      response = await fetch(config.baseUrl.replace(/\/$/, '') + '/models', {
        headers: { Authorization: 'Bearer ' + token },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new AppError('MODEL_CATALOG', '无法读取模型目录，请检查端点与网络；也可手动填写模型 ID');
    }
    invariant(response.ok, 'MODEL_CATALOG', `模型目录返回 HTTP ${response.status}，也可手动填写模型 ID`);
    const raw = await response.text();
    invariant(raw.length <= 2 * 1024 * 1024, 'MODEL_CATALOG', '模型目录超过大小限制');
    const data = JSON.parse(raw);
    return z
      .array(z.object({ id: z.string().min(1), name: z.string().optional() }))
      .max(2000)
      .parse(data.data)
      .map((m) => ({ id: m.id, name: m.name || m.id }));
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
      const adapter = providerAdapter(provider);
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
  app.get('/api/runs', async () => store.all<Run>('runs').reverse());
  app.post('/api/runs', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        projectId: z.string(),
        objective: z.string().min(1).max(20000),
        providerId: z.string(),
        permissionProfile: Permissions,
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
      })
      .parse(request.body);
    return command(body, '/runs', () => {
      const project = store.require<Project>('projects', body.projectId),
        provider = store.require<ProviderConfig>('providers', body.providerId);
      const contract = Contract.parse({
        objective: body.objective,
        scope: [body.objective],
        nonGoals: ['发布、push、修改主目录', '未经授权的访问'],
        inputs: body.inputs,
        deliverables: ['可检查的文件、差异或报告'],
        acceptanceCriteria: ['交付产物可读取，并有实际验证证据'],
        constraints: ['遵守用户指定的授权和预算'],
        mode: project.mode,
        permissionProfile: body.permissionProfile,
        budget: body.budget,
        assumptions: [],
      });
      return kernel.createRun(project, body.objective, provider, contract, body.limits);
    });
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    const run = store.require<Run>('runs', request.params.id);
    return {
      run,
      tasks: store.all<Task>('tasks', run.id),
      agents: store.all<Agent>('agents', run.id),
      messages: store.all<Message>('messages', run.id),
      artifacts: store.all<Artifact>('artifacts', run.id),
      snapshots: store.all('snapshots', run.id),
      requests: store.all<RequestRecord>('requests', run.id),
      operations: store.all<Operation>('tool_operations', run.id),
      decisions: store.all('decisions', run.id),
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
      revision(body, run);
      invariant(!['DONE', 'CANCELLED'].includes(run.status), 'INVALID_STATE', '运行已结束');
      if (body.contract) {
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
      .object({ commandId: z.string().uuid(), expectedRevision: z.number().int(), version: z.number().int() })
      .parse(request.body);
    const result = command(body, request.url, () =>
      kernel.accept(request.params.id, body.version, body.expectedRevision),
    );
    executor.resume(request.params.id);
    return result;
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/actions', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        expectedRevision: z.number().int(),
        action: z.enum(['start', 'pause', 'resume', 'cancel']),
        taskId: z.string().optional(),
        providerId: z.string().optional(),
      })
      .parse(request.body);
    const result = command(body, request.url, () => {
      const run = store.require<Run>('runs', request.params.id);
      revision(body, run);
      if (body.providerId) {
        invariant(
          body.taskId && !executorHasActive(executor, run.id),
          'MODEL_SWITCH_BOUNDARY',
          '切换模型需要先暂停运行，并指定任务',
        );
        const task = store.require<Task>('tasks', body.taskId),
          binding = store.require<ProviderConfig>('providers', body.providerId);
        invariant(
          task.runId === run.id &&
            binding.checkedRevision === binding.revision &&
            ['WAITING', 'FAILED'].includes(task.status),
          'MODEL_SWITCH_DENIED',
          '模型未验证或任务未在安全边界',
        );
        const agent = store.require<Agent>('agents', task.agentId);
        for (const a of store
          .all<Attempt>('attempts', run.id)
          .filter((a) => a.taskId === task.id && ['ACTIVE', 'WAITING'].includes(a.status)))
          store.put('attempts', { ...a, status: 'FAILED', lease: null, error: '显式模型切换' });
        store.put('agents', { ...agent, providerId: binding.id, providerBinding: binding, sessionId: id() });
        kernel.appendMessage(
          task,
          'user',
          '模型切换交接包：' +
            stable({
              task: task.spec,
              result: task.result,
              artifactIds: store.all<Artifact>('artifacts', run.id).map((a) => a.id),
              constraints: run.contract.constraints,
            }),
        );
      }
      return kernel.action(run.id, body.action, body.taskId);
    });
    if (['pause', 'cancel'].includes(body.action)) await executor.interrupt(request.params.id, body.taskId);
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
      invariant(body.operationId || body.requestId, 'DECISION_TARGET', '需要具体操作或请求引用');
      if (body.operationId) {
        const op = store.require<Operation>('tool_operations', body.operationId);
        invariant(
          op.runId === run.id && op.status === 'UNCERTAIN',
          'DECISION_SCOPE',
          '操作不属于当前待核验集合',
        );
        const updated = store.put('tool_operations', {
          ...op,
          status: body.outcome === 'confirmed' ? 'DONE' : 'FAILED',
          result: body.result ?? { note: body.note, userVerified: true },
        });
        const task = store.require<Task>('tasks', op.taskId);
        if (
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
      kernel.updateRun(store.require('runs', run.id), { status: 'READY', reason: undefined });
      return decision;
    });
  });
  const streams = new Map<string, Set<any>>();
  executor.onDelta = (runId, taskId, text) => {
    for (const stream of streams.get(runId) ?? [])
      stream.write('event: message.delta\ndata: ' + JSON.stringify({ runId, taskId, text }) + '\n\n');
  };
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/runs/:id/events',
    async (request, reply) => {
      store.require<Run>('runs', request.params.id);
      const runId = request.params.id;
      let after = Math.max(Number(request.query.after ?? request.headers['last-event-id'] ?? 0), 0);
      invariant(Number.isSafeInteger(after), 'EVENT_CURSOR', '事件游标无效');
      reply.hijack();
      const stream = reply.raw;
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
        for (const event of store.events(runId, after)) {
          stream.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          after = event.seq;
        }
      };
      flush();
      const timer = setInterval(flush, 350),
        heartbeat = setInterval(() => stream.write(': heartbeat\n\n'), 15000);
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
      .type(artifact.mediaType);
    return store.readObject(artifact.objectRef);
  });
  const webRoot = path.join(process.cwd(), 'apps', 'web', 'dist');
  if (existsSync(webRoot)) {
    void app.register(staticFiles, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api'))
        return reply
          .code(404)
          .send({ code: 'NOT_FOUND', message: '接口不存在', retryable: false, details: null });
      return reply.sendFile('index.html');
    });
  } else
    app.get('/', async () => ({ message: '前端未构建，执行 pnpm build 或使用 pnpm dev', version: VERSION }));
  app.addHook('preClose', async () => {
    for (const set of streams.values()) for (const stream of set) stream.end();
    await codex.close();
    await subscription.close();
    await executor.dispose();
  });
  return {
    app,
    kernel,
    executor,
    bootstrapToken,
    origins,
    allowFrontendOrigin: (origin: string) => {
      origins.add(origin);
      hosts.add(new URL(origin).host);
    },
    refreshBootstrapExpiry: () => {
      bootstrapExpires = Date.now() + 15 * 60000;
    },
  };
}
function requestPreviewPolicy(url: string, policy: unknown) {
  return url.startsWith('/preview/')
    ? typeof policy === 'string'
      ? policy
      : "default-src 'none'; sandbox; frame-ancestors 'self'"
    : undefined;
}
function executorHasActive(executor: NativeExecutor, runId: string) {
  return (
    (executor as any).active && [...(executor as any).active.values()].some((a: any) => a.runId === runId)
  );
}
