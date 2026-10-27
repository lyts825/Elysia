/**
 * 管理 Codex 订阅连接及模型信息。
 * 隔离本机与应用账号，每次推理核对冻结身份并创建只读线程；工具只返回意图，由 Elysia 网关按授权执行。
 * EN: Manages Codex subscription connections and model metadata. Separates local/app accounts and verifies frozen identity in per-inference read-only threads; tools return intents for authorized Elysia gateway execution.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, invariant, type ProviderConfig } from '../../../packages/contracts/src/index.js';
import { type CompiledContext } from '../../../packages/context/src/index.js';
import { CODEX_STEP_GUIDANCE } from '../../../packages/context/src/harness.js';
import {
  normalizeUsage,
  ProviderError,
  type ProviderAdapter,
  type ProviderEvent,
} from '../../../packages/providers/src/index.js';
import type { DesktopServices } from './desktop.js';
import { CodexRpc, codexConfig, findCodex, cleanError } from './codex-rpc.js';

type Source = 'local' | 'elysia';
type Connection = {
  source: Source;
  available: boolean;
  connected: boolean;
  version?: string;
  accountId?: string;
  label?: string;
  plan?: string;
  message?: string;
};
export type CodexModel = {
  id: string;
  name: string;
  description: string;
  efforts: string[];
  defaultEffort: string;
  isDefault: boolean;
  hidden: boolean;
  inputModalities: string[];
};
type Attempt = {
  id: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  message?: string;
  userCode?: string;
};

/**
 * 管理本地及订阅会话、登录状态和模型推理请求；关闭时终止在途连接。
 * EN: Manages local/subscription sessions, login state, and inference requests; shutdown closes in-flight connections.
 */
export class CodexSubscription {
  private sessions = new Map<Source, Promise<CodexRpc>>();
  private connections = new Map<Source, Connection>();
  private versions = new Map<Source, string>();
  private inflight = new Map<CodexRpc, Source>();
  private attempt?: Attempt;
  private closed = false;
  private startingLogin = false;
  /**
   * 绑定应用数据目录和可选桌面服务，延迟建立 Codex 会话与账号状态。
   * EN: Binds the data directory and optional desktop service, deferring Codex sessions/account state until use.
   */
  constructor(
    private directory: string,
    private desktop?: DesktopServices,
  ) {}
  /**
   * 仅为应用自管账号返回隔离 CODEX_HOME，本机账号沿用 CLI 默认目录。
   * EN: Returns isolated CODEX_HOME only for app-managed accounts; local accounts retain the CLI default.
   */
  private home(source: Source) {
    return source === 'elysia' ? path.join(this.directory, 'codex-home') : undefined;
  }
  /**
   * 发现 Codex 并准备隔离桥接目录，初始化 RPC 后登记活动连接；初始化失败或关闭竞争时立即释放子进程。
   * EN: Discovers Codex, prepares bridge directories and registers an initialized RPC connection; initialization failure or shutdown races close the child promptly.
   */
  private async open(source: Source) {
    invariant(!this.closed, 'CODEX_CLOSED', '订阅连接已关闭');
    const runtime = await findCodex();
    const cwd = path.join(this.directory, 'codex-bridge');
    await fs.mkdir(cwd, { recursive: true });
    const home = this.home(source);
    if (home) await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const rpc = new CodexRpc(runtime.binary, cwd, home);
    this.inflight.set(rpc, source);
    rpc.once('closed', () => this.inflight.delete(rpc));
    try {
      await rpc.initialize();
    } catch (e) {
      rpc.close();
      throw e;
    }
    if (this.closed) {
      rpc.close();
      throw new AppError('CODEX_CLOSED', '订阅连接已关闭');
    }
    return { rpc, version: runtime.version, cwd };
  }
  /**
   * 同来源的账号/目录操作共享 RPC；连接关闭只删除其自身缓存，旧失败不能清除后建会话。
   * EN: Account and catalog operations for the same source share RPC. Closing a connection removes only its own cache entry, so old failures cannot erase a newer session.
   */
  private session(source: Source) {
    if (!this.sessions.has(source)) {
      const promise = this.open(source)
        .then(({ rpc, version }) => {
          this.versions.set(source, version);
          this.connections.set(source, { source, available: true, connected: false, version });
          rpc.on('notification', (event) => {
            if (event.method === 'account/login/completed' && event.params.loginId === this.attempt?.id) {
              this.attempt = {
                ...this.attempt!,
                status: event.params.success ? 'completed' : 'failed',
                message: event.params.success ? '登录成功，请刷新账号和模型' : cleanError(event.params.error),
              };
            }
            if (event.method === 'account/updated') this.connections.delete(source);
          });
          rpc.once('closed', () => {
            if (this.sessions.get(source) === promise) this.sessions.delete(source);
            this.connections.delete(source);
          });
          return rpc;
        })
        .catch((e) => {
          this.sessions.delete(source);
          throw e;
        });
      this.sessions.set(source, promise);
    }
    return this.sessions.get(source)!;
  }
  /**
   * 将 CLI 账号响应转为公开连接描述；仅 ChatGPT 身份可连接，并由规范化邮箱派生稳定账号 ID，缺失身份则拒绝。
   * EN: Maps CLI account data to public connection state. Only ChatGPT identities connect; normalized email derives the stable ID, and missing identity is rejected.
   */
  private account(source: Source, account: any, version?: string): Connection {
    if (account?.type !== 'chatgpt')
      return {
        source,
        available: true,
        connected: false,
        version,
        message:
          account?.type === 'apiKey'
            ? '此 Codex 环境正在使用 API Key，请选择 ChatGPT 登录'
            : '尚未使用 ChatGPT 登录',
      };
    invariant(
      typeof account.email === 'string' && account.email.length > 0,
      'CODEX_IDENTITY',
      'Codex 未返回可识别账号，请更新 Codex 后重新连接',
    );
    return {
      source,
      available: true,
      connected: true,
      version,
      accountId: `codex-${source}-${createHash('sha256').update(account.email.toLowerCase()).digest('hex').slice(0, 24)}`,
      label: account.email,
      plan: account.planType,
    };
  }
  /**
   * 读取实际账号并更新连接缓存；可重建本机会话，失败返回不可用状态及登录尝试而不保留旧的已连接判断。
   * EN: Reads the actual account and updates connection cache, optionally recreating the local session. Failures return unavailable state/login attempt and remove stale connected state.
   */
  async status(source: Source = 'local', refresh = false) {
    if (refresh && source === 'local') {
      const old = this.sessions.get(source);
      this.sessions.delete(source);
      (await old?.catch(() => undefined))?.close();
    }
    try {
      const rpc = await this.session(source);
      const result = await rpc.call('account/read', { refreshToken: false });
      const state = this.account(source, result.account, this.versions.get(source));
      this.connections.set(source, state);
      return { ...state, attempt: source === 'elysia' ? this.attempt : undefined };
    } catch (e) {
      this.connections.delete(source);
      return {
        source,
        available: false,
        connected: false,
        message: (e as Error).message,
        attempt: source === 'elysia' ? this.attempt : undefined,
      };
    }
  }
  /**
   * 验证冻结账号 ID 的格式并恢复 local/elysia 来源；任意客户端字符串不能选择其他来源。
   * EN: Validates a frozen account ID and recovers its local/elysia source; arbitrary client strings cannot select another source.
   */
  source(accountId: string): Source {
    invariant(
      /^codex-(local|elysia)-[a-f0-9]{24}$/.test(accountId),
      'CODEX_ACCOUNT',
      '请选择 Codex 订阅连接',
    );
    return accountId.startsWith('codex-local-') ? 'local' : 'elysia';
  }
  /**
   * 仅按最近已确认连接判断指定账号是否配置，不触发进程或令牌刷新。
   * EN: Checks the latest confirmed connection cache for an account without launching processes or refreshing tokens.
   */
  configured(accountId?: string | null) {
    return (
      !!accountId && [...this.connections.values()].some((c) => c.connected && c.accountId === accountId)
    );
  }
  /**
   * 每次使用前回读实际登录账号，配置中的账号 ID 不能自动跟随用户在 Codex 中切换身份。
   * EN: Rereads the actual login account before use; a configured account ID cannot silently follow an identity switch in Codex.
   */
  private async requireAccount(id: string) {
    const source = this.source(id),
      state = await this.status(source);
    invariant(
      state.connected && state.accountId === id,
      'CODEX_ACCOUNT_CHANGED',
      state.message || 'Codex 账号已改变，请重新选择账号并验证模型配置',
    );
    return source;
  }
  /**
   * 有界分页读取完整模型目录并拒绝重复游标；型号、思考强度由真实目录而非静态猜测决定。
   * EN: Reads complete catalogs with bounded pagination and rejects repeated cursors. Actual catalogs determine models and reasoning efforts rather than static guesses.
   */
  private async catalog(rpc: CodexRpc): Promise<CodexModel[]> {
    const all: CodexModel[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const seen = new Set<string>();
    do {
      invariant(++pages <= 100, 'CODEX_CATALOG', '模型目录分页超过限制，请更新 Codex');
      const result = await rpc.call('model/list', {
        limit: 100,
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      });
      invariant(Array.isArray(result.data), 'CODEX_CATALOG', 'Codex 未返回模型目录');
      for (const m of result.data)
        if (typeof m.model === 'string' && m.model.length && !all.some((item) => item.id === m.model))
          all.push({
            id: m.model,
            name: m.displayName || m.model,
            description: m.description || '',
            efforts: (m.supportedReasoningEfforts || []).map((e: any) => e.reasoningEffort),
            defaultEffort: m.defaultReasoningEffort,
            isDefault: !!m.isDefault,
            hidden: !!m.hidden,
            inputModalities: Array.isArray(m.inputModalities) ? m.inputModalities : ['text', 'image'],
          });
      cursor = result.nextCursor || undefined;
      invariant(!cursor || !seen.has(cursor), 'CODEX_CATALOG', '模型目录分页异常');
      if (cursor) seen.add(cursor);
      invariant(!cursor || all.length < 1000, 'CODEX_CATALOG', '模型目录超过分页限制，请更新 Codex');
    } while (cursor);
    return all;
  }
  /**
   * 重新确认账号身份后读取其真实模型目录；身份改变或分页失败向上传递。
   * EN: Reconfirms account identity before reading its actual model catalog, propagating identity/catalog failures.
   */
  async models(id: string) {
    return this.catalog(await this.session(await this.requireAccount(id)));
  }
  /**
   * 重新确认冻结账号后读取 Codex 额度，不从本机缓存推算剩余额度。
   * EN: Reconfirms the frozen account before reading Codex rate limits instead of estimating remaining usage from local cache.
   */
  async usage(id: string) {
    return await (await this.session(await this.requireAccount(id))).call('account/rateLimits/read', {});
  }
  /**
   * 拒绝重叠登录并要求桌面服务，启动浏览器/设备授权后打开可信登录页；失败取消已开始的尝试并释放启动标记。
   * EN: Rejects overlapping login and requires desktop support, starts browser/device authorization and opens its URL. Failure cancels a started attempt and always clears the startup guard.
   */
  async login(method: 'browser' | 'device') {
    invariant(
      !this.startingLogin && this.attempt?.status !== 'pending',
      'CODEX_LOGIN_PENDING',
      '已有登录正在进行',
    );
    invariant(this.desktop, 'DESKTOP_REQUIRED', '请从 Elysia 桌面入口登录');
    this.startingLogin = true;
    let rpc: CodexRpc | undefined;
    try {
      rpc = await this.session('elysia');
      const result = await rpc.call('account/login/start', {
        type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt',
        ...(method === 'browser' ? { useHostedLoginSuccessPage: true, appBrand: 'chatgpt' } : {}),
      });
      this.attempt = {
        id: result.loginId,
        status: 'pending',
        ...(result.userCode ? { userCode: result.userCode } : {}),
      };
      await this.desktop.request('open-auth', result.authUrl || result.verificationUrl);
      return this.attempt;
    } catch (e) {
      if (this.attempt?.status === 'pending') {
        await rpc?.call('account/login/cancel', { loginId: this.attempt.id }).catch(() => {});
        this.attempt = { ...this.attempt, status: 'failed', message: (e as Error).message };
      }
      throw e;
    } finally {
      this.startingLogin = false;
    }
  }
  /**
   * 仅对 pending 登录发送取消并记录 cancelled；无活动尝试时不建立额外取消动作。
   * EN: Cancels only a pending login and records cancelled; absent active attempts require no action.
   */
  async cancel() {
    if (this.attempt?.status === 'pending') {
      await (await this.session('elysia')).call('account/login/cancel', { loginId: this.attempt.id });
      this.attempt = { ...this.attempt, status: 'cancelled' };
    }
  }
  /**
   * 先取消登录，再退出应用自管账号并关闭相关活动 RPC、清除连接缓存，返回退出回执。
   * EN: Cancels login, logs out the app-managed account, closes its active RPC connections and clears cached state before returning acknowledgement.
   */
  async logout() {
    await this.cancel();
    await (await this.session('elysia')).call('account/logout', {});
    for (const [rpc, source] of this.inflight) if (source === 'elysia') rpc.close();
    this.connections.delete('elysia');
    return { ok: true };
  }
  /**
   * 为冻结服务商配置创建 Codex Provider 适配器，账号能力继续由本服务持有。
   * EN: Creates a Codex provider for frozen configuration while this service retains account capabilities.
   */
  adapter(config: ProviderConfig): ProviderAdapter {
    return new CodexProvider(config, this);
  }
  /**
   * 每次推理建立独立临时只读线程，只允许返回结构化文本与工具意图。 本机 MCP 和 Codex 原生工具均禁用，实际动作仍交 Elysia 网关；出现意外工具请求即断开。 发起 turn 后的失败标记 responseStarted，使外部预算账本保守处理可能已消耗的用量。
   * EN: Creates an independent temporary read-only thread for each inference, accepting structured text and tool intents only. Local MCP and Codex native tools are disabled; unexpected tool requests disconnect. Failures after turn start are marked responseStarted so accounting conservatively retains possible usage.
   */
  async inference(config: ProviderConfig, request: Record<string, any>, signal: AbortSignal) {
    const source = this.source(config.subscriptionAccountId!);
    const { rpc, cwd } = await this.open(source);
    let started = false;
    /**
     * 将模型调用取消转换为当前临时 RPC 的关闭错误，使等待中的调用一起终止。
     * EN: Converts inference cancellation into closure of its temporary RPC so pending calls terminate together.
     */
    const aborted = () => rpc.close(new AppError('CODEX_CANCELLED', '订阅请求已取消'));
    signal.addEventListener('abort', aborted, { once: true });
    let stopTimer: NodeJS.Timeout | undefined;
    try {
      signal.throwIfAborted();
      const auth = this.account(source, (await rpc.call('account/read', { refreshToken: false })).account);
      invariant(
        auth.accountId === config.subscriptionAccountId && auth.connected,
        'CODEX_ACCOUNT_CHANGED',
        'Codex 登录已改变，请重新选择账号并验证',
      );
      const models = await this.catalog(rpc),
        model = models.find((m) => m.id === config.model);
      invariant(model, 'CODEX_MODEL', '当前订阅不提供所选模型，请刷新模型目录');
      invariant(
        !config.reasoningEffort || model.efforts.includes(config.reasoningEffort),
        'CODEX_EFFORT',
        '此模型不支持所选思考强度',
      );
      const settings = await rpc.call('config/read', { includeLayers: false });
      const disabledMcp = {
        mcp_servers: Object.fromEntries(
          Object.keys(settings.config?.mcp_servers || {}).map((k) => [k, { enabled: false }]),
        ),
      };
      const thread = await rpc.call('thread/start', {
        model: config.model,
        modelProvider: 'openai',
        cwd,
        config: { ...codexConfig, ...disabledMcp },
        approvalPolicy: 'never',
        sandbox: 'read-only',
        environments: [],
        ephemeral: true,
        baseInstructions: request.system,
        developerInstructions: request.instructions,
      });
      invariant(
        thread.model === config.model &&
          thread.modelProvider === 'openai' &&
          thread.sandbox?.type === 'readOnly',
        'CODEX_CONFIG',
        'Codex 没有采用所选模型或只读隔离，已停止请求',
      );
      let usage: any = null,
        text = '',
        firstToken: number | null = null;
      const start = Date.now();
      const end = new Promise<any>((resolve, reject) => {
        rpc.once('closed', reject);
        rpc.once('unexpectedRequest', () => {
          reject(new AppError('CODEX_NATIVE_TOOL', '订阅模型尝试使用未授权原生工具，已停止'));
          rpc.close();
        });
        rpc.on('notification', (event) => {
          if (event.params?.threadId !== thread.thread.id) return;
          if (event.method === 'item/agentMessage/delta' && firstToken === null)
            firstToken = Date.now() - start;
          if (event.method === 'thread/tokenUsage/updated') usage = event.params.tokenUsage?.total;
          if (event.method === 'item/completed') {
            const item = event.params.item;
            if (item.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer'))
              text = item.text;
            if (!['agentMessage', 'userMessage', 'reasoning'].includes(item.type)) {
              reject(new AppError('CODEX_NATIVE_TOOL', '订阅通道出现意外工具活动，已停止'));
              rpc.close();
            }
          }
          if (event.method === 'turn/completed') resolve(event.params.turn);
        });
        stopTimer = setTimeout(() => {
          reject(new AppError('CODEX_TIMEOUT', '订阅调用超时，请检查 Windows 系统代理及网络', true));
          rpc.close();
        }, 120000);
      });
      /**
       * 在turn/start前绑定失败监听，防止早期进程失败形成未处理的Promise拒绝。
       * EN: Attach before turn/start: an early process failure must not create an unhandled rejection.
       */
      end.catch(() => {});
      started = true;
      await rpc.call('turn/start', {
        threadId: thread.thread.id,
        input: [{ type: 'text', text: request.input, text_elements: [] }],
        environments: [],
        effort: config.reasoningEffort || model.defaultEffort,
        outputSchema: request.schema,
      });
      const turn = await end;
      if (turn.status !== 'completed') {
        const info = turn.error?.codexErrorInfo;
        const error = new ProviderError(
          info === 'usageLimitExceeded' ? 'CHATGPT_USAGE_LIMIT' : 'CODEX_INFERENCE',
          info === 'usageLimitExceeded'
            ? 'ChatGPT 订阅额度不足，请查看订阅用量后重试'
            : cleanError(turn.error?.message || '订阅请求未完成'),
          info === 'rateLimitExceeded' ? 429 : 400,
        );
        error.responseStarted = true;
        throw error;
      }
      const parsed = z
        .object({
          text: z.string(),
          calls: z.array(z.object({ name: z.string(), arguments: z.string() })).max(24),
        })
        .strict()
        .parse(JSON.parse(text));
      for (const call of parsed.calls) {
        invariant(request.toolNames.includes(call.name), 'CODEX_TOOL', '模型返回了未声明的工具');
      }
      /**
       * 外层响应和工具身份必须有效；参数语法及 Schema错误交由ToolGateway处理，让下一步可以纠正。
       * EN: The outer response and tool identity must be valid. Argument syntax and schema errors belong to ToolGateway, so the next step can correct them.
       */
      const raw = usage
        ? {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            input_tokens_details: {
              cached_tokens: usage.cachedInputTokens,
              cache_write_tokens: usage.cacheWriteInputTokens,
            },
            output_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens },
          }
        : null;
      return {
        type: 'completed' as const,
        text: parsed.text,
        calls: parsed.calls.map((c) => ({ ...c, id: randomUUID() })),
        native: [],
        usage: normalizeUsage('openai', raw, config, firstToken),
      };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const error = new ProviderError(
        e instanceof AppError ? e.code : 'CODEX_RESPONSE',
        e instanceof AppError ? e.message : 'Codex 返回了无效或不完整的模型响应',
        400,
      );
      error.responseStarted = started;
      throw error;
    } finally {
      if (stopTimer) clearTimeout(stopTimer);
      signal.removeEventListener('abort', aborted);
      rpc.close();
    }
  }
  /**
   * 标记服务关闭并断开所有活动 RPC、移除会话缓存；后续 open 会拒绝新连接。
   * EN: Marks the service closed, closes all active RPC connections and clears sessions; later open calls reject new work.
   */
  async close() {
    this.closed = true;
    for (const rpc of this.inflight.keys()) rpc.close();
    this.sessions.clear();
  }
}

class CodexProvider implements ProviderAdapter {
  capabilities = { streaming: false, tools: true, nativeReplay: false };
  /**
   * 保存冻结模型配置及订阅服务引用，不在构造时读取账号或启动进程。
   * EN: Stores frozen model configuration and subscription service without reading accounts or starting processes.
   */
  constructor(
    private config: ProviderConfig,
    private service: CodexSubscription,
  ) {}
  /**
   * 将编译上下文变为结构化单步任务，明确允许的工具名及响应 schema；工具只作为意图返回，由 Elysia 后续执行。
   * EN: Converts context into a structured single-step request with allowed tool names/response schema. Tools remain returned intents for later Elysia execution.
   */
  compile(context: CompiledContext) {
    /**
     * 单次结构化步骤保留Elysia既有的授权、检查点和请求预算边界。
     * EN: One structured step keeps Elysia's existing permission, checkpoint and request-budget boundaries.
     */
    return {
      system: context.system,
      instructions: CODEX_STEP_GUIDANCE,
      input: JSON.stringify({
        task: context.task,
        tools: context.tools,
        history: context.history.map((m) => ({
          role: m.role,
          text: m.text,
          calls: m.calls,
          callId: m.callId,
        })),
      }),
      toolNames: context.tools.map((t) => t.name),
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          calls: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: {
                  type: 'string',
                  ...(context.tools.length ? { enum: context.tools.map((t) => t.name) } : {}),
                },
                arguments: { type: 'string' },
              },
              required: ['name', 'arguments'],
            },
          },
        },
        required: ['text', 'calls'],
      },
    };
  }
  /**
   * 等待订阅推理后依次产出文本增量和完整结果；该桥接不是上游 token 流，错误与取消继续向调用方传播。
   * EN: Awaits subscription inference then yields text delta and final result; this bridge is not an upstream token stream and propagates errors/cancellation.
   */
  async *stream(request: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const result = await this.service.inference(this.config, request, signal);
    if (result.text) yield { type: 'delta', text: result.text };
    yield result;
  }
}
