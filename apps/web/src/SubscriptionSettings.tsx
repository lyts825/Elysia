/* 管理订阅相关设置。 */
import { useEffect, useId, useRef, useState } from 'react';
import { useSurfaceClient } from './SurfaceClientContext';
import { manageUsage } from './desktop';
import { catalogIssue, initialTextModel, supportsText, type CatalogModel } from './ModelCatalog';
import './subscription-settings.css';

type Account = {
  id: string;
  label: string;
  connected: boolean;
  planEnabled: boolean;
  welcomed: boolean;
  usageBlocked: boolean;
};
type State = {
  available: boolean;
  message?: string;
  accounts: Account[];
  attempt?: { id: string; status: string; accountId?: string; message?: string };
};
export function SubscriptionSettings({
  accountId,
  model,
  change,
  ready,
}: {
  accountId?: string | null;
  model: string;
  change: (values: { subscriptionAccountId?: string; model?: string }) => void;
  ready?: (valid: boolean) => void;
}) {
  const { api, mutation } = useSurfaceClient();
  // 账号连接状态和可选模型目录独立读取，选择变更由父组件保存。
  const accountHelpId = useId(),
    modelHelpId = useId();
  const [status, setStatus] = useState<State>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false),
    [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(false),
    [reload, setReload] = useState(0),
    [loadedCatalog, setLoadedCatalog] = useState('');
  const pending = useRef(''),
    changeRef = useRef(change),
    modelRef = useRef(model);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusError = useRef(false);
  const catalogFocusRequested = useRef(false);
  useEffect(() => {
    if (!error || !focusError.current) return;
    focusError.current = false;
    errorRef.current?.focus({ preventScroll: true });
    errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  changeRef.current = change;
  modelRef.current = model;
  const selected = status?.accounts.find((a) => a.id === accountId);
  const catalogKey = `${accountId}:${!!selected?.connected}:${!!selected?.planEnabled}:${!!selected?.usageBlocked}:${reload}`;
  const refresh = async () => {
    const value = await api<State>('/subscription');
    setStatus(value);
    return value;
  };
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const value = await api<State>('/subscription');
        if (!alive) return;
        setStatus(value);
        if (pending.current === value.attempt?.id && value.attempt?.status === 'completed') {
          changeRef.current({ subscriptionAccountId: value.attempt.accountId, model: '' });
          pending.current = '';
          setNotice(value.attempt.message || '登录成功');
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const focusOnFailure = catalogFocusRequested.current;
    catalogFocusRequested.current = false;
    setModels([]);
    setLoadedCatalog('');
    setLoading(false);
    if (!accountId || !selected?.connected || !selected.planEnabled || selected.usageBlocked) return;
    setLoading(true);
    setError('');
    api<CatalogModel[]>('/subscription/' + accountId + '/models')
      .then((values) => {
        if (!alive) return;
        setModels(values);
        setLoadedCatalog(catalogKey);
        if (!modelRef.current) {
          const initial = initialTextModel(values);
          if (initial) changeRef.current({ model: initial.id });
        }
      })
      .catch((e) => {
        if (alive) {
          focusError.current = focusOnFailure;
          setError(e.message);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [accountId, selected?.connected, selected?.planEnabled, selected?.usageBlocked, reload]);
  const chosenModel = models.find((item) => item.id === model);
  const catalogCurrent = loadedCatalog === catalogKey;
  const valid =
    !!selected?.connected &&
    selected.planEnabled &&
    !selected.usageBlocked &&
    loadedCatalog === catalogKey &&
    !loading &&
    !busy &&
    !error &&
    !!chosenModel &&
    supportsText(chosenModel);
  useEffect(() => {
    ready?.(valid);
  }, [valid, ready]);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      focusError.current = true;
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const login = (id?: string, consent = false) =>
    act(async () => {
      const result = await mutation('/subscription/login', { accountId: id, consent });
      pending.current = result.id;
      setNotice('请在系统浏览器中完成 OpenAI 授权，然后返回此窗口。');
    });
  const waiting = ['pending', 'exchanging'].includes(status?.attempt?.status || '');
  return (
    <section className="subscription-card subscription-settings" aria-label="ChatGPT 订阅配置">
      <header className="subscription-heading">
        <h3>使用 ChatGPT 订阅</h3>
        <span className="subscription-readiness" data-ready={valid} role="status">
          {valid ? '模型可用' : busy ? '正在处理' : loading ? '正在读取模型' : '尚未就绪'}
        </span>
      </header>
      <p className="field-help">通过 OpenAI 官方授权使用账号可用的模型和额度。登录时会打开系统浏览器。</p>
      {!status?.available && (
        <p className="inline-warning subscription-reading" tabIndex={0} aria-label="订阅可用性说明">
          {status?.message ||
            (status
              ? '当前环境尚未提供可用的订阅接入。'
              : error
                ? '订阅账号状态尚未读取成功，请核对下方说明。'
                : '正在读取系统加密凭据…')}
        </p>
      )}
      {!!status?.accounts.length && (
        <label className="subscription-field">
          订阅账号
          <select
            value={accountId || ''}
            aria-describedby={selected ? accountHelpId : undefined}
            onChange={(e) => change({ subscriptionAccountId: e.target.value, model: '' })}
          >
            <option value="">选择账号或添加账号</option>
            {status.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {!a.connected ? ' · 已退出' : !a.planEnabled ? ' · 未授权订阅' : ''}
              </option>
            ))}
          </select>
          <small className="subscription-catalog-status">本次已读 {status.accounts.length} 个账号</small>
        </label>
      )}
      {status && accountId && !selected && (
        <p
          className="inline-warning subscription-reading"
          role="status"
          tabIndex={0}
          aria-label="当前订阅账号选择问题"
        >
          当前选择的账号不在本次已读列表中：<code>{accountId}</code>。请重新选择账号后核对模型。
        </p>
      )}
      {selected && (
        <section className="subscription-selected" aria-label="当前订阅账号">
          <h4>当前账号</h4>
          <dl
            className="subscription-reading subscription-identity"
            id={accountHelpId}
            tabIndex={0}
            aria-label="当前订阅账号完整名称与标识"
          >
            <div>
              <dt>名称</dt>
              <dd>{selected.label}</dd>
            </div>
            <div>
              <dt>账号标识</dt>
              <dd>
                <code>{selected.id}</code>
              </dd>
            </div>
          </dl>
          <dl className="subscription-account-state">
            <div>
              <dt>连接</dt>
              <dd>{selected.connected ? '已登录' : '已退出'}</dd>
            </div>
            <div>
              <dt>订阅授权</dt>
              <dd>{selected.planEnabled ? '已授权' : '未授权'}</dd>
            </div>
            <div>
              <dt>额度</dt>
              <dd>{selected.usageBlocked ? '受限，已暂停新请求' : '未标记受限'}</dd>
            </div>
          </dl>
        </section>
      )}
      <div className="subscription-actions" role="group" aria-label="订阅账号授权操作">
        <button
          className="chatgpt-signin"
          disabled={busy || waiting || !status?.available}
          onClick={() => void login(selected?.id)}
        >
          Continue with ChatGPT
        </button>
        {!!status?.accounts.length && (
          <button
            className="secondary"
            disabled={busy || waiting || !status?.available}
            onClick={() => void login()}
          >
            添加账号 / 工作区
          </button>
        )}
        {waiting && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(() => mutation('/subscription/cancel', {}))}
          >
            取消登录
          </button>
        )}
      </div>
      {(waiting || status?.attempt?.status === 'failed') && (
        <section className="subscription-auth-progress" aria-label="订阅授权进度">
          <h4>
            {status?.attempt?.status === 'exchanging'
              ? '正在完成授权'
              : status?.attempt?.status === 'failed'
                ? '授权未完成'
                : '等待浏览器授权'}
          </h4>
          {status?.attempt?.status === 'failed' ? (
            <p
              className="inline-warning subscription-reading"
              role="alert"
              tabIndex={0}
              aria-label="订阅登录失败详情"
            >
              {status.attempt.message}
            </p>
          ) : (
            <p className="subscription-reading" role="status" tabIndex={0} aria-label="订阅授权进度详情">
              {status?.attempt?.message || '请完成系统浏览器中的授权，或使用取消登录停止等待。'}
            </p>
          )}
          <p className="field-help">授权完成后，仍需核对所选账号与模型是否就绪。</p>
        </section>
      )}
      {selected?.connected && !selected.planEnabled && (
        <button className="secondary" disabled={busy} onClick={() => void login(selected.id, true)}>
          授权使用订阅额度
        </button>
      )}
      {selected?.connected && selected.planEnabled && (
        <>
          {!selected.welcomed && (
            <div className="subscription-welcome" role="region" aria-label="正在使用 ChatGPT 订阅">
              <strong>正在使用 ChatGPT 订阅</strong>
              <p>
                选择并验证此账号的模型后，合资格的调用将使用你的 ChatGPT 订阅或获准使用的额度，可在 ChatGPT
                设置中管理。
              </p>
              <button
                className="primary"
                onClick={() => void act(() => mutation('/subscription/' + selected.id + '/welcome', {}))}
              >
                知道了
              </button>
            </div>
          )}
          <label className="subscription-field">
            账号可用模型
            <small className="subscription-catalog-status" role="status">
              {loading
                ? '正在读取所选账号的模型目录…'
                : catalogCurrent
                  ? `当前账号已读 ${models.length} 个型号，其中 ${models.filter(supportsText).length} 个支持文字对话`
                  : '当前账号的模型目录尚未读回，暂不能判断可用型号数量。'}
            </small>
            <select
              value={model}
              aria-describedby={model ? modelHelpId : undefined}
              disabled={loading || !models.some(supportsText)}
              onChange={(e) => {
                const next = models.find((item) => item.id === e.target.value);
                if (next && supportsText(next)) change({ model: next.id });
              }}
            >
              {!models.length && (
                <option value="">
                  {loading ? '正在读取…' : catalogCurrent ? '当前账号没有可用型号' : '当前目录尚未读回'}
                </option>
              )}
              {!!models.length && !chosenModel && (
                <option value={model} disabled>
                  {model ? `${model}（已不可用，请重新选择）` : '请选择文字型号'}
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
          {model && (
            <section className="subscription-selected" aria-label="当前订阅模型">
              <h4>当前模型</h4>
              <dl
                className="subscription-reading subscription-identity"
                id={modelHelpId}
                tabIndex={0}
                aria-label="当前订阅模型完整名称与标识"
              >
                {chosenModel?.name && (
                  <div>
                    <dt>名称</dt>
                    <dd>{chosenModel.name}</dd>
                  </div>
                )}
                <div>
                  <dt>型号标识</dt>
                  <dd>
                    <code>{model}</code>
                  </dd>
                </div>
              </dl>
              {chosenModel?.description && (
                <details>
                  <summary>模型说明</summary>
                  <p className="subscription-reading" tabIndex={0} aria-label="当前订阅模型完整说明">
                    {chosenModel.description}
                  </p>
                </details>
              )}
            </section>
          )}
          {catalogCurrent && !loading && !error && catalogIssue(models, model) && (
            <p className="inline-warning" role="alert">
              {catalogIssue(models, model)}
            </p>
          )}
          <div className="subscription-actions" role="group" aria-label="订阅模型目录与用量操作">
            <button
              className="secondary"
              disabled={loading}
              onClick={() => {
                catalogFocusRequested.current = true;
                setReload((v) => v + 1);
              }}
            >
              刷新模型
            </button>
            <button className="secondary" onClick={manageUsage}>
              管理 ChatGPT 用量
            </button>
            {selected.usageBlocked && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await mutation('/subscription/' + selected.id + '/retry', {});
                    catalogFocusRequested.current = true;
                    setReload((v) => v + 1);
                  })
                }
              >
                重新检查额度
              </button>
            )}
          </div>
          {selected.usageBlocked && (
            <p className="inline-warning">订阅额度受限，新请求已暂停。管理用量后可重新验证并恢复任务。</p>
          )}
        </>
      )}
      {selected?.connected && (
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const result = await mutation('/subscription/' + selected.id + '/logout', {});
              setNotice(result.message);
            })
          }
        >
          退出此账号
        </button>
      )}
      {notice && (
        <p className="field-help subscription-reading" role="status" tabIndex={0} aria-label="订阅操作结果">
          {notice}
        </p>
      )}
      {error && (
        <p
          className="provider-error subscription-reading"
          role="alert"
          aria-label="订阅操作失败详情"
          ref={errorRef}
          tabIndex={0}
        >
          {error}
        </p>
      )}
    </section>
  );
}
