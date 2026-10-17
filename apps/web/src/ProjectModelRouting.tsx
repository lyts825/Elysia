import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { RoleRoutingPolicy, type RoleRoutingView } from '../../../packages/contracts/src/model-routing';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import type { WorkbenchCache } from './WorkbenchCache';

const routingPayload = z
  .object({ expectedRevision: z.number().int().nonnegative(), policy: RoleRoutingPolicy })
  .strict();
export const routingDraftShape = routingPayload
  .extend({ pending: routingPayload.extend({ commandId: z.string().uuid() }).optional() })
  .strict();
type RoutingDraft = z.infer<typeof routingDraftShape>;
type Request = NonNullable<RoutingDraft['pending']>;
const message = (issue: unknown) => (issue instanceof Error ? issue.message : '请求失败，输入已保留。');

export function ProjectModelRouting(props: { projectId: string; cache: WorkbenchCache; archived?: boolean }) {
  return <RoutingEditor key={props.projectId} {...props} />;
}
function RoutingEditor({
  projectId,
  cache,
  archived = false,
}: {
  projectId: string;
  cache: WorkbenchCache;
  archived?: boolean;
}) {
  const { api, mutation } = useSurfaceClient();
  const [record, setRecord] = useState<RoleRoutingView>();
  const [ready, setReady] = useState(false),
    [reading, setReading] = useState(false),
    [current, setCurrent] = useState(false);
  const [readError, setReadError] = useState(''),
    [saveError, setSaveError] = useState(''),
    [draftError, setDraftError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0),
    [, refresh] = useState(0);
  const live = useRef(true),
    writing = useRef(false),
    reader = useRef<AbortController | null>(null);
  const key = `draft:project-intelligence:${projectId}`,
    endpoint = `/projects/${projectId}/model-routing`;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      reader.current?.abort();
    };
  }, []);
  useEffect(() => {
    let active = true;
    void cache
      .ensureKey(key)
      .then(() => {
        if (active) {
          setReady(true);
          setDraftError('');
        }
      })
      .catch((issue) => {
        if (active) setDraftError(message(issue));
      });
    return () => {
      active = false;
    };
  }, [cache, key, retry]);
  function container() {
    const raw = cache.get(key);
    const value = raw === undefined || raw === '' ? { version: 1 } : JSON.parse(String(raw));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1)
      throw Error('项目能力草稿无法读取，角色模型输入未覆盖。');
    return value as Record<string, unknown>;
  }
  let saved: RoutingDraft | undefined,
    parseError = '';
  try {
    if (ready) {
      const value = container().routing;
      if (value !== undefined) saved = routingDraftShape.parse(value);
    }
  } catch (issue) {
    parseError = message(issue);
  }
  const draft = saved ?? (record ? { expectedRevision: record.revision, policy: record.policy } : undefined);
  const pending = saved?.pending;
  const locked = busy || !!pending || archived || !ready || !!parseError;
  const stale = !!record && !!draft && record.revision !== draft.expectedRevision;
  function update(change: (value: RoutingDraft | undefined) => RoutingDraft | undefined) {
    try {
      if (!ready || !live.current) return false;
      const all = container(),
        previous = all.routing === undefined ? undefined : routingDraftShape.parse(all.routing),
        next = change(previous);
      if (next) all.routing = routingDraftShape.parse(next);
      else delete all.routing;
      const raw = JSON.stringify(all);
      if (raw.length > 200000) throw Error('项目草稿超过容量，角色模型原稿保留。');
      cache.set(key, raw);
      refresh((value) => value + 1);
      setDraftError('');
      return true;
    } catch (issue) {
      setDraftError(message(issue));
      return false;
    }
  }
  async function read() {
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    setReading(true);
    setCurrent(false);
    setReadError('');
    try {
      const next = await api<RoleRoutingView>(endpoint, undefined, undefined, controller.signal);
      if (next.projectId !== projectId) throw Error('角色模型配置所属不匹配。');
      if (live.current && !controller.signal.aborted) {
        setRecord(next);
        setCurrent(true);
      }
    } catch (issue) {
      if (live.current && !controller.signal.aborted) setReadError(message(issue));
    } finally {
      if (live.current && reader.current === controller) {
        setReading(false);
        reader.current = null;
      }
    }
  }
  useEffect(() => {
    void read();
  }, [api, projectId]);
  function change(patch: Partial<RoleRoutingPolicy>) {
    if (!draft || locked) return;
    update((value) => ({ ...(value ?? draft), policy: { ...(value?.policy ?? draft.policy), ...patch } }));
    setNotice('');
  }
  async function save(request: Request) {
    if (writing.current || archived || !live.current) return;
    if (
      !update((value) => {
        if (value?.pending) {
          if (JSON.stringify(value.pending) !== JSON.stringify(request))
            throw Error('待核对的角色保存请求已变化。');
          return value;
        }
        if (
          pending ||
          !current ||
          stale ||
          !value ||
          value.expectedRevision !== request.expectedRevision ||
          JSON.stringify(value.policy) !== JSON.stringify(request.policy)
        )
          throw Error('角色输入或版本已变化，请重新核对。');
        return { ...value, pending: request };
      })
    )
      return;
    writing.current = true;
    setBusy(true);
    setSaveError('');
    setNotice('');
    try {
      const next = await mutation<RoleRoutingView>(endpoint, request, 'PUT');
      if (next.projectId !== projectId) throw Error('角色模型保存结果所属不匹配，需核对原请求。');
      if (!live.current) return;
      reader.current?.abort();
      setReading(false);
      setRecord(next);
      setCurrent(true);
      setReadError('');
      update((value) =>
        value?.pending?.commandId === request.commandId
          ? JSON.stringify(value.policy) === JSON.stringify(request.policy)
            ? undefined
            : { ...value, pending: undefined }
          : value,
      );
      setNotice('角色模型已保存，只影响之后创建的任务。协调模型仍由创建表单明确选择。');
    } catch (issue) {
      if (!live.current) return;
      const definitive =
        issue instanceof ApiError &&
        issue.kind === 'http' &&
        (issue.status ?? 0) >= 400 &&
        (issue.status ?? 0) < 500;
      if (definitive) {
        update((value) =>
          value?.pending?.commandId === request.commandId ? { ...value, pending: undefined } : value,
        );
        setCurrent(false);
      }
      setSaveError(
        message(issue) +
          (definitive ? ' 请重新读取并核对，输入已保留。' : ' 结果尚未确认，请重试核对同一请求。'),
      );
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  }
  const describe = (policy: z.infer<typeof RoleRoutingPolicy>) =>
    `${policy.enabled ? '启用' : '关闭'}；执行：${record?.providers.find((value) => value.id === policy.worker)?.label ?? policy.worker ?? '每次明确选择'}；复核：${record?.providers.find((value) => value.id === policy.reviewer)?.label ?? policy.reviewer ?? '每次明确选择'}`;
  return (
    <section className="intelligence-section" aria-label="项目角色模型">
      <h3>角色模型</h3>
      <p className="field-help">
        新任务冻结执行和复核模型；已有任务及累计预算保持。费用未知时无法承诺节省比例。
      </p>
      <div className="intelligence-read">
        <button type="button" className="secondary" disabled={busy || reading} onClick={() => void read()}>
          {reading ? '正在读取角色配置…' : '重新读取角色配置'}
        </button>
        {reading && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              reader.current?.abort();
              setReading(false);
              setCurrent(false);
              setReadError('角色配置读取已取消，保留上次结果与输入。');
            }}
          >
            取消读取角色配置
          </button>
        )}
        {record && !current && <span>当前配置尚未重新确认。</span>}
      </div>
      {(readError || saveError || draftError || parseError) && (
        <p className="field-error" role="alert">
          {readError || saveError || draftError || parseError}
          {!ready && (
            <button type="button" className="text-button" onClick={() => setRetry((value) => value + 1)}>
              重试角色草稿
            </button>
          )}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div className="intelligence-issue">
          <p>上次角色保存结果待核对，原输入与请求已保留。</p>
          <button
            type="button"
            className="secondary"
            disabled={busy || archived}
            onClick={() => void save(pending)}
          >
            重试核对角色保存
          </button>
        </div>
      )}
      {!draft ? (
        <p role="status">尚未读取角色配置。</p>
      ) : (
        <>
          <label className="intelligence-check">
            <input
              type="checkbox"
              checked={draft.policy.enabled}
              disabled={locked}
              onChange={(event) => change({ enabled: event.target.checked })}
            />
            启用项目角色模型
          </label>
          {(['worker', 'reviewer'] as const).map((role) => (
            <label className="intelligence-search" key={role}>
              {role === 'worker' ? '执行任务' : '复核任务'}
              <select
                disabled={locked}
                value={draft.policy[role] ?? ''}
                onChange={(event) => change({ [role]: event.target.value || null })}
              >
                <option value="">每次明确选择</option>
                {draft.policy[role] &&
                  !record?.providers.some((provider) => provider.id === draft.policy[role]) && (
                    <option value={draft.policy[role]!}>已失效的连接</option>
                  )}
                {record?.providers.map((provider) => (
                  <option key={provider.id} value={provider.id} disabled={!provider.verified}>
                    {provider.label} · {provider.model} ·{' '}
                    {provider.verified
                      ? provider.priceKnown
                        ? `${provider.currency}价格已知`
                        : '费用未知'
                      : '需验证'}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {stale && (
            <div className="intelligence-issue">
              <p>角色配置已变化，请比较后再保存。</p>
              <p>当前配置：{describe(record!.policy)}</p>
              <p>我的输入：{describe(draft.policy)}</p>
              <button
                type="button"
                className="secondary"
                disabled={locked || !current}
                onClick={() =>
                  update((value) => (value ? { ...value, expectedRevision: record!.revision } : value))
                }
              >
                保留角色选择，以当前版本核对
              </button>
            </div>
          )}
          <div className="project-actions">
            <button
              type="button"
              className="secondary"
              disabled={locked || !current || stale || !saved}
              onClick={() =>
                void save({
                  expectedRevision: draft.expectedRevision,
                  policy: draft.policy,
                  commandId: crypto.randomUUID(),
                })
              }
            >
              保存角色模型
            </button>
            {saved && !pending && (
              <button
                type="button"
                className="text-button"
                disabled={locked}
                onClick={() => update(() => undefined)}
              >
                舍弃角色配置草稿
              </button>
            )}
          </div>
          <p className="field-help">角色输入随本机项目草稿保留，关闭后可继续核对。</p>
        </>
      )}
    </section>
  );
}
