/** 读取并解析 API 服务商的模型目录。 */
import { z } from 'zod';
import { AppError, invariant, type ProviderConfig } from '../../../packages/contracts/src/index.js';
import { providerBaseUrl } from '../../../packages/providers/src/index.js';
import { officialDeepSeek } from '../../../packages/providers/src/deepseek.js';
import type { AvailableModel } from './model-choice.js';
import type { ProviderKeys } from './provider-keys.js';

const ModelCatalog = z
  .array(
    z.object({
      id: z.string().min(1).max(256),
      name: z.string().max(512).optional(),
      description: z.string().max(4096).optional(),
      context_window: z.number().int().positive().optional(),
      max_output_tokens: z.number().int().positive().optional(),
      input_modalities: z.array(z.string().min(1).max(64)).max(32).optional(),
      effort: z
        .object({
          supported_levels: z.array(z.string().min(1).max(64)).max(32),
          default_level: z.string().min(1).max(64).optional(),
        })
        .optional(),
    }),
  )
  .max(2000);

export { officialDeepSeek } from '../../../packages/providers/src/deepseek.js';

/** Preserve advertised capabilities; only the official API promises a non-thinking mode. */
export function parseApiModels(data: unknown, provider: ProviderConfig): AvailableModel[] {
  const result = ModelCatalog.safeParse((data as { data?: unknown } | null)?.data);
  invariant(result.success, 'MODEL_CATALOG', '模型目录格式无效；可检查端点或手动填写模型 ID');
  const official = officialDeepSeek(provider);
  return result.data.map((model) => {
    const efforts = model.effort ? [...new Set(model.effort.supported_levels)] : undefined;
    if (official && efforts && !efforts.includes('none')) efforts.unshift('none');
    invariant(
      !model.effort?.default_level || efforts?.includes(model.effort.default_level),
      'MODEL_CATALOG',
      '模型目录的默认思考强度不在支持列表中',
    );
    return {
      id: model.id,
      name: model.name || model.id,
      ...(model.description !== undefined ? { description: model.description } : {}),
      ...(model.context_window !== undefined ? { contextWindow: model.context_window } : {}),
      ...(model.max_output_tokens !== undefined ? { maxOutputTokens: model.max_output_tokens } : {}),
      ...(model.input_modalities !== undefined ? { inputModalities: model.input_modalities } : {}),
      ...(efforts !== undefined ? { efforts } : {}),
      ...(model.effort?.default_level !== undefined ? { defaultEffort: model.effort.default_level } : {}),
    };
  });
}

const catalogByteLimit = 2 * 1024 * 1024;

async function catalogText(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<string> {
  invariant(body, 'MODEL_CATALOG', '模型目录响应为空，请检查 API 端点');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      invariant(bytes <= catalogByteLimit, 'MODEL_CATALOG', '模型目录超过 2 MiB 大小限制，请检查 API 端点');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function catalogHttpFailure(status: number): AppError {
  const advice =
    status === 401
      ? 'API Key 验证失败，请重新保存正确的密钥，并确认所选环境变量'
      : status === 403
        ? '服务拒绝访问，请检查 API Key 权限及网络访问限制'
        : status === 404
          ? '找不到模型目录，请检查基础 API 端点；DeepSeek 官方端点使用 https://api.deepseek.com 或 /v1'
          : status === 429
            ? '读取请求受到限流，请稍后重新读取'
            : status >= 500
              ? '模型服务暂时异常，请稍后重新读取'
              : '请检查 API 端点与账号配置';
  return new AppError(
    'MODEL_CATALOG',
    `模型目录返回 HTTP ${status}：${advice}`,
    status === 429 || status >= 500,
    {
      stage: 'response',
      status,
    },
  );
}

function catalogNetworkFailure(error: unknown, signal: AbortSignal, stage: 'connect' | 'body'): AppError {
  const codes = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ]);
  let networkCode: string | undefined;
  let cause = error as { code?: unknown; cause?: unknown } | null;
  for (let depth = 0; cause && typeof cause === 'object' && depth < 4; depth++) {
    if (typeof cause.code === 'string' && codes.has(cause.code)) {
      networkCode = cause.code;
      break;
    }
    cause = cause.cause as typeof cause;
  }
  const timeout =
    signal.reason?.name === 'TimeoutError' || networkCode?.includes('TIMEOUT') || networkCode === 'ETIMEDOUT';
  const dns = networkCode === 'ENOTFOUND' || networkCode === 'EAI_AGAIN';
  const certificate = networkCode && /CERT|SELF_SIGNED|ISSUER/.test(networkCode);
  const cancelled = signal.aborted && !timeout;
  const advice = timeout
    ? '读取模型目录超时，请检查网络或代理后重试'
    : cancelled
      ? '模型目录读取已取消，请重新读取'
      : dns
        ? '无法解析模型服务地址，请检查 API 端点、DNS 和代理设置'
        : certificate
          ? '模型服务证书验证失败，请检查系统时间、证书和代理设置'
          : networkCode === 'ECONNREFUSED'
            ? '模型服务连接被拒绝，请检查 API 端点、代理和服务状态'
            : stage === 'body'
              ? '模型目录下载中断，请检查网络或代理后重试'
              : '无法连接模型服务，请检查 API 端点、网络或代理后重试';
  return new AppError('MODEL_CATALOG', advice, !cancelled, {
    stage,
    ...(networkCode ? { networkCode } : {}),
  });
}

/** Listing uses the verified credential without spending inference tokens. */
export async function apiModels(
  provider: ProviderConfig,
  keys: Pick<ProviderKeys, 'credential'>,
): Promise<AvailableModel[]> {
  invariant(!provider.archived, 'PROVIDER_ARCHIVED', '模型配置已归档');
  const { token, signal } = await keys.credential(provider);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  let stage: 'connect' | 'body' = 'connect';
  let raw: string;
  try {
    const endpoint = new URL(providerBaseUrl(provider));
    endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/models';
    const response = await fetch(endpoint, {
      headers: { Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: requestSignal,
    });
    stage = 'body';
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw catalogHttpFailure(response.status);
    }
    raw = await catalogText(response.body, requestSignal);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw catalogNetworkFailure(error, requestSignal, stage);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AppError('MODEL_CATALOG', '模型目录不是有效 JSON，请检查 API 端点');
  }
  return parseApiModels(data, provider);
}
