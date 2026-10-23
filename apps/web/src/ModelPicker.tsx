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
import './model-picker.css';

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
    <div className="model-picker model-selection-editor">
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
      <p className="model-selection-state" data-ready={valid} role="status">
        {valid
          ? '当前选择可用'
          : !selected
            ? '尚未选择可用连接'
            : !verified
              ? '当前连接待验证'
              : loading
                ? '正在核对模型目录'
                : '当前选择尚未就绪'}
      </p>
      {(selected || value.providerId) && (
        <div
          className="model-selection-identity model-selection-reading"
          role="region"
          aria-label="当前连接与型号完整名称"
          tabIndex={0}
        >
          <strong>{selected?.label || '原连接不可用'}</strong>
          {model?.name && model.name !== value.model && <span>{model.name}</span>}
          <span>{value.model || '尚未选择型号'}</span>
          {value.reasoningEffort && <small>推理强度 · {value.reasoningEffort}</small>}
        </div>
      )}
      {selected && (
        <details className="model-selection-source">
          <summary>连接标识与版本</summary>
          <dl
            className="model-selection-reading"
            role="region"
            tabIndex={0}
            aria-label="当前模型连接完整标识与版本"
          >
            <div>
              <dt>连接标识</dt>
              <dd>{selected.id}</dd>
            </div>
            <div>
              <dt>配置版本</dt>
              <dd>{selected.revision}</dd>
            </div>
            <div>
              <dt>验证版本</dt>
              <dd>{selected.checkedRevision ?? '尚未验证'}</dd>
            </div>
          </dl>
        </details>
      )}
      {preserveInvalid && selected && !usesCatalog && !apiBindingMatches && (
        <div className="field-error model-selection-mismatch" role="status">
          <p>保存的型号或思考强度已与当前连接不同，请确认后采用当前配置。</p>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => change(defaultChoice(providers, selected.id))}
          >
            采用当前连接配置
          </button>
        </div>
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
                : error
                  ? '模型目录暂不可读'
                  : !catalogReady
                    ? '模型目录待读取'
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
        <p
          className="inline-warning model-selection-reading"
          role="alert"
          aria-label="模型目录读取失败全文"
          tabIndex={0}
        >
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
