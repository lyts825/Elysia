/** 探测终端连接并整理失败结果。 */
import { z } from 'zod';
import {
  TerminalConnectionBinding,
  TerminalConnectionModel,
  type TerminalConnectionProbeResult,
} from '../../../packages/contracts/src/terminal-control.js';

export interface TerminalConnectionProbeOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
type Outcome = Pick<
  TerminalConnectionProbeResult,
  'status' | 'code' | 'message' | 'httpStatus' | 'resolvedModel' | 'models' | 'truncated'
>;
class ProbeFailure extends Error {
  constructor(readonly outcome: Outcome) {
    super(outcome.message);
  }
}
function fail(code: string, message: string): never {
  throw new ProbeFailure({ status: 'failed', code, message });
}
/** 在已保存基础地址上添加协议路径，避免重复追加已有版本段；不自动跳到其他供应商端点。 */
function endpoint(binding: TerminalConnectionBinding, suffix: string, version?: string): URL {
  const url = new URL(binding.baseUrl);
  const root = url.pathname.replace(/\/+$/, '');
  url.pathname = root + (version && !root.endsWith('/' + version) ? '/' + version : '') + suffix;
  return url;
}
function headers(binding: TerminalConnectionBinding, credential: string): Record<string, string> {
  if (binding.protocol === 'anthropic-messages')
    return { 'x-api-key': credential, 'anthropic-version': '2023-06-01' };
  if (binding.protocol === 'gemini') return { 'x-goog-api-key': credential };
  return { Authorization: 'Bearer ' + credential };
}
function modelText(value: unknown, credential: string): string {
  if (typeof value !== 'string' || value.includes(credential))
    fail('TERMINAL_API_RESPONSE', '服务返回了无效的模型信息，请检查 API 协议和端点');
  const result = TerminalConnectionModel.shape.id.safeParse(value);
  if (!result.success) fail('TERMINAL_API_RESPONSE', '服务返回了无效的模型信息，请检查 API 协议和端点');
  return result.data;
}
function httpFailure(status: number, operation: 'check' | 'models'): Outcome {
  if (operation === 'models' && [404, 405, 501].includes(status))
    return {
      status: 'unsupported',
      code: 'TERMINAL_MODELS_UNSUPPORTED',
      message: '此端点不提供模型目录，可继续手动填写模型 ID 并验证连接',
      httpStatus: status,
    };
  const [code, advice] =
    status === 401
      ? ['TERMINAL_API_AUTH', 'API Key 验证失败，请重新保存密钥或检查所选环境变量']
      : status === 403
        ? ['TERMINAL_API_FORBIDDEN', '服务拒绝访问，请检查密钥权限和网络限制']
        : status === 404
          ? ['TERMINAL_API_NOT_FOUND', '端点或模型不存在，请核对 API 地址、协议和模型 ID']
          : status === 429
            ? ['TERMINAL_API_RATE_LIMIT', '服务已限流或用量不足，请检查账号用量后重试']
            : status >= 500
              ? ['TERMINAL_API_SERVICE', '模型服务暂时异常，请稍后重试']
              : ['TERMINAL_API_REQUEST', '服务未接受请求，请检查协议、模型和 API 地址'];
  return { status: 'failed', code, message: `HTTP ${status}：${advice}`, httpStatus: status };
}
/** 把探测错误转换为安全的状态和错误码，不透传可能含凭据的原始错误。 */
export function terminalProbeFailure(error: unknown, signal: AbortSignal): Outcome {
  if (error instanceof ProbeFailure) return error.outcome;
  if (signal.aborted)
    return signal.reason?.name === 'TimeoutError'
      ? { status: 'failed', code: 'TERMINAL_API_TIMEOUT', message: '连接请求超时，请检查网络或代理后重试' }
      : { status: 'failed', code: 'TERMINAL_API_CANCELLED', message: '连接请求已取消' };
  // Never forward error.message/cause: transports and providers may include credentials or bodies.
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'API_KEY_MISSING' || code === 'TERMINAL_CREDENTIAL_MISSING')
    return { status: 'failed', code: 'API_KEY_MISSING', message: '请保存 API Key 或配置所选环境变量' };
  if (code === 'DESKTOP_REQUIRED')
    return {
      status: 'failed',
      code: 'DESKTOP_REQUIRED',
      message: '读取加密凭据需要桌面入口，也可使用环境变量',
    };
  return {
    status: 'failed',
    code: 'TERMINAL_API_NETWORK',
    message: '无法完成请求，请检查 API 地址、网络、证书和代理设置',
  };
}
/** A bounded JSON transport using the same global fetch/proxy setup and no redirects/retries. */
async function readJson(
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch,
  budget: { remaining: number },
  operation: 'check' | 'models',
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const response = await fetcher(url, { ...init, redirect: 'error', signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ProbeFailure(httpFailure(response.status, operation));
  }
  if (!response.body) fail('TERMINAL_API_RESPONSE', '服务响应为空，请检查 API 协议和端点');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  let raw = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0) fail('TERMINAL_API_RESPONSE_LIMIT', '服务响应超过 2 MiB 限制，请检查端点');
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('TERMINAL_API_RESPONSE', '服务未返回有效 JSON，请检查 API 协议和端点');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { error?: unknown }).error != null
  )
    fail('TERMINAL_API_RESPONSE', '服务未返回有效的协议响应，请检查 API 协议和端点');
  return parsed as Record<string, unknown>;
}
/** 构造用户显式触发的最小非流式推理检查；此操作会使用少量真实模型用量。 */
function testRequest(binding: TerminalConnectionBinding, credential: string) {
  const prompt = 'Reply with OK. This is an explicit connection check.';
  let url: URL;
  let body: Record<string, unknown>;
  if (binding.protocol === 'openai-responses') {
    url = endpoint(binding, '/responses');
    body = { model: binding.model, input: prompt, max_output_tokens: 64, stream: false, store: false };
  } else if (binding.protocol === 'openai-chat') {
    url = endpoint(binding, '/chat/completions');
    body = {
      model: binding.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 64,
      stream: false,
    };
  } else if (binding.protocol === 'anthropic-messages') {
    url = endpoint(binding, '/messages', 'v1');
    body = {
      model: binding.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 64,
      stream: false,
    };
  } else {
    const model = binding.model.replace(/^models\//, '');
    if (!model || /[/?#]/.test(model))
      fail('TERMINAL_API_MODEL', 'Gemini 模型 ID 应为模型名称或 models/模型名称');
    url = endpoint(binding, '/models/' + encodeURIComponent(model) + ':generateContent', 'v1beta');
    body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 64 },
    };
  }
  return {
    url,
    init: {
      method: 'POST',
      headers: { ...headers(binding, credential), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}
function checkResponse(
  binding: TerminalConnectionBinding,
  data: Record<string, unknown>,
  credential: string,
): Outcome {
  let complete = false;
  if (binding.protocol === 'openai-responses')
    complete =
      data.object === 'response' &&
      Array.isArray(data.output) &&
      (data.status === 'completed' ||
        (data.status === 'incomplete' &&
          (data.incomplete_details as { reason?: unknown } | null)?.reason === 'max_output_tokens'));
  else if (binding.protocol === 'openai-chat') {
    const choices = z
      .array(z.object({ finish_reason: z.string() }))
      .min(1)
      .safeParse(data.choices);
    complete =
      choices.success && choices.data.some((choice) => ['stop', 'length'].includes(choice.finish_reason));
  } else if (binding.protocol === 'anthropic-messages')
    complete =
      data.type === 'message' &&
      Array.isArray(data.content) &&
      ['end_turn', 'max_tokens', 'stop_sequence'].includes(String(data.stop_reason));
  else {
    const candidates = z
      .array(z.object({ finishReason: z.string() }))
      .min(1)
      .safeParse(data.candidates);
    complete =
      candidates.success &&
      candidates.data.some((candidate) => ['STOP', 'MAX_TOKENS'].includes(candidate.finishReason));
  }
  if (!complete) fail('TERMINAL_API_RESPONSE', '服务未返回可确认的模型响应，请检查协议、模型和端点');
  const resolvedModel = data.model === undefined ? undefined : modelText(data.model, credential);
  const changed = resolvedModel !== undefined && resolvedModel !== binding.model;
  return {
    status: 'passed',
    code: changed ? 'TERMINAL_API_MODEL_RESOLVED' : 'TERMINAL_API_OK',
    message: changed
      ? '连接已响应；服务返回的模型 ID 不同，请核对模型映射'
      : '连接和模型已响应；本次验证使用了少量模型用量',
    ...(resolvedModel ? { resolvedModel } : {}),
  };
}
function catalogEndpoint(binding: TerminalConnectionBinding, credential: string) {
  const original = new URL(binding.baseUrl);
  if (
    binding.protocol === 'anthropic-messages' &&
    original.hostname === 'api.deepseek.com' &&
    /^\/anthropic(?:\/v1)?\/?$/.test(original.pathname)
  ) {
    original.pathname = '/models';
    return { url: original, headers: { Authorization: 'Bearer ' + credential }, pagination: 'none' as const };
  }
  if (binding.protocol === 'anthropic-messages') {
    const url = endpoint(binding, '/models', 'v1');
    url.searchParams.set('limit', '1000');
    return { url, headers: headers(binding, credential), pagination: 'anthropic' as const };
  }
  if (binding.protocol === 'gemini') {
    const url = endpoint(binding, '/models', 'v1beta');
    url.searchParams.set('pageSize', '1000');
    return { url, headers: headers(binding, credential), pagination: 'gemini' as const };
  }
  return {
    url: endpoint(binding, '/models'),
    headers: headers(binding, credential),
    pagination: 'none' as const,
  };
}
/**
 * 读取协议对应的模型目录，最多四页和 2000 个去重型号；页间共享 2 MiB 响应预算。
 * 游标重复/含凭据/超长立即失败，达到上限标记 truncated 而不声称目录完整。
 */
async function models(
  binding: TerminalConnectionBinding,
  credential: string,
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch,
  budget: { remaining: number },
): Promise<Outcome> {
  const catalog = catalogEndpoint(binding, credential);
  const found = new Map<string, { id: string; name: string }>();
  const seen = new Set<string>();
  let next: string | undefined;
  let truncated = false;
  for (let page = 0; page < 4; page++) {
    const data = await readJson(catalog.url, { headers: catalog.headers }, signal, fetcher, budget, 'models');
    const raw = catalog.pagination === 'gemini' ? data.models : data.data;
    if (!Array.isArray(raw) || raw.length > 2000)
      fail('TERMINAL_API_RESPONSE', '模型目录格式无效，可继续手动填写模型 ID');
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object')
        fail('TERMINAL_API_RESPONSE', '模型目录格式无效，可继续手动填写模型 ID');
      const row = entry as Record<string, unknown>;
      if (
        catalog.pagination === 'gemini' &&
        Array.isArray(row.supportedGenerationMethods) &&
        !row.supportedGenerationMethods.includes('generateContent')
      )
        continue;
      const rawId = modelText(catalog.pagination === 'gemini' ? row.name : row.id, credential);
      const id = catalog.pagination === 'gemini' ? rawId.replace(/^models\//, '') : rawId;
      const name = modelText(row.display_name ?? row.displayName ?? row.name ?? id, credential);
      found.set(id, { id, name });
      if (found.size >= 2000) {
        truncated = true;
        break;
      }
    }
    const cursor =
      catalog.pagination === 'gemini'
        ? data.nextPageToken
        : catalog.pagination === 'anthropic' && data.has_more === true
          ? data.last_id
          : undefined;
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      if (
        typeof cursor !== 'string' ||
        cursor.length > 4096 ||
        cursor.includes(credential) ||
        seen.has(cursor)
      )
        fail('TERMINAL_API_RESPONSE', '模型目录分页信息无效，可继续手动填写模型 ID');
      next = cursor;
      seen.add(cursor);
    } else next = undefined;
    if (!next || truncated) break;
    catalog.url.searchParams.set(catalog.pagination === 'gemini' ? 'pageToken' : 'after_id', next);
  }
  truncated ||= next !== undefined;
  return {
    status: 'passed',
    code: 'TERMINAL_MODELS_OK',
    message: truncated ? '已读取部分模型目录；其他模型可手动填写' : '模型目录已读取，选择后请保存连接',
    models: [...found.values()],
    truncated,
  };
}
/**
 * 验证绑定与密钥形态后执行显式 check 或只读 models。两种操作不相互替代：目录可读不等于
 * 所选模型已响应，检查成功也不表示已枚举目录。全部失败转换为安全结果，不透传远端原文。
 */
export async function terminalConnectionProbe(
  rawBinding: TerminalConnectionBinding,
  credential: string,
  operation: 'check' | 'models',
  signal: AbortSignal,
  options: TerminalConnectionProbeOptions = {},
): Promise<Outcome> {
  try {
    const binding = TerminalConnectionBinding.parse(rawBinding);
    if (!credential || credential.length > 8192 || /[\r\n\0]/.test(credential))
      fail('TERMINAL_CREDENTIAL_MISSING', '所选 API 连接的凭据不可用，请重新保存或检查环境变量');
    const fetcher = options.fetch ?? globalThis.fetch;
    const budget = { remaining: 2 * 1024 * 1024 };
    if (operation === 'models') return await models(binding, credential, signal, fetcher, budget);
    const request = testRequest(binding, credential);
    return checkResponse(
      binding,
      await readJson(request.url, request.init, signal, fetcher, budget, 'check'),
      credential,
    );
  } catch (error) {
    return terminalProbeFailure(error, signal);
  }
}
