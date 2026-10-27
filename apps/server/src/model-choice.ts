/** 查询可用模型并解析模型选择。 */
import { invariant, ModelChoice, type ProviderConfig } from '../../../packages/contracts/src/index.js';
import type { Store } from '../../../packages/storage/src/index.js';
import type { CodexSubscription } from './codex-subscription.js';
import type { SubscriptionService } from './subscription.js';
import { retiredDeepSeekModelIssue } from '../../../packages/providers/src/deepseek.js';

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
  contextWindow?: number;
  maxOutputTokens?: number;
};
export type ApiModelCatalog = (provider: ProviderConfig) => Promise<AvailableModel[]>;

/** Reads the current connection catalog; listing does not make an inference request. */
/** 按认证方式从 Codex、ChatGPT 或 API 目录读取模型；无目录服务时使用已配置模型。 */
export async function availableModels(
  subscription: CatalogServices['subscription'],
  codex: CatalogServices['codex'],
  provider: ProviderConfig,
  apiCatalog?: ApiModelCatalog,
): Promise<AvailableModel[]> {
  invariant(!provider.archived, 'PROVIDER_ARCHIVED', '模型配置已归档');
  if (provider.authMode === 'codex') return codex.models(provider.subscriptionAccountId!);
  if (provider.authMode === 'chatgpt') return subscription.models(provider.subscriptionAccountId!);
  return apiCatalog ? apiCatalog(provider) : [{ id: provider.model, name: provider.model }];
}

/** Freeze a per-agent choice while retaining the verified connection and shared account quota. */
/**
 * 基于已验证连接冻结单代理配置，保留账号和并发额度。沿用原 API 型号时不依赖在线目录，
 * 显式换型号/强度时必须查询并校验真实能力，窗口/输出上限只收紧，换型号后清除旧价格假设。
 */
export async function resolveModelChoice(
  store: Store,
  subscription: CatalogServices['subscription'],
  codex: CatalogServices['codex'],
  raw: ModelChoice,
  apiCatalog?: ApiModelCatalog,
): Promise<ProviderConfig> {
  const choice = ModelChoice.parse(raw);
  const provider = store.require<ProviderConfig>('providers', choice.providerId);
  invariant(!provider.archived, 'PROVIDER_ARCHIVED', '模型配置已归档');
  invariant(provider.checkedRevision === provider.revision, 'PROVIDER_UNCHECKED', '请先验证模型连接');
  const modelId = choice.model ?? provider.model;
  if (provider.authMode !== 'codex' && provider.authMode !== 'chatgpt') {
    const retiredModel = retiredDeepSeekModelIssue({ ...provider, model: modelId });
    invariant(!retiredModel, 'DEEPSEEK_MODEL_RETIRED', retiredModel);
    // A normal send must remain available even when the discovery endpoint is offline.
    if (
      modelId === provider.model &&
      (choice.reasoningEffort === undefined || choice.reasoningEffort === provider.reasoningEffort)
    )
      return { ...provider };
    invariant(apiCatalog, 'MODEL_UNCHECKED', '显式切换 API 模型需要读取当前模型目录');
    const models = await availableModels(subscription, codex, provider, apiCatalog);
    const model = models.find((item) => item.id === modelId);
    invariant(model, 'API_MODEL', '所选模型不在当前 API 目录中，请刷新模型目录；原配置不会自动切换');
    invariant(
      !model.inputModalities || model.inputModalities.includes('text'),
      'API_MODEL',
      '所选模型不支持文字对话',
    );
    const effort =
      choice.reasoningEffort !== undefined
        ? choice.reasoningEffort
        : modelId === provider.model
          ? provider.reasoningEffort
          : model.defaultEffort;
    const parsedEffort = ModelChoice.shape.reasoningEffort.safeParse(effort);
    invariant(
      parsedEffort.success && (effort == null || model.efforts?.includes(effort)),
      'API_EFFORT',
      '此 API 模型未声明支持所选思考强度，请刷新模型目录',
    );
    const contextLimit = Math.min(provider.contextLimit, model.contextWindow ?? provider.contextLimit);
    const outputLimit = Math.min(
      provider.outputLimit,
      model.maxOutputTokens ?? provider.outputLimit,
      contextLimit - 1,
    );
    invariant(
      contextLimit >= 4096 && outputLimit >= 256,
      'API_MODEL_LIMIT',
      '所选模型容量不足以运行当前任务，请另选模型配置',
    );
    return {
      ...provider,
      model: modelId,
      reasoningEffort: parsedEffort.data,
      contextLimit,
      outputLimit,
      prices: modelId === provider.model ? provider.prices : null,
    };
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

/** Share discovery only within one plan; each choice still validates its current connection. */
/**
 * 同一计划内按账号或连接版本共享目录 Promise，并按原计划顺序逐项解析。
 * 单项失败后不再触发无关目录请求；缓存不跨本次调用，不能掩盖后续连接变化。
 */
export async function resolveModelChoices(
  store: Store,
  subscription: CatalogServices['subscription'],
  codex: CatalogServices['codex'],
  choices: readonly ModelChoice[],
  apiCatalog?: ApiModelCatalog,
): Promise<ProviderConfig[]> {
  const memoize = <Input, Output>(read: (input: Input) => Promise<Output>, key: (input: Input) => string) => {
    const catalogs = new Map<string, Promise<Output>>();
    return (input: Input) => {
      const id = key(input);
      let catalog = catalogs.get(id);
      if (!catalog) {
        catalog = read(input);
        catalogs.set(id, catalog);
      }
      return catalog;
    };
  };
  const subscriptions = {
    models: memoize(
      (id: string) => subscription.models(id),
      (id) => id,
    ),
  };
  const codexAccounts = {
    models: memoize(
      (id: string) => codex.models(id),
      (id) => id,
    ),
  };
  const apiModels = apiCatalog
    ? memoize(apiCatalog, (provider) => JSON.stringify([provider.id, provider.revision]))
    : undefined;
  const bindings: ProviderConfig[] = [];
  // Keep plan order so a failed selection does not trigger unrelated discovery calls.
  for (const choice of choices)
    bindings.push(await resolveModelChoice(store, subscriptions, codexAccounts, choice, apiModels));
  return bindings;
}
