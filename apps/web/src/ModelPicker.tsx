import { useEffect, useId, useState } from 'react';
import type { ProviderConfig } from '../../../packages/contracts/src/index';
import { api } from './api';
import {
  catalogIssue,
  initialEffort,
  initialTextModel,
  supportsText,
  type CatalogModel,
} from './ModelCatalog';

export type ModelChoice = {
  providerId: string;
  model?: string;
  reasoningEffort?: ProviderConfig['reasoningEffort'];
};
export type SelectableProvider = ProviderConfig & { keyConfigured: boolean };
const catalogs = new Map<string, { time: number; promise: Promise<CatalogModel[]> }>();
function catalog(provider: SelectableProvider, fresh = false) {
  const key = `${provider.id}:${provider.revision}`;
  const existing = catalogs.get(key);
  if (!fresh && existing && Date.now() - existing.time < 30000) return existing.promise;
  const promise = api<CatalogModel[]>('/providers/' + provider.id + '/models').catch((error) => {
    catalogs.delete(key);
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
}: {
  providers: SelectableProvider[];
  value: ModelChoice;
  change: (choice: ModelChoice) => void;
  ready?: (valid: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  const selected = providers.find((p) => p.id === value.providerId);
  const subscription = ['chatgpt', 'codex'].includes(selected?.authMode || '');
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
    if (!selected || !subscription || !verified) {
      setLoading(false);
      return;
    }
    setLoading(true);
    catalog(selected, refresh > 0)
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
  }, [selected?.id, selected?.revision, subscription, verified, refresh]);
  const model = models.find((m) => m.id === value.model);
  const apiBindingMatches =
    !!selected && value.model === selected.model && value.reasoningEffort === selected.reasoningEffort;
  const valid =
    verified &&
    (subscription ? catalogReady && !!model && supportsText(model) : apiBindingMatches) &&
    (!subscription || !model?.efforts?.length || model.efforts.includes(value.reasoningEffort || ''));
  useEffect(() => {
    ready?.(valid);
  }, [valid, ready]);
  useEffect(() => {
    if (disabled || subscription || !selected || apiBindingMatches) return;
    change({ ...value, model: selected.model, reasoningEffort: selected.reasoningEffort });
  }, [
    disabled,
    subscription,
    selected?.id,
    selected?.model,
    selected?.reasoningEffort,
    value.providerId,
    value.model,
    value.reasoningEffort,
    apiBindingMatches,
    change,
  ]);
  useEffect(() => {
    if (disabled || !subscription || !catalogReady) return;
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
      supportsText(current) &&
      current.efforts?.length &&
      value.reasoningEffort === undefined
    ) {
      change({
        ...value,
        reasoningEffort: initialEffort(current),
      });
    }
  }, [models, subscription, catalogReady, value.providerId, value.model, value.reasoningEffort, disabled]);
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
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {['chatgpt', 'codex'].includes(p.authMode || '') ? ' · 订阅' : ' · ' + p.model}
            {!p.keyConfigured ? '（待连接）' : p.checkedRevision !== p.revision ? '（待验证）' : ''}
          </option>
        ))}
      </select>
      {subscription && verified && (
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
          <label htmlFor={id + '-model'}>订阅模型</label>
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
                {!model.efforts.includes(value.reasoningEffort || '') && (
                  <option value={value.reasoningEffort || ''} disabled>
                    {value.reasoningEffort
                      ? `${value.reasoningEffort}（已不可用，请重新选择）`
                      : '请选择推理强度'}
                  </option>
                )}
                {model.efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </>
          )}
        </>
      )}
      {subscription && verified && catalogReady && catalogIssue(models, value.model) && (
        <p className="inline-warning" role="alert">
          {catalogIssue(models, value.model)}
        </p>
      )}
      {subscription &&
        catalogReady &&
        model &&
        supportsText(model) &&
        !!model.efforts?.length &&
        value.reasoningEffort !== undefined &&
        !model.efforts.includes(value.reasoningEffort || '') && (
          <p className="inline-warning" role="alert">
            所选推理强度不在当前目录中，请重新选择。
          </p>
        )}
      {error && (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      )}
      {!verified && <p className="field-help">先在模型设置中连接并验证该连接。</p>}
    </div>
  );
}
