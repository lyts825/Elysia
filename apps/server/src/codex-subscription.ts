/** 管理 Codex 订阅连接及模型信息。 */
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

/** 管理本地及订阅会话、登录状态和模型推理请求；关闭时终止在途连接。 */
export class CodexSubscription {
  private sessions = new Map<Source, Promise<CodexRpc>>();
  private connections = new Map<Source, Connection>();
  private versions = new Map<Source, string>();
  private inflight = new Map<CodexRpc, Source>();
  private attempt?: Attempt;
  private closed = false;
  private startingLogin = false;
  constructor(
    private directory: string,
    private desktop?: DesktopServices,
  ) {}
  private home(source: Source) {
    return source === 'elysia' ? path.join(this.directory, 'codex-home') : undefined;
  }
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
  /** 同来源的账号/目录操作共享 RPC；连接关闭只删除其自身缓存，旧失败不能清除后建会话。 */
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
  source(accountId: string): Source {
    invariant(
      /^codex-(local|elysia)-[a-f0-9]{24}$/.test(accountId),
      'CODEX_ACCOUNT',
      '请选择 Codex 订阅连接',
    );
    return accountId.startsWith('codex-local-') ? 'local' : 'elysia';
  }
  configured(accountId?: string | null) {
    return (
      !!accountId && [...this.connections.values()].some((c) => c.connected && c.accountId === accountId)
    );
  }
  /** 每次使用前回读实际登录账号，配置中的账号 ID 不能自动跟随用户在 Codex 中切换身份。 */
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
  /** 有界分页读取完整模型目录并拒绝重复游标；型号、思考强度由真实目录而非静态猜测决定。 */
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
  async models(id: string) {
    return this.catalog(await this.session(await this.requireAccount(id)));
  }
  async usage(id: string) {
    return await (await this.session(await this.requireAccount(id))).call('account/rateLimits/read', {});
  }
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
  async cancel() {
    if (this.attempt?.status === 'pending') {
      await (await this.session('elysia')).call('account/login/cancel', { loginId: this.attempt.id });
      this.attempt = { ...this.attempt, status: 'cancelled' };
    }
  }
  async logout() {
    await this.cancel();
    await (await this.session('elysia')).call('account/logout', {});
    for (const [rpc, source] of this.inflight) if (source === 'elysia') rpc.close();
    this.connections.delete('elysia');
    return { ok: true };
  }
  adapter(config: ProviderConfig): ProviderAdapter {
    return new CodexProvider(config, this);
  }
  /**
   * 每次推理建立独立临时只读线程，只允许返回结构化文本与工具意图。
   * 本机 MCP 和 Codex 原生工具均禁用，实际动作仍交 Elysia 网关；出现意外工具请求即断开。
   * 发起 turn 后的失败标记 responseStarted，使外部预算账本保守处理可能已消耗的用量。
   */
  async inference(config: ProviderConfig, request: Record<string, any>, signal: AbortSignal) {
    const source = this.source(config.subscriptionAccountId!);
    const { rpc, cwd } = await this.open(source);
    let started = false;
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
      // Attach before turn/start: an early process failure must not create an unhandled rejection.
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
      // The outer response and tool identity must be valid. Argument syntax and
      // schema errors belong to ToolGateway, so the next step can correct them.
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
  async close() {
    this.closed = true;
    for (const rpc of this.inflight.keys()) rpc.close();
    this.sessions.clear();
  }
}

class CodexProvider implements ProviderAdapter {
  capabilities = { streaming: false, tools: true, nativeReplay: false };
  constructor(
    private config: ProviderConfig,
    private service: CodexSubscription,
  ) {}
  compile(context: CompiledContext) {
    // One structured step keeps Elysia's existing permission, checkpoint and request-budget boundaries.
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
  async *stream(request: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const result = await this.service.inference(this.config, request, signal);
    if (result.text) yield { type: 'delta', text: result.text };
    yield result;
  }
}
