import { invariant, ModelChoice, type ProviderConfig } from '../../../packages/contracts/src/index.js';
import type { Store } from '../../../packages/storage/src/index.js';
import type { CodexSubscription } from './codex-subscription.js';
import type { SubscriptionService } from './subscription.js';

type CatalogServices = {
  subscription: Pick<SubscriptionService, 'models'>;
  codex: Pick<CodexSubscription, 'models'>;
};
export type AvailableModel = {
  id: string;
  name: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  hidden?: boolean;
  inputModalities?: string[];
  isDefault?: boolean;
};

/** Reads the current connection catalog; listing does not make an inference request. */
export async function availableModels(
  subscription: CatalogServices['subscription'],
  codex: CatalogServices['codex'],
  provider: ProviderConfig,
): Promise<AvailableModel[]> {
  invariant(!provider.archived, 'PROVIDER_ARCHIVED', '模型配置已归档');
  if (provider.authMode === 'codex') return codex.models(provider.subscriptionAccountId!);
  if (provider.authMode === 'chatgpt') return subscription.models(provider.subscriptionAccountId!);
  return [{ id: provider.model, name: provider.model }];
}

/** Freeze a per-agent choice while retaining the verified connection and shared account quota. */
export async function resolveModelChoice(
  store: Store,
  subscription: CatalogServices['subscription'],
  codex: CatalogServices['codex'],
  raw: ModelChoice,
): Promise<ProviderConfig> {
  const choice = ModelChoice.parse(raw);
  const provider = store.require<ProviderConfig>('providers', choice.providerId);
  invariant(!provider.archived, 'PROVIDER_ARCHIVED', '模型配置已归档');
  invariant(provider.checkedRevision === provider.revision, 'PROVIDER_UNCHECKED', '请先验证模型连接');
  const modelId = choice.model ?? provider.model;
  if (provider.authMode !== 'codex' && provider.authMode !== 'chatgpt') {
    invariant(modelId === provider.model, 'MODEL_UNCHECKED', 'API 模型需使用已验证的模型配置');
    invariant(
      choice.reasoningEffort === undefined || choice.reasoningEffort === provider.reasoningEffort,
      'MODEL_UNCHECKED',
      'API 思考强度需使用已验证的模型配置',
    );
    return { ...provider };
  }
  const models = await availableModels(subscription, codex, provider);
  const model = models.find((item) => item.id === modelId);
  invariant(model, 'SUBSCRIPTION_MODEL', '所选模型不在当前订阅目录中，请刷新模型目录');
  let reasoningEffort = choice.reasoningEffort;
  if (provider.authMode === 'codex') {
    const detail = model as Awaited<ReturnType<CodexSubscription['models']>>[number];
    invariant(detail.inputModalities.includes('text'), 'SUBSCRIPTION_MODEL', '此模型不支持文字对话');
    if (reasoningEffort === undefined)
      reasoningEffort =
        modelId === provider.model && provider.reasoningEffort !== undefined
          ? provider.reasoningEffort
          : (detail.defaultEffort as ProviderConfig['reasoningEffort']);
    invariant(
      reasoningEffort == null || detail.efforts.includes(reasoningEffort),
      'CODEX_EFFORT',
      '此模型不支持所选思考强度，请刷新模型目录',
    );
  } else {
    invariant(reasoningEffort == null, 'CHATGPT_EFFORT', '此订阅连接未提供思考强度选项');
    reasoningEffort = null;
  }
  return { ...provider, model: modelId, reasoningEffort };
}
