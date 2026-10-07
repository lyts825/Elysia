import { useEffect, useId, useState } from 'react';
import type { ProviderConfig } from '../../../packages/contracts/src/index';
import { api } from './api';

export type ModelChoice = {
  providerId: string;
  model?: string;
  reasoningEffort?: ProviderConfig['reasoningEffort'];
};
export type SelectableProvider = ProviderConfig & { keyConfigured: boolean };
type CatalogModel = { id: string; name?: string; efforts?: string[]; defaultEffort?: string };
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
    [refresh, setRefresh] = useState(0);
  const verified = !!selected?.keyConfigured && selected.checkedRevision === selected.revision;
  useEffect(() => {
    let active = true;
    setModels([]);
    setError('');
    if (!selected || !subscription || !verified) {
      setLoading(false);
      return;
    }
    setLoading(true);
    catalog(selected, refresh > 0)
      .then((rows) => {
        if (active) setModels(rows);
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
  const valid =
    verified &&
    (!subscription || (!loading && !error && !!model)) &&
    (!model?.efforts?.length || model.efforts.includes(value.reasoningEffort || model.defaultEffort || ''));
  useEffect(() => {
    ready?.(valid);
  }, [valid, ready]);
  useEffect(() => {
    if (!subscription || !models.length) return;
    const current = models.find((m) => m.id === value.model);
    if (!current) {
      const next = models.find((m) => m.id === selected?.model) || models[0];
      change({
        ...value,
        model: next.id,
        reasoningEffort: next.defaultEffort as ModelChoice['reasoningEffort'],
      });
    } else if (current.efforts?.length && !current.efforts.includes(value.reasoningEffort || '')) {
      change({
        ...value,
        reasoningEffort: (current.defaultEffort || current.efforts[0]) as ModelChoice['reasoningEffort'],
      });
    }
  }, [models, subscription, value.providerId, value.model, value.reasoningEffort]);
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
              {loading ? '正在读取当前账号模型目录…' : `当前账号模型目录 · ${models.length} 个型号`}
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
            disabled={disabled || loading || !models.length}
            onChange={(e) => {
              const next = models.find((m) => m.id === e.target.value)!;
              change({
                ...value,
                model: next.id,
                reasoningEffort: next.defaultEffort as ModelChoice['reasoningEffort'],
              });
            }}
          >
            {!models.length && (
              <option value={value.model || ''}>{loading ? '读取中…' : '模型目录暂不可用'}</option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
                {m.name && m.name !== m.id ? ` · ${m.id}` : ''}
              </option>
            ))}
          </select>
          {!!model?.efforts?.length && (
            <>
              <label htmlFor={id + '-effort'}>推理强度</label>
              <select
                id={id + '-effort'}
                value={value.reasoningEffort || model.defaultEffort || ''}
                disabled={disabled}
                onChange={(e) =>
                  change({ ...value, reasoningEffort: e.target.value as ModelChoice['reasoningEffort'] })
                }
              >
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
      {error && (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      )}
      {!verified && <p className="field-help">先在模型设置中连接并验证该连接。</p>}
    </div>
  );
}
