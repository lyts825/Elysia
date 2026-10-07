import { useEffect, useRef, useState } from 'react';
import type { ProviderConfig } from '../../../packages/contracts/src/index';
import { api, mutation } from './api';
import { manageUsage } from './desktop';

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
type Model = {
  id: string;
  name: string;
  description: string;
  efforts: string[];
  defaultEffort: string;
  isDefault: boolean;
};
export function CodexSettings({
  config,
  change,
}: {
  config: ProviderConfig;
  change: (patch: Partial<ProviderConfig>) => void;
}) {
  const [source, setSource] = useState(
    config.subscriptionAccountId?.startsWith('codex-elysia-') ? 'elysia' : 'local',
  );
  const [status, setStatus] = useState<State>();
  const [models, setModels] = useState<Model[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [usage, setUsage] = useState<any>();
  const generation = useRef(0),
    current = useRef({ config, change });
  current.current = { config, change };
  const refresh = async (reconnect = false) => {
    const seq = ++generation.current;
    setBusy(true);
    setError('');
    setUsage(undefined);
    try {
      const state = await api<State>(`/codex/status?source=${source}${reconnect ? '&refresh=1' : ''}`);
      if (generation.current !== seq) return;
      setStatus(state);
      setModels([]);
      if (state.connected && state.accountId) {
        const list = await api<Model[]>('/codex/' + state.accountId + '/models');
        if (generation.current !== seq) return;
        setModels(list);
        const selected =
          list.find((m) => m.id === current.current.config.model) || list.find((m) => m.isDefault) || list[0];
        if (selected)
          current.current.change({
            subscriptionAccountId: state.accountId,
            model: selected.id,
            reasoningEffort: selected.efforts.includes(current.current.config.reasoningEffort || '')
              ? current.current.config.reasoningEffort
              : (selected.defaultEffort as ProviderConfig['reasoningEffort']),
          });
      }
    } catch (e) {
      if (generation.current === seq) setError((e as Error).message);
    } finally {
      if (generation.current === seq) setBusy(false);
    }
  };
  useEffect(() => {
    setStatus(undefined);
    setModels([]);
    void refresh();
    return () => {
      generation.current++;
    };
  }, [source]);
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
  const selected = models.find((m) => m.id === config.model);
  const pending = status?.attempt?.status === 'pending';
  const buckets = usage?.rateLimitsByLimitId
    ? Object.values(usage.rateLimitsByLimitId)
    : usage?.rateLimits
      ? [usage.rateLimits]
      : [];
  return (
    <section className="connection-panel">
      <div className="section-heading">
        <strong>ChatGPT 订阅连接</strong>
        <span className="provider-badge">Codex 官方通道</span>
      </div>
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
          1 · {status?.available ? `Codex ${status.version || '已连接'}` : '检测 Codex'}
        </span>
        <span className={status?.connected ? 'passed' : ''}>
          2 · {status?.connected ? `${status.plan || 'ChatGPT'} 已登录` : '连接账号'}
        </span>
        <span className={models.length ? 'passed' : ''}>
          3 · {models.length ? `${models.length} 个可选模型` : '读取模型'}
        </span>
      </div>
      {status?.label && <p className="account-label">{status.label}</p>}
      {status?.message && <p className="inline-warning">{status.message}</p>}
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
      {pending && (
        <p className="info-note">
          请在授权页面完成登录，然后返回此窗口。
          {status?.attempt?.userCode && (
            <>
              设备码：<strong className="device-code">{status.attempt.userCode}</strong>
            </>
          )}
        </p>
      )}
      {status?.attempt?.message && <p className="field-help">{status.attempt.message}</p>}
      <label>
        可用模型
        <select
          disabled={busy || !models.length}
          value={config.model}
          onChange={(e) => {
            const m = models.find((m) => m.id === e.target.value)!;
            change({ model: m.id, reasoningEffort: m.defaultEffort as ProviderConfig['reasoningEffort'] });
          }}
        >
          {!models.length && <option value={config.model}>{config.model || '连接账号后选择'}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {m.id}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <>
          <p className="field-help">{selected.description}</p>
          <label>
            思考强度
            <select
              value={config.reasoningEffort || selected.defaultEffort}
              onChange={(e) =>
                change({ reasoningEffort: e.target.value as ProviderConfig['reasoningEffort'] })
              }
            >
              {selected.efforts.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
        </>
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
      {!!buckets.length && (
        <div className="quota-grid">
          {buckets.map((bucket: any, i) => (
            <div key={bucket.limitId || i}>
              <strong>{bucket.limitName || bucket.limitId || '订阅额度'}</strong>
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
        <p className="inline-warning" role="alert">
          {error}
        </p>
      )}
      <p className="field-help">自动沿用 Windows 系统代理。模型目录仅表示可选择，保存后还需验证实际调用。</p>
    </section>
  );
}
