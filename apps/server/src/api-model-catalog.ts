import { z } from 'zod';
import { AppError, invariant, type ProviderConfig } from '../../../packages/contracts/src/index.js';
import { providerBaseUrl } from '../../../packages/providers/src/index.js';
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

export function officialDeepSeek(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>) {
  const endpoint = new URL(providerBaseUrl(provider));
  return (
    provider.kind === 'deepseek' &&
    endpoint.origin === 'https://api.deepseek.com' &&
    ['', '/', '/v1'].includes(endpoint.pathname)
  );
}

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

/** Listing uses the verified credential without spending inference tokens. */
export async function apiModels(
  provider: ProviderConfig,
  keys: Pick<ProviderKeys, 'credential'>,
): Promise<AvailableModel[]> {
  invariant(!provider.archived, 'PROVIDER_ARCHIVED', '模型配置已归档');
  const { token, signal } = await keys.credential(provider);
  let response: Response;
  try {
    response = await fetch(providerBaseUrl(provider) + '/models', {
      headers: { Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
  } catch {
    throw new AppError('MODEL_CATALOG', '无法读取模型目录，请检查端点与网络；也可手动填写模型 ID');
  }
  invariant(response.ok, 'MODEL_CATALOG', `模型目录返回 HTTP ${response.status}，也可手动填写模型 ID`);
  const raw = await response.text();
  invariant(raw.length <= 2 * 1024 * 1024, 'MODEL_CATALOG', '模型目录超过大小限制');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AppError('MODEL_CATALOG', '模型目录不是有效 JSON，请检查 API 端点');
  }
  return parseApiModels(data, provider);
}
