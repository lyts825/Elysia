import {
  AppError,
  UsageSchema,
  type Message,
  type ProviderConfig,
  type ToolCall,
  type Usage,
} from '../../contracts/src/index.js';
import { type CompiledContext } from '../../context/src/index.js';
import { officialDeepSeek, retiredDeepSeekModelIssue } from './deepseek.js';
export { officialDeepSeek, deepSeekModelReplacement, retiredDeepSeekModelIssue } from './deepseek.js';
export class ProviderError extends AppError {
  responseStarted = false;
  usage: Usage | null = null;
  constructor(
    code: string,
    message: string,
    public status: number,
    public retryAfterMs = 0,
  ) {
    super(code, message, status === 429 || status >= 500 || status === 0);
  }
}
export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning_delta'; text: string; kind: 'reasoning_content' }
  | {
      type: 'completed';
      text: string;
      calls: ToolCall[];
      usage: Usage | null;
      native: unknown[];
      reasoningContent?: string;
    };
export interface ProviderAdapter {
  capabilities: { streaming: boolean; tools: boolean; nativeReplay: boolean };
  compile(context: CompiledContext): Record<string, unknown>;
  stream(request: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<ProviderEvent>;
}
function numeric(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export function normalizeUsage(
  kind: string,
  raw: any,
  config: ProviderConfig,
  ttftMs: number | null,
): Usage | null {
  if (!raw) return null;
  const inputTotal = numeric(kind === 'openai' ? raw.input_tokens : raw.prompt_tokens),
    outputTotal = numeric(kind === 'openai' ? raw.output_tokens : raw.completion_tokens);
  const cacheRead = numeric(
    kind === 'openai'
      ? raw.input_tokens_details?.cached_tokens
      : (raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens),
  );
  const cacheWrite = numeric(raw.input_tokens_details?.cache_write_tokens ?? raw.cache_creation_input_tokens);
  const uncachedInput =
    numeric(kind === 'deepseek' ? raw.prompt_cache_miss_tokens : null) ??
    (inputTotal !== null && cacheRead !== null ? Math.max(0, inputTotal - cacheRead) : null);
  const reasoning = numeric(
    raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens,
  );
  const writeIncluded =
    cacheWrite === null ? null : numeric(raw.input_tokens_details?.cache_write_tokens) !== null;
  let cost: number | null = null;
  const prices = config.prices;
  if (
    prices &&
    uncachedInput !== null &&
    cacheRead !== null &&
    outputTotal !== null &&
    (prices.cacheWrite === null || (cacheWrite !== null && writeIncluded !== null))
  ) {
    const ordinary = writeIncluded ? Math.max(0, uncachedInput - (cacheWrite ?? 0)) : uncachedInput;
    cost =
      (ordinary * prices.input +
        cacheRead * prices.cacheRead +
        (cacheWrite ?? 0) * (prices.cacheWrite ?? 0) +
        outputTotal * prices.output) /
      1e6;
  }
  return UsageSchema.parse({
    inputTotal,
    cacheRead,
    cacheWrite,
    uncachedInput,
    outputTotal,
    reasoning,
    cost,
    ttftMs,
    rawUsage: raw,
    cacheWriteIncludedInInput: writeIncluded,
  });
}
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<any> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  let pending = '';
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        pending += decoder.decode();
        break;
      }
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new ProviderError('RESPONSE_TOO_LARGE', '模型响应超过限制', 400);
      pending += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data === '[DONE]') return;
        if (data) yield parseSseData(data);
      }
    }
    if (pending.trim()) {
      const data = pending
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') yield parseSseData(data);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function parseSseData(data: string): any {
  try {
    const event = JSON.parse(data);
    if (event && typeof event === 'object' && !Array.isArray(event)) return event;
  } catch {}
  const error = new ProviderError('INVALID_SSE', '模型服务返回了无法解析的流数据', 502);
  error.retryable = false;
  throw error;
}
function deepseekThinking(provider: ProviderConfig): Record<string, unknown> {
  const effort = provider.reasoningEffort;
  if (!effort) return {};
  if (!officialDeepSeek(provider)) return { reasoning_effort: effort };
  if (effort === 'none') return { thinking: { type: 'disabled' } };
  return {
    thinking: { type: 'enabled' },
    reasoning_effort:
      effort === 'minimal' || effort === 'low'
        ? 'low'
        : effort === 'max' || effort === 'ultra'
          ? 'max'
          : 'high',
  };
}
function failureUsage(kind: string, raw: unknown, config: ProviderConfig, ttft: number | null): Usage | null {
  try {
    const usage = normalizeUsage(kind, raw, config, ttft);
    return usage && usage.inputTotal !== null && usage.outputTotal !== null ? usage : null;
  } catch {
    return null;
  }
}
export function providerBaseUrl(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): string {
  const url = new URL(provider.baseUrl);
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(provider.kind === 'deepseek' ? /\/chat\/completions$/ : /\/responses$/, '');
  return url.toString().replace(/\/$/, '');
}
function openaiInput(m: Message): unknown[] {
  if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.callId, output: m.text }];
  if (m.role === 'assistant' && m.providerKind === 'openai' && m.native?.length) return m.native;
  const items: unknown[] = m.text ? [{ role: m.role, content: m.text }] : [];
  for (const c of m.calls ?? [])
    items.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
  return items;
}
export class NativeProvider implements ProviderAdapter {
  capabilities = { streaming: true, tools: true, nativeReplay: true };
  constructor(
    public config: ProviderConfig,
    private credential?: () => Promise<{ token: string; signal: AbortSignal; onUsageLimit?: () => void }>,
  ) {}
  compile(ctx: CompiledContext) {
    const p = this.config;
    const retiredModel = retiredDeepSeekModelIssue(p);
    if (retiredModel) throw new ProviderError('DEEPSEEK_MODEL_RETIRED', retiredModel, 400);
    if (p.authMode === 'codex')
      throw new ProviderError('SUBSCRIPTION_TRANSPORT', 'Codex 订阅需要官方运行时适配器', 400);
    if (p.kind === 'openai') {
      const subscription = p.authMode === 'chatgpt';
      const allowed = subscription
        ? ['prompt_cache_key']
        : ['prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options'];
      const cache = Object.fromEntries(
        Object.entries(p.cache.parameters).filter(([k]) => allowed.includes(k)),
      );
      return {
        model: p.model,
        stream: true,
        store: false,
        include: ['reasoning.encrypted_content'],
        ...(!subscription ? { max_output_tokens: p.outputLimit } : {}),
        input: [
          { role: 'developer', content: ctx.system },
          { role: 'user', content: ctx.task },
          ...ctx.history.flatMap(openaiInput),
        ],
        tools:
          subscription && ctx.tools.length
            ? [
                {
                  type: 'namespace',
                  name: 'elysia',
                  description: 'Elysia 本机任务与文件工具。',
                  tools: ctx.tools.map((t) => ({ type: 'function', ...t, strict: false })),
                },
              ]
            : ctx.tools.map((t) => ({ type: 'function', ...t, strict: false })),
        ...cache,
      };
    }
    const requiredReasoningReplay = !!ctx.tools.length && officialDeepSeek(p);
    return {
      model: p.model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: p.outputLimit,
      ...deepseekThinking(p),
      messages: [
        { role: 'system', content: ctx.system },
        { role: 'user', content: ctx.task },
        ...ctx.history.map((m) =>
          m.role === 'tool'
            ? { role: 'tool', tool_call_id: m.callId, content: m.text }
            : {
                role: m.role,
                content: m.text || null,
                ...(m.role === 'assistant' &&
                ctx.tools.length &&
                (requiredReasoningReplay || m.reasoningContent !== undefined)
                  ? { reasoning_content: m.reasoningContent ?? '' }
                  : {}),
                ...(m.calls?.length
                  ? {
                      tool_calls: m.calls.map((c) => ({
                        id: c.id,
                        type: 'function',
                        function: { name: c.name, arguments: c.arguments },
                      })),
                    }
                  : {}),
              },
        ),
      ],
      ...(ctx.tools.length ? { tools: ctx.tools.map((t) => ({ type: 'function', function: t })) } : {}),
    };
  }
  async *stream(request: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const p = this.config;
    const retiredModel = retiredDeepSeekModelIssue({
      ...p,
      model: typeof request.model === 'string' ? request.model : p.model,
    });
    if (retiredModel) throw new ProviderError('DEEPSEEK_MODEL_RETIRED', retiredModel, 400);
    if (p.authMode === 'codex')
      throw new ProviderError('SUBSCRIPTION_TRANSPORT', 'Codex 订阅需要官方运行时适配器', 400);
    if (
      p.authMode === 'chatgpt' &&
      (p.kind !== 'openai' || p.baseUrl !== 'https://api.openai.com/v1' || !this.credential)
    )
      throw new ProviderError('SUBSCRIPTION_BINDING', '订阅账号绑定或端点无效', 401);
    const credential = this.credential ? await this.credential() : undefined;
    const key = credential
      ? credential.token
      : p.authMode === 'chatgpt'
        ? undefined
        : process.env[p.apiKeyEnv];
    const callerSignal = signal;
    signal = AbortSignal.any([
      signal,
      ...(credential ? [credential.signal] : []),
      AbortSignal.timeout(p.kind === 'deepseek' ? 600000 : 120000),
    ]);
    if (!key) throw new ProviderError('API_KEY_MISSING', `服务端未配置 ${p.apiKeyEnv}`, 401);
    const url = new URL(providerBaseUrl(p));
    url.pathname =
      url.pathname.replace(/\/$/, '') + (p.kind === 'openai' ? '/responses' : '/chat/completions');
    const started = Date.now();
    let ttft: number | null = null,
      response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(request),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      if (callerSignal.aborted) throw error;
      throw new ProviderError('PROVIDER_NETWORK', '模型网络请求失败或超时', 0);
    }
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const parsedRetry = retry
        ? /^\d+(\.\d+)?$/.test(retry)
          ? Number(retry) * 1000
          : Math.max(0, Date.parse(retry) - Date.now())
        : 0;
      const retryAfterMs = Number.isFinite(parsedRetry) ? parsedRetry : 0;
      let body: any;
      try {
        body = JSON.parse((await response.text()).slice(0, 16000));
        if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
      } catch {
        body = {};
      }
      throw providerFailure(
        body.error?.code,
        response.status,
        false,
        body,
        response,
        retryAfterMs,
        credential?.onUsageLimit,
        p.kind,
      );
    }
    if (!response.body) throw new ProviderError('EMPTY_STREAM', '模型服务未返回流', 502);
    let text = '',
      reasoningContent = '',
      rawUsage: any = null,
      native: any[] = [],
      completed = false;
    const calls = new Map<number, any>();
    try {
      for await (const event of sseData(response.body, signal)) {
        if (p.kind === 'deepseek' ? event.usage : event.response?.usage)
          rawUsage = p.kind === 'deepseek' ? event.usage : event.response.usage;
        if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type))
          throw providerFailure(
            event.response?.error?.code ??
              event.error?.code ??
              event.code ??
              event.response?.incomplete_details?.reason,
            502,
            true,
            event,
            response,
            0,
            credential?.onUsageLimit,
            p.kind,
          );
        if (p.kind === 'openai') {
          if (event.type === 'response.output_text.delta') {
            if (ttft === null) ttft = Date.now() - started;
            text += event.delta;
            yield { type: 'delta', text: event.delta };
          }
          if (event.type === 'response.completed') {
            completed = true;
            native = event.response.output ?? [];
            rawUsage = event.response.usage;
          }
        } else {
          if (event.usage) rawUsage = event.usage;
          const choice = event.choices?.[0];
          if (!choice) continue;
          if (
            ttft === null &&
            (choice.delta?.content || choice.delta?.reasoning_content || choice.delta?.tool_calls?.length)
          )
            ttft = Date.now() - started;
          if (choice.delta?.content) {
            if (ttft === null) ttft = Date.now() - started;
            text += choice.delta.content;
            yield { type: 'delta', text: choice.delta.content };
          }
          if (typeof choice.delta?.reasoning_content === 'string' && choice.delta.reasoning_content) {
            reasoningContent += choice.delta.reasoning_content;
            yield {
              type: 'reasoning_delta',
              text: choice.delta.reasoning_content,
              kind: 'reasoning_content',
            };
          }
          for (const c of choice.delta?.tool_calls ?? []) {
            if (!Number.isInteger(c.index) || c.index < 0 || (c.type && c.type !== 'function'))
              throw new ProviderError('INVALID_TOOL_CALLS', '模型返回了无效的工具调用片段', 502);
            if (
              (c.function?.name !== undefined && typeof c.function.name !== 'string') ||
              (c.function?.arguments !== undefined && typeof c.function.arguments !== 'string')
            )
              throw new ProviderError('INVALID_TOOL_CALLS', '工具调用名称或参数片段类型无效', 400);
            const old = calls.get(c.index) ?? { id: '', name: '', arguments: '' };
            if (c.id) old.id = c.id;
            if (c.function?.name) old.name += c.function.name;
            if (c.function?.arguments) old.arguments += c.function.arguments;
            calls.set(c.index, old);
          }
          if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter')
            throw new ProviderError('PROVIDER_INCOMPLETE', '模型输出被截断或过滤', 400);
          if (choice.finish_reason === 'insufficient_system_resource' || choice.finish_reason === 'aborted')
            throw new ProviderError('STREAM_INTERRUPTED', 'DeepSeek 推理被服务端中断，请重试', 503);
          if (choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls') completed = true;
          else if (choice.finish_reason) {
            const error = new ProviderError('PROVIDER_INCOMPLETE', '模型返回了无法确认完成的结束原因', 502);
            error.retryable = false;
            throw error;
          }
        }
      }
      if (!completed) throw new ProviderError('STREAM_INTERRUPTED', '流结束但没有完成事件，保留中断记录', 0);
    } catch (cause) {
      if (callerSignal.aborted) throw cause;
      const error =
        cause instanceof ProviderError
          ? cause
          : new ProviderError('PROVIDER_NETWORK', '模型流读取失败或超时，保留中断记录', 0);
      // A successful HTTP stream may already be billed, even if no visible text arrived.
      error.responseStarted = true;
      error.usage = failureUsage(p.kind, rawUsage, p, ttft);
      throw error;
    }
    const toolCalls: ToolCall[] =
      p.kind === 'openai'
        ? native
            .filter((x) => x.type === 'function_call')
            .map((x) => ({
              id: x.call_id,
              name: p.authMode === 'chatgpt' ? x.name?.replace(/^elysia\./, '') : x.name,
              arguments: x.arguments,
            }))
        : [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    try {
      if (
        toolCalls.some((c) => typeof c.id !== 'string' || !c.id || typeof c.name !== 'string' || !c.name) ||
        new Set(toolCalls.map((c) => c.id)).size !== toolCalls.length
      )
        throw new Error('Invalid tool identity');
      for (const call of toolCalls) {
        if (typeof call.arguments !== 'string') throw new Error('Invalid tool arguments');
      }
    } catch {
      const error = new ProviderError('INVALID_TOOL_CALLS', '工具调用 ID、名称或参数类型无效', 400);
      error.retryable = false;
      error.responseStarted = true;
      error.usage = failureUsage(p.kind, rawUsage, p, ttft);
      throw error;
    }
    // A complete call with a valid identity can repair its argument syntax through
    // the gateway's TOOL_ARGUMENTS result, before any tool operation is recorded.
    yield {
      type: 'completed',
      text,
      calls: toolCalls,
      native,
      usage: normalizeUsage(p.kind, rawUsage, p, ttft),
      ...(p.kind === 'deepseek' ? { reasoningContent } : {}),
    };
  }
}
function providerFailure(
  code: unknown,
  status: number,
  started: boolean,
  body: any,
  response: Response,
  retry = 0,
  onUsageLimit?: () => void,
  kind?: string,
) {
  const safeCode = typeof code === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(code) ? code : 'PROVIDER_HTTP';
  const usageLimit = safeCode === 'subscription_sharing_usage_limit_exceeded';
  const terminal =
    usageLimit ||
    [
      'subscription_sharing_user_not_eligible',
      'subscription_sharing_unsupported_capability',
      'subscription_sharing_route_not_supported',
      'subscription_sharing_invalid_user',
      'chatpass_v2_scope_not_authorized',
      'chatpass_v2_invalid_authorization_context',
    ].includes(safeCode);
  const deepseekFailures: Record<number, [string, string]> = {
    400: ['DEEPSEEK_INVALID_FORMAT', 'DeepSeek 请求格式无效，请检查模型和会话历史'],
    401: ['DEEPSEEK_AUTH', 'DeepSeek 身份验证失败，请检查 API Key'],
    402: ['DEEPSEEK_BALANCE', 'DeepSeek 账户余额不足，请充值后重试'],
    422: ['DEEPSEEK_INVALID_PARAMETERS', 'DeepSeek 参数无效，请检查模型、推理强度和输出上限'],
    429: ['DEEPSEEK_RATE_LIMIT', 'DeepSeek 请求受到限流，请稍后重试'],
    500: ['DEEPSEEK_SERVER', 'DeepSeek 服务暂时异常，请稍后重试'],
    503: ['DEEPSEEK_OVERLOADED', 'DeepSeek 服务繁忙，请稍后重试'],
  };
  const deepseekFailure =
    kind === 'deepseek'
      ? started
        ? ['DEEPSEEK_STREAM_ERROR', 'DeepSeek 模型流返回错误，请稍后重试']
        : (deepseekFailures[status] ?? [
            'DEEPSEEK_HTTP',
            `DeepSeek 服务返回 HTTP ${status}，请检查连接配置后重试`,
          ])
      : undefined;
  const error = new ProviderError(
    deepseekFailure?.[0] ?? (usageLimit ? 'CHATGPT_USAGE_LIMIT' : safeCode),
    deepseekFailure?.[1] ??
      (usageLimit
        ? 'ChatGPT 订阅额度已达限制，请在模型设置中管理用量后重新检查'
        : started
          ? `模型流返回错误（${safeCode}）`
          : `模型服务返回 HTTP ${status}（${safeCode}）`),
    status,
    retry,
  );
  error.responseStarted = started;
  if (terminal) error.retryable = false;
  error.details = {
    status,
    httpStatus: response.status,
    code: kind === 'deepseek' ? error.code : safeCode,
    ...(kind !== 'deepseek' ? { param: body.error?.param ?? body.response?.error?.param } : {}),
    shape: Object.keys(body).slice(0, 20),
    requestId: response.headers.get('x-request-id') ?? response.headers.get('openai-request-id'),
  };
  if (usageLimit) onUsageLimit?.();
  return error;
}
