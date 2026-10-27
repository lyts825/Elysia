/**
 * 配置 Codex 连接及相关设置。
 * 读取并编辑Codex连接、登录与探测状态，按配置版本核对保存结果；认证和实际连接检查由宿主服务执行。
 * EN: Edits Codex connection configuration and related settings. Reads and edits Codex connection, sign-in, and probe state and reconciles saves by configuration revision; authentication and actual connection checks run in the host service.
 */
import { useEffect, useRef, useState } from 'react';
import type { ProviderConfig } from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';
import { manageUsage } from './desktop';
import {
  catalogIssue,
  initialEffort,
  initialTextModel,
  supportsText,
  type CatalogModel,
} from './ModelCatalog';
import './codex-connection.css';

type State = {
  available: boolean;
  connected: boolean;
  version?: string;
  accountId?: string;
  label?: string;
  plan?: string;
  message?: string;
  attempt?: { status: string; userCode?: string; message?: string };
};
/**
 * 将本机 Codex 登录或 Elysia 独立登录绑定到供应商草稿，登录状态和型号目录分别核对。
 * refresh 序号使切换来源后的旧结果失效；只有账号身份、当前目录、文字型号和思考强度
 * 都匹配才向父级报告 ready，连接成功本身不代表型号选择已可保存。
 * EN: Bind either local Codex login or a separate Elysia login to the provider draft, checking login state and model catalog separately. A refresh sequence invalidates old results after source changes. Report ready only when account identity, current catalog, text model, and reasoning effort agree; a connected account alone is not a saveable model selection.
 */
export function CodexSettings({
  config,
  change,
  ready,
}: {
  config: ProviderConfig;
  change: (patch: Partial<ProviderConfig>) => void;
  ready?: (valid: boolean) => void;
}) {
  const { api, mutation } = useSurfaceClient();
  /**
   * 连接来源、登录状态和模型目录分别维护，更新配置由父组件持有。
   * EN: Track connection source, login status, and model catalog independently; the parent owns configuration updates.
   */
  const [source, setSource] = useState(
    config.subscriptionAccountId?.startsWith('codex-elysia-') ? 'elysia' : 'local',
  );
  const [status, setStatus] = useState<State>();
  const [models, setModels] = useState<CatalogModel[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [catalogLoaded, setCatalogLoaded] = useState(false),
    [usage, setUsage] = useState<any>();
  const generation = useRef(0),
    current = useRef({ config, change });
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusError = useRef(false);
  /**
   * 仅对操作流程请求聚焦的新错误移动焦点和滚动；消费一次标志，避免后续渲染反复抢焦点。
   * EN: Focuses and reveals a new error only when requested by an action flow, consuming the flag to prevent repeated focus theft on rerender.
   */
  useEffect(() => {
    if (!error || !focusError.current) return;
    focusError.current = false;
    errorRef.current?.focus({ preventScroll: true });
    errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  current.current = { config, change };
  /**
   * 先读取连接状态再读取该账号目录；仅空型号自动选默认，已保存但失效型号保留供用户处理。
   * EN: Read connection status before the account-specific catalog. Auto-select a default only for an empty model field; keep a saved but invalid model visible for the user to resolve.
   */
  const refresh = async (reconnect = false, focusOnFailure = reconnect) => {
    const seq = ++generation.current;
    setBusy(true);
    setCatalogLoaded(false);
    setError('');
    setUsage(undefined);
    try {
      const state = await api<State>(`/codex/status?source=${source}${reconnect ? '&refresh=1' : ''}`);
      if (generation.current !== seq) return;
      setStatus(state);
      setModels([]);
      if (state.connected && state.accountId) {
        const list = await api<CatalogModel[]>('/codex/' + state.accountId + '/models');
        if (generation.current !== seq) return;
        setModels(list);
        setCatalogLoaded(true);
        const config = current.current.config;
        const selected = list.find((m) => m.id === config.model);
        const initial = !config.model ? initialTextModel(list) : undefined;
        current.current.change({
          subscriptionAccountId: state.accountId,
          ...(initial ? { model: initial.id, reasoningEffort: initialEffort(initial) } : {}),
          ...(selected &&
          supportsText(selected) &&
          selected.efforts?.length &&
          config.reasoningEffort === undefined
            ? { reasoningEffort: initialEffort(selected) }
            : {}),
        });
      }
    } catch (e) {
      if (generation.current === seq) {
        focusError.current = focusOnFailure;
        setError((e as Error).message);
      }
    } finally {
      if (generation.current === seq) setBusy(false);
    }
  };
  /**
   * 连接来源变化时清空目录并刷新；清理增加代次，让refresh中的版本检查拒绝已过期结果。
   * EN: Clears the catalog and refreshes when connection source changes; cleanup advances the generation so refresh guards reject obsolete results.
   */
  useEffect(() => {
    setStatus(undefined);
    setModels([]);
    void refresh();
    return () => {
      generation.current++;
    };
  }, [source]);
  /**
   * 登录尝试待完成时每两秒读取状态，完成后刷新目录；状态离开pending或卸载时停止定时器，已发出的读取由其回调处理。
   * EN: Polls sign-in status every two seconds while pending and refreshes the catalog after completion; leaving pending or unmounting clears the interval while dispatched reads finish through their callbacks.
   */
  useEffect(() => {
    if (status?.attempt?.status !== 'pending') return;
    const timer = setInterval(async () => {
      try {
        const state = await api<State>('/codex/status?source=elysia');
        setStatus(state);
        if (state.attempt?.status === 'completed') void refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [status?.attempt?.status]);
  /**
   * 登录或退出动作完成后统一重读状态，错误只改变反馈，不替换父级尚未保存的草稿。
   * EN: Reread status after login or logout. Errors change feedback only and do not replace an unsaved parent draft.
   */
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh(false, true);
    } catch (e) {
      focusError.current = true;
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const selected = models.find((m) => m.id === config.model);
  const pending = status?.attempt?.status === 'pending';
  const valid =
    !!status?.connected &&
    status.accountId === config.subscriptionAccountId &&
    catalogLoaded &&
    !busy &&
    !pending &&
    !!selected &&
    supportsText(selected) &&
    (!selected.efforts?.length || selected.efforts.includes(config.reasoningEffort || ''));
  /**
   * 选值有效性或回调变化时向父组件同步就绪标志，供外层控制保存和启动。
   * EN: Reports readiness to the parent when validity or its callback changes so outer flows can gate saving and launch.
   */
  useEffect(() => {
    ready?.(valid);
  }, [valid, ready]);
  const buckets = usage?.rateLimitsByLimitId
    ? Object.values(usage.rateLimitsByLimitId)
    : usage?.rateLimits
      ? [usage.rateLimits]
      : [];
  return (
    <section className="connection-panel codex-connection">
      <div className="section-heading codex-connection-heading">
        <h3>ChatGPT 订阅连接</h3>
        <span className="provider-badge">Codex 官方通道</span>
      </div>
      <p className="codex-readiness" data-ready={valid} role="status">
        {busy
          ? '正在处理连接操作…'
          : pending
            ? '等待完成登录'
            : valid
              ? '账号与所选型号已就绪'
              : '连接与型号尚未全部就绪'}
      </p>
      <label>
        登录来源
        <select
          value={source}
          disabled={busy || pending}
          onChange={(e) => {
            setSource(e.target.value);
            change({ subscriptionAccountId: null, model: '', reasoningEffort: null });
          }}
        >
          <option value="local">复用本机 Codex 登录</option>
          <option value="elysia">在 Elysia 中独立登录</option>
        </select>
      </label>
      <p className="field-help">
        {source === 'local'
          ? '使用 Codex 当前登录环境中的 ChatGPT 账号。更换账号后，重新连接并验证。'
          : '独立登录由官方 Codex 管理，登录时打开系统授权页面。也可使用设备码完成授权。'}
      </p>
      <div className="connection-stages">
        <span className={status?.available ? 'passed' : ''}>
          1 · {status?.available ? 'Codex 可用' : '检测 Codex'}
        </span>
        <span className={status?.connected ? 'passed' : ''}>
          2 · {status?.connected ? '账号已登录' : '连接账号'}
        </span>
        <span className={catalogLoaded && !busy && models.some(supportsText) ? 'passed' : ''}>
          3 ·{' '}
          {busy
            ? '正在处理连接操作…'
            : catalogLoaded
              ? `${models.filter(supportsText).length} 个文字型号 / ${models.length} 个型号`
              : '模型目录尚未读回'}
        </span>
      </div>
      {status && (
        <section className="codex-identity">
          <h4>当前读取的登录环境</h4>
          <dl className="codex-reading" tabIndex={0} role="region" aria-label="Codex 登录环境完整信息">
            <div>
              <dt>来源</dt>
              <dd>{source === 'local' ? '本机 Codex 登录' : 'Elysia 独立登录'}</dd>
            </div>
            <div>
              <dt>Codex 版本</dt>
              <dd>{status.version || '未提供'}</dd>
            </div>
            <div>
              <dt>账号名称</dt>
              <dd>{status.label || '未提供'}</dd>
            </div>
            <div>
              <dt>账号标识</dt>
              <dd>{status.accountId || '未提供'}</dd>
            </div>
            <div>
              <dt>订阅方案</dt>
              <dd>{status.plan || '未提供'}</dd>
            </div>
          </dl>
        </section>
      )}
      {status?.message && (
        <p className="inline-warning codex-reading" tabIndex={0} aria-label="Codex 连接提示全文">
          {status.message}
        </p>
      )}
      <div className="subscription-actions">
        <button className="secondary" disabled={busy || pending} onClick={() => void refresh(true)}>
          {busy ? '连接中…' : '重新连接 / 刷新模型'}
        </button>
        {source === 'elysia' && (
          <>
            <button
              className="chatgpt-signin"
              disabled={busy || pending || !status?.available}
              onClick={() => void act(() => mutation('/codex/login', { method: 'browser' }))}
            >
              使用 ChatGPT 登录
            </button>
            <button
              className="secondary"
              disabled={busy || pending || !status?.available}
              onClick={() => void act(() => mutation('/codex/login', { method: 'device' }))}
            >
              设备码登录
            </button>
            {status?.connected && (
              <button
                className="secondary"
                disabled={busy || pending}
                onClick={() =>
                  void act(async () => {
                    await mutation('/codex/logout', {});
                    change({ subscriptionAccountId: null, model: '' });
                  })
                }
              >
                退出 Elysia 登录
              </button>
            )}
          </>
        )}
        {pending && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(() => mutation('/codex/cancel', {}))}
          >
            取消登录
          </button>
        )}
      </div>
      {(pending || status?.attempt?.message) && (
        <section
          className="codex-login-progress"
          data-status={status?.attempt?.status}
          aria-label="Codex 登录进度"
        >
          <h4>
            {pending ? '等待完成登录' : status?.attempt?.status === 'failed' ? '登录未完成' : '登录进度'}
          </h4>
          {pending && (
            <div className="info-note codex-login-pending" role="status">
              <p>请在授权页面完成登录，然后返回此窗口。</p>
              {status?.attempt?.userCode && (
                <p className="codex-reading" tabIndex={0} aria-label="完整登录设备码">
                  设备码：<strong className="device-code">{status.attempt.userCode}</strong>
                </p>
              )}
            </div>
          )}
          {status?.attempt?.message && (
            <p
              className="field-help codex-reading"
              role={status.attempt.status === 'failed' ? 'alert' : 'status'}
              tabIndex={0}
              aria-label="Codex 登录进度全文"
            >
              {status.attempt.message}
            </p>
          )}
        </section>
      )}
      <div className="form-columns connection-models">
        <label>
          可用模型
          <small className="codex-catalog-status" role="status">
            {busy
              ? '正在处理连接操作…'
              : catalogLoaded
                ? `本次已读 ${models.length} 个型号`
                : '目录尚未读回，暂不能判断型号数量。'}
          </small>
          <select
            disabled={busy || !models.some(supportsText)}
            value={config.model}
            onChange={(e) => {
              const m = models.find((m) => m.id === e.target.value);
              if (!m || !supportsText(m)) return;
              change({ model: m.id, reasoningEffort: initialEffort(m) });
            }}
          >
            {!models.length && (
              <option value={config.model}>
                {catalogLoaded
                  ? '当前账号没有可用型号'
                  : config.model
                    ? `${config.model}（目录尚未读回）`
                    : '连接账号后选择'}
              </option>
            )}
            {!!models.length && !selected && (
              <option value={config.model} disabled>
                {config.model ? `${config.model}（已不可用，请重新选择）` : '请选择文字型号'}
              </option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!supportsText(m)}>
                {m.name || m.id} · {m.id}
                {!supportsText(m) ? '（不支持文字对话）' : ''}
              </option>
            ))}
          </select>
        </label>
        {selected && supportsText(selected) && !!selected.efforts?.length && (
          <label>
            思考强度
            <select
              value={config.reasoningEffort || ''}
              disabled={busy}
              onChange={(e) =>
                change({ reasoningEffort: e.target.value as ProviderConfig['reasoningEffort'] })
              }
            >
              {!selected.efforts.includes(config.reasoningEffort || '') && (
                <option value={config.reasoningEffort || ''} disabled>
                  {config.reasoningEffort
                    ? `${config.reasoningEffort}（已不可用，请重新选择）`
                    : '请选择思考强度'}
                </option>
              )}
              {selected.efforts.map((e) => (
                <option key={e} value={e}>
                  {{
                    none: '无',
                    minimal: '最少',
                    low: '低',
                    medium: '中',
                    high: '高',
                    xhigh: '更高',
                    max: '最高',
                    ultra: '极高',
                  }[e] || e}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {(selected || config.model) && (
        <section className="codex-identity">
          <h4>当前所选型号</h4>
          <dl className="codex-reading" tabIndex={0} role="region" aria-label="Codex 所选型号完整名称与标识">
            <div>
              <dt>名称</dt>
              <dd>
                {selected?.name || selected?.id || (catalogLoaded ? '当前目录未找到' : '尚未读取本次目录')}
              </dd>
            </div>
            <div>
              <dt>型号标识</dt>
              <dd>{config.model}</dd>
            </div>
            <div>
              <dt>思考强度</dt>
              <dd>{config.reasoningEffort || '未指定'}</dd>
            </div>
          </dl>
          {selected?.description && (
            <details>
              <summary>型号说明</summary>
              <p className="codex-reading" tabIndex={0} aria-label="Codex 型号完整说明">
                {selected.description}
              </p>
            </details>
          )}
        </section>
      )}
      {catalogLoaded && status?.connected && !busy && !error && catalogIssue(models, config.model) && (
        <p className="inline-warning" role="alert">
          {catalogIssue(models, config.model)}
        </p>
      )}
      {catalogLoaded &&
        !busy &&
        selected &&
        supportsText(selected) &&
        !!selected.efforts?.length &&
        config.reasoningEffort !== undefined &&
        !selected.efforts.includes(config.reasoningEffort || '') && (
          <p className="inline-warning" role="alert">
            所选思考强度不在当前目录中，请重新选择。
          </p>
        )}
      <div className="subscription-actions">
        <button
          className="secondary"
          disabled={!status?.connected || busy}
          onClick={async () => {
            setError('');
            try {
              setUsage(await api('/codex/' + status!.accountId + '/usage'));
            } catch (e) {
              focusError.current = true;
              setError((e as Error).message);
            }
          }}
        >
          查看剩余额度
        </button>
        <button className="text-button" onClick={() => manageUsage()}>
          管理订阅
        </button>
      </div>
      {usage !== undefined && !buckets.length && (
        <p className="field-help" role="status">
          已读结果未提供额度窗口，剩余比例未知。
        </p>
      )}
      {!!buckets.length && (
        <div className="quota-grid">
          {buckets.map((bucket: any, i) => (
            <div key={bucket.limitId || i}>
              <strong className="codex-reading" tabIndex={0} aria-label={`第 ${i + 1} 项额度完整名称`}>
                {bucket.limitName || bucket.limitId || '订阅额度'}
              </strong>
              {!bucket.primary && !bucket.secondary && <p>本项未提供额度窗口，剩余比例未知。</p>}
              {[bucket.primary, bucket.secondary].filter(Boolean).map((w: any, j) => (
                <p key={j}>
                  {w.windowDurationMins
                    ? `${w.windowDurationMins >= 1440 ? Math.round(w.windowDurationMins / 1440) + ' 天' : w.windowDurationMins / 60 + ' 小时'}：`
                    : ''}
                  剩余{' '}
                  {w.usedPercent == null ? '未知' : Math.max(0, Math.min(100, 100 - w.usedPercent)) + '%'}
                  {w.resetsAt && <small> · {new Date(w.resetsAt * 1000).toLocaleString()} 重置</small>}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
      {error && (
        <p
          className="provider-error codex-reading"
          role="alert"
          aria-label="Codex 操作失败详情"
          ref={errorRef}
          tabIndex={0}
        >
          {error}
        </p>
      )}
      <p className="field-help">自动沿用 Windows 系统代理。模型目录仅表示可选择，保存后还需验证实际调用。</p>
    </section>
  );
}
