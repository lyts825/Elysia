import { useEffect, useRef, useState } from 'react';
import { api, mutation } from './api';
import { manageUsage } from './desktop';
import { catalogIssue, initialTextModel, supportsText, type CatalogModel } from './ModelCatalog';

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
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [accountId, selected?.connected, selected?.planEnabled, selected?.usageBlocked, reload]);
  const chosenModel = models.find((item) => item.id === model);
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
    <section className="subscription-card">
      <strong>使用 ChatGPT 订阅</strong>
      <p className="field-help">通过 OpenAI 官方授权使用账号可用的模型和额度。登录时会打开系统浏览器。</p>
      {!status?.available && <p className="inline-warning">{status?.message || '正在读取系统加密凭据…'}</p>}
      {!!status?.accounts.length && (
        <label>
          订阅账号
          <select
            value={accountId || ''}
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
        </label>
      )}
      <div className="subscription-actions">
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
      {selected?.connected && !selected.planEnabled && (
        <button className="secondary" disabled={busy} onClick={() => void login(selected.id, true)}>
          授权使用订阅额度
        </button>
      )}
      {selected?.connected && selected.planEnabled && (
        <>
          {!selected.welcomed && (
            <div className="subscription-welcome" role="dialog" aria-label="正在使用 ChatGPT 订阅">
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
          <label>
            账号可用模型
            <select
              value={model}
              disabled={loading || !models.some(supportsText)}
              onChange={(e) => {
                const next = models.find((item) => item.id === e.target.value);
                if (next && supportsText(next)) change({ model: next.id });
              }}
            >
              {!models.length && <option value="">{loading ? '正在读取…' : '暂无可用模型'}</option>}
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
          {!loading && !error && catalogIssue(models, model) && (
            <p className="inline-warning" role="alert">
              {catalogIssue(models, model)}
            </p>
          )}
          <div className="subscription-actions">
            <button className="secondary" disabled={loading} onClick={() => setReload((v) => v + 1)}>
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
        <p className="field-help" role="status">
          {notice}
        </p>
      )}
      {status?.attempt?.status === 'failed' && (
        <p className="inline-warning" role="alert">
          {status.attempt.message}
        </p>
      )}
      {error && (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
