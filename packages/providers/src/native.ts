/**
 * 实现原生模型协议请求、响应和流事件转换。
 * 原生协议实现；适配器选择属于供应商插件注册表。
 * 共享上下文先纯编译为协议负载，再进行有界流读取、明确完成检测和保守用量结算。
 *
 * EN: Implements native protocol requests, responses, and stream-event conversion.
 * Native protocol implementation; adapter selection belongs to the provider plugin registry.
 * Purely compiles context first, then performs bounded stream reads, explicit completion detection, and conservative usage accounting.
 */
import {
  UsageSchema,
  type Message,
  type ProviderConfig,
  type ToolCall,
  type Usage,
} from '../../contracts/src/index.js';
import type { CompiledContext } from '../../contracts/src/model.js';
import { officialDeepSeek, retiredDeepSeekModelIssue } from './deepseek.js';
export { officialDeepSeek, deepSeekModelReplacement, retiredDeepSeekModelIssue } from './deepseek.js';
import { ProviderError, type ProviderAdapter, type ProviderEvent } from '../../contracts/src/model.js';
export { ProviderError, type ProviderAdapter, type ProviderEvent } from '../../contracts/src/model.js';
/**
 * 非有限数值不参与费用与用量运算，统一保留为未知。
 *
 * EN: Nonfinite values remain unknown and do not participate in usage or cost arithmetic.
 */
function numeric(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/**
 * 将供应商用量字段统一为共享格式；输入或价格不足时保留未知费用。
 * 将两种协议的 token 分类归一化并按冻结价格计算费用；所有未知分类保持 null。
 * 仅在普通输入、缓存读取、输出及所需缓存写入信息完整时计算 cost，单价单位为每百万 token。
 *
 * EN: Normalizes provider usage fields; missing input or prices leave cost unknown.
 * Normalizes token categories for both protocols and prices them using frozen rates, retaining null for unknown categories. Computes cost only when ordinary input, cache reads, output, and necessary cache-write information are complete; rates are per million tokens.
 */
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
  /**
   * 不同服务可能将缓存写入包含在输入总量内或单独统计；只有可识别字段才判断包含关系。
   *
   * EN: Services may include cache writes in total input or report them separately; inclusion is inferred only from recognized fields.
   */
  const writeIncluded =
    cacheWrite === null ? null : numeric(raw.input_tokens_details?.cache_write_tokens) !== null;
  let cost: number | null = null;
  const prices = config.prices;
  /**
   * 费用只在所需令牌分类和价格均可用时计算，避免将未知用量当作零。
   *
   * EN: Computes cost only when required token categories and rates are known, never treating unknown usage as zero.
   */
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
/**
 * 逐块解码 UTF-8 并按空行切分 SSE；取消、大小限制和最终读取器释放均在此处理。
 *
 * EN: Decodes UTF-8 chunks and splits SSE at blank lines, handling cancellation, size limits, and final reader release.
 */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<any> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  /** 中止底层流读取并观察取消 Promise 的拒绝，最终 finally 仍负责释放 reader 锁。
   * EN: Cancels the underlying read and observes cancellation rejection; finally still releases the reader lock.
   */
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
/**
 * SSE data 必须为 JSON 对象；无效内容不能作为可自动重试的正常协议事件吞掉。
 *
 * EN: SSE data must be a JSON object; invalid contents cannot be swallowed as normal automatically retryable protocol events.
 */
function parseSseData(data: string): any {
  try {
    const event = JSON.parse(data);
    if (event && typeof event === 'object' && !Array.isArray(event)) return event;
  } catch {}
  const error = new ProviderError('INVALID_SSE', '模型服务返回了无法解析的流数据', 502);
  error.retryable = false;
  throw error;
}
/**
 * 官方路由使用 thinking 开关及受支持强度；兼容端点保留通用 reasoning_effort。
 *
 * EN: Official routes use the thinking switch and supported effort; compatible endpoints retain generic reasoning_effort.
 */
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
/**
 * 失败路径只携带输入、输出均完整的可核验用量，解析异常或部分用量返回 null。
 *
 * EN: Failure paths expose usage only when both input/output are complete and verifiable; parse failures or partial usage yield null.
 */
function failureUsage(kind: string, raw: unknown, config: ProviderConfig, ttft: number | null): Usage | null {
  try {
    const usage = normalizeUsage(kind, raw, config, ttft);
    return usage && usage.inputTotal !== null && usage.outputTotal !== null ? usage : null;
  } catch {
    return null;
  }
}
/**
 * 移除已包含的协议端点后缀，便于后续统一拼接请求路径。
 *
 * EN: Removes an existing protocol endpoint suffix before composing a new request path.
 */
export function providerBaseUrl(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): string {
  const url = new URL(provider.baseUrl);
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(provider.kind === 'deepseek' ? /\/chat\/completions$/ : /\/responses$/, '');
  return url.toString().replace(/\/$/, '');
}
/**
 * 优先重放供应商原生助手条目；其他消息按文本、工具调用和结果映射为协议项。
 *
 * EN: Prefers native assistant replay items; maps other messages into protocol text, calls, and results.
 */
function openaiInput(m: Message): unknown[] {
  if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.callId, output: m.text }];
  if (m.role === 'assistant' && m.providerKind === 'openai' && m.native?.length) return m.native;
  const items: unknown[] = m.text ? [{ role: m.role, content: m.text }] : [];
  for (const c of m.calls ?? [])
    items.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
  return items;
}
/**
 * 根据冻结配置编译请求，并将供应商流转换为共享的文本、工具与用量事件。
 *
 * EN: Compiles from the frozen binding and converts provider streams into shared text, tool, and usage events.
 */
export class NativeProvider implements ProviderAdapter {
  capabilities = { streaming: true, tools: true, nativeReplay: true };
  /** 保存本次模型绑定和可选凭据读取器；构造不解析密钥，也不建立网络连接。
   * EN: Stores this model binding and an optional credential resolver without resolving secrets or opening a connection.
   */
  constructor(
    public config: ProviderConfig,
    private credential?: () => Promise<{ token: string; signal: AbortSignal; onUsageLimit?: () => void }>,
  ) {}
  /**
   * 将共享上下文映射成协议请求，不读取凭据、不发网络请求。
   * OpenAI 复用同供应商原生条目；DeepSeek 保留工具批次需要的 reasoning_content。
   * 订阅和 API 的工具命名空间、缓存参数及输出限制按各自协议生成。
   *
   * EN: Maps shared context without credentials or network I/O. OpenAI replays same-provider native items; DeepSeek retains reasoning_content needed by tool batches. Subscription/API namespaces, cache fields, and output limits follow each protocol.
   */
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
      /**
       * 只传协议明确允许的缓存键，避免通用设置注入未知的供应商参数。
       *
       * EN: Passes only explicitly supported cache keys, preventing generic settings from injecting unknown provider parameters.
       */
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
    /**
     * 官方 DeepSeek 工具历史要求 reasoning_content；空串也明确表达当前记录无正文。
     *
     * EN: Official DeepSeek tool history requires reasoning_content; an empty string explicitly records absence of text.
     */
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
  /**
   * 执行一次 HTTP 流请求，逐步产出正文/推理片段，完成时一次返回工具调用、原生项及用量。
   * 调用方取消、凭据失效和协议超时共享取消链；读取成功 HTTP 响应的流期间，
   * 非调用方主动取消的异常保守标记为已开始，供上层保留计费和中断核验。
   * 成功响应无 body 的早期拒绝与调用方取消直接重抛，不经过这条异常标记路径。
   *
   * EN: Executes one HTTP stream, yields text/reasoning deltas, then returns complete calls/native items/usage. Caller cancellation, credential invalidation, and protocol timeout share cancellation. Non-caller-cancel errors while reading a successful HTTP body are conservatively marked started for accounting/reconciliation. Early successful responses without a body and caller cancellations bypass that marking path.
   */
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
      /**
       * Retry-After 同时支持秒数和 HTTP 日期；响应正文只保留有界诊断，不直接回显任意远端文本。
       *
       * EN: Retry-After accepts seconds or an HTTP date; response bodies provide bounded diagnostics rather than arbitrary remote text in the UI.
       */
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
    /**
     * DeepSeek 按流片段 index 累积参数；OpenAI 在完成事件中取得最终原生调用。
     *
     * EN: DeepSeek accumulates arguments by stream index; OpenAI obtains final native calls from completion events.
     */
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
          /**
           * 只有明确正常结束的原因可进入 completed，长度截断、过滤或未知原因不能伪装完成。
           *
           * EN: Only explicit normal finish reasons may produce completed; length limits, filtering, and unknown reasons cannot masquerade as completion.
           */
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
      /**
       * 即使尚未收到可见文字，成功的 HTTP 流也可能已计费。
       *
       * EN: A successful HTTP stream may already be billed, even if no visible text arrived.
       */
      error.responseStarted = true;
      error.usage = failureUsage(p.kind, rawUsage, p, ttft);
      throw error;
    }
    /**
     * 工具参数暂保留原始字符串；这里只核验调用身份和字段类型，JSON schema 由工具网关检查。
     *
     * EN: Tool arguments remain raw strings; this layer checks call identity/field types while the gateway validates JSON schemas.
     */
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
    /**
     * 身份有效的完整调用可通过网关的 TOOL_ARGUMENTS 结果
     * 修复参数语法，且此时尚未记录任何工具操作。
     *
     * EN: A complete call with a valid identity can repair its argument syntax through
     * the gateway's TOOL_ARGUMENTS result, before any tool operation is recorded.
     */
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
/**
 * 将 HTTP/流错误转换为稳定错误码及有界诊断，并附供应商请求 ID 便于追查。
 * 明确的订阅资格或额度错误停止自动重试；额度错误同时通知凭据服务更新账号状态。
 *
 * EN: Maps HTTP/stream failures to stable codes and bounded diagnostics, retaining provider request IDs for tracing. Explicit subscription eligibility/quota failures stop auto-retry, and quota errors also notify credential state.
 */
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
