import { useEffect, useId, useState } from 'react';
import type { ProviderConfig } from '../../../packages/contracts/src/index';
import type { SurfaceClient } from './api';
import { useSurfaceClient } from './SurfaceClientContext';
import {
  catalogIssue,
  initialEffort,
  initialTextModel,
  officialDeepSeek,
  retiredDeepSeekModelIssue,
  supportsText,
  type CatalogModel,
} from './ModelCatalog';

export type ModelChoice = {
  providerId: string;
  model?: string;
  reasoningEffort?: ProviderConfig['reasoningEffort'];
};
export type SelectableProvider = ProviderConfig & { keyConfigured: boolean };
const catalogCaches = new WeakMap<
  SurfaceClient,
  Map<string, { time: number; promise: Promise<CatalogModel[]> }>
>();
function catalog(client: SurfaceClient, provider: SelectableProvider, fresh = false) {
  let catalogs = catalogCaches.get(client);
  if (!catalogs) {
    catalogs = new Map();
    catalogCaches.set(client, catalogs);
  }
  const cache = catalogs;
  const key = `${provider.id}:${provider.revision}`;
  const existing = catalogs.get(key);
  if (!fresh && existing && Date.now() - existing.time < 30000) return existing.promise;
  const promise = client.api<CatalogModel[]>('/providers/' + provider.id + '/models').catch((error) => {
    cache.delete(key);
    throw error;
  });
  catalogs.set(key, { time: Date.now(), promise });
  return promise;
}
export function defaultChoice(providers: SelectableProvider[], preferred?: string): ModelChoice {
  const provider =
    providers.find((p) => p.id === preferred) ||
    providers.find((p) => p.keyConfigured && p.checkedRevision === p.revision) ||
    providers[0];
  return {
    providerId: provider?.id || '',
    model: provider?.model,
    reasoningEffort: provider?.reasoningEffort,
  };
}
export function ModelPicker({
  providers,
  value,
  change,
  ready,
  disabled = false,
  label = '模型连接',
  preserveInvalid = false,
}: {
  providers: SelectableProvider[];
  value: ModelChoice;
  change: (choice: ModelChoice) => void;
  ready?: (valid: boolean) => void;
  disabled?: boolean;
  label?: string;
  preserveInvalid?: boolean;
}) {
  const client = useSurfaceClient();
  const id = useId();
  const selected = providers.find((p) => p.id === value.providerId);
  const subscription = ['chatgpt', 'codex'].includes(selected?.authMode || '');
  const deepSeek = !subscription && selected?.kind === 'deepseek';
  const canDisableThinking = !!selected && deepSeek && officialDeepSeek(selected);
  const usesCatalog = subscription || deepSeek;
  const [models, setModels] = useState<CatalogModel[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0),
    [loadedCatalog, setLoadedCatalog] = useState('');
  const catalogKey = `${selected?.id}:${selected?.revision}:${refresh}`;
  const catalogReady = loadedCatalog === catalogKey && !loading && !error;
  const verified = !!selected?.keyConfigured && selected.checkedRevision === selected.revision;
  useEffect(() => {
    let active = true;
    setModels([]);
    setLoadedCatalog('');
    setError('');
    if (!selected || !usesCatalog || !verified) {
      setLoading(false);
      return;
    }
    setLoading(true);
    catalog(client, selected, refresh > 0)
      .then((rows) => {
        if (active) {
          setModels(rows);
          setLoadedCatalog(catalogKey);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected?.id, selected?.revision, usesCatalog, verified, refresh]);
  const model = models.find((m) => m.id === value.model);
  const apiBindingMatches =
    !!selected && value.model === selected.model && value.reasoningEffort === selected.reasoningEffort;
  const retiredModelIssue = selected
    ? retiredDeepSeekModelIssue({
        ...selected,
        model: value.model ?? selected.model,
        reasoningEffort: value.reasoningEffort,
      })
    : '';
  const valid =
    !retiredModelIssue &&
    verified &&
    ((deepSeek && apiBindingMatches) ||
      ((usesCatalog ? catalogReady && !!model && supportsText(model) : apiBindingMatches) &&
        (!usesCatalog ||
          !model?.efforts?.length ||
          model.efforts.includes(value.reasoningEffort || '') ||
          (canDisableThinking && value.reasoningEffort === 'none'))));
  useEffect(() => {
    ready?.(valid);
  }, [valid, ready]);
  useEffect(() => {
    if (preserveInvalid || disabled || usesCatalog || !selected || apiBindingMatches) return;
    change({ ...value, model: selected.model, reasoningEffort: selected.reasoningEffort });
  }, [
    disabled,
    usesCatalog,
    selected?.id,
    selected?.model,
    selected?.reasoningEffort,
    value.providerId,
    value.model,
    value.reasoningEffort,
    apiBindingMatches,
    change,
    preserveInvalid,
  ]);
  useEffect(() => {
    if (preserveInvalid || disabled || !usesCatalog || !catalogReady) return;
    const current = models.find((m) => m.id === value.model);
    if (!value.model) {
      const next = initialTextModel(models, selected?.model);
      if (!next) return;
      change({
        ...value,
        model: next.id,
        reasoningEffort: initialEffort(next),
      });
    } else if (
      current &&
      !(deepSeek && apiBindingMatches) &&
      supportsText(current) &&
      current.efforts?.length &&
      value.reasoningEffort === undefined
    ) {
      change({
        ...value,
        reasoningEffort: initialEffort(current),
      });
    }
  }, [
    models,
    usesCatalog,
    catalogReady,
    deepSeek,
    apiBindingMatches,
    value.providerId,
    value.model,
    value.reasoningEffort,
    disabled,
    preserveInvalid,
  ]);
  return (
    <div className="model-picker">
      <label htmlFor={id + '-provider'}>{label}</label>
      <select
        id={id + '-provider'}
        value={value.providerId}
        disabled={disabled}
        onChange={(e) => change(defaultChoice(providers, e.target.value))}
      >
        {!providers.length && <option value="">请先连接模型</option>}
        {value.providerId && !selected && <option value={value.providerId}>原连接不可用，请重新选择</option>}
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {['chatgpt', 'codex'].includes(p.authMode || '') ? ' · 订阅' : ' · ' + p.model}
            {!p.keyConfigured ? '（待连接）' : p.checkedRevision !== p.revision ? '（待验证）' : ''}
          </option>
        ))}
      </select>
      {preserveInvalid && selected && !usesCatalog && !apiBindingMatches && (
        <p className="field-error" role="status">
          保存的型号或思考强度已与当前连接不同，请确认后采用当前配置。
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => change(defaultChoice(providers, selected.id))}
          >
            采用当前连接配置
          </button>
        </p>
      )}
      {retiredModelIssue && (
        <p className="inline-warning" role="alert">
          {retiredModelIssue}
        </p>
      )}
      {usesCatalog && verified && (
        <>
          <div className="model-catalog-heading">
            <span>
              {loading
                ? '正在读取当前账号模型目录…'
                : `当前账号模型目录 · ${models.filter(supportsText).length} 个文字型号 / ${models.length} 个型号`}
            </span>
            <button
              type="button"
              className="text-button"
              disabled={disabled || loading}
              onClick={() => setRefresh((n) => n + 1)}
            >
              刷新目录
            </button>
          </div>
          <label htmlFor={id + '-model'}>{subscription ? '订阅模型' : 'DeepSeek 模型'}</label>
          <select
            id={id + '-model'}
            value={value.model || ''}
            disabled={disabled || !catalogReady || !models.some(supportsText)}
            onChange={(e) => {
              const next = models.find((m) => m.id === e.target.value);
              if (!next || !supportsText(next)) return;
              change({
                ...value,
                model: next.id,
                reasoningEffort: initialEffort(next),
              });
            }}
          >
            {!models.length && (
              <option value={value.model || ''}>{loading ? '读取中…' : '模型目录暂不可用'}</option>
            )}
            {!!models.length && !model && (
              <option value={value.model || ''} disabled>
                {value.model ? `${value.model}（已不可用，请重新选择）` : '请选择文字型号'}
              </option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!supportsText(m)}>
                {m.name || m.id}
                {m.name && m.name !== m.id ? ` · ${m.id}` : ''}
                {!supportsText(m) ? '（不支持文字对话）' : ''}
              </option>
            ))}
          </select>
          {model && supportsText(model) && !!model.efforts?.length && (
            <>
              <label htmlFor={id + '-effort'}>推理强度</label>
              <select
                id={id + '-effort'}
                value={value.reasoningEffort || ''}
                disabled={disabled}
                onChange={(e) =>
                  change({ ...value, reasoningEffort: e.target.value as ModelChoice['reasoningEffort'] })
                }
              >
                {!model.efforts.includes(value.reasoningEffort || '') &&
                  !(canDisableThinking && value.reasoningEffort === 'none') && (
                    <option value={value.reasoningEffort || ''} disabled>
                      {value.reasoningEffort
                        ? `${value.reasoningEffort}（已不可用，请重新选择）`
                        : '请选择推理强度'}
                    </option>
                  )}
                {canDisableThinking && !model.efforts.includes('none') && (
                  <option value="none">关闭思考 · 更快回复</option>
                )}
                {model.efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort === 'none' ? '关闭思考 · 更快回复' : effort}
                  </option>
                ))}
              </select>
            </>
          )}
        </>
      )}
      {usesCatalog && verified && catalogReady && catalogIssue(models, value.model) && (
        <p className="inline-warning" role="alert">
          {catalogIssue(models, value.model)}
        </p>
      )}
      {usesCatalog &&
        catalogReady &&
        model &&
        supportsText(model) &&
        !!model.efforts?.length &&
        value.reasoningEffort !== undefined &&
        !model.efforts.includes(value.reasoningEffort || '') &&
        !(canDisableThinking && value.reasoningEffort === 'none') && (
          <p className="inline-warning" role="alert">
            所选推理强度不在当前目录中，请重新选择。
          </p>
        )}
      {error && (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      )}
      {deepSeek && error && apiBindingMatches && (
        <p className="field-help">目录暂不可用，继续使用已验证配置的型号和思考设置；切换型号前请刷新目录。</p>
      )}
      {!verified && <p className="field-help">先在模型设置中连接并验证该连接。</p>}
    </div>
  );
}
