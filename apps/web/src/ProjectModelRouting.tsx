import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { RoleRoutingPolicy, type RoleRoutingView } from '../../../packages/contracts/src/model-routing';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import type { WorkbenchCache } from './WorkbenchCache';
import './project-model-routing.css';

const routingPayload = z
  .object({ expectedRevision: z.number().int().nonnegative(), policy: RoleRoutingPolicy })
  .strict();
export const routingDraftShape = routingPayload
  .extend({ pending: routingPayload.extend({ commandId: z.string().uuid() }).optional() })
  .strict();
type RoutingDraft = z.infer<typeof routingDraftShape>;
type Request = NonNullable<RoutingDraft['pending']>;
const message = (issue: unknown) => (issue instanceof Error ? issue.message : '请求失败，输入已保留。');

function RoutingSelection({
  selected,
  providers,
}: {
  selected: string | null;
  providers: RoleRoutingView['providers'] | undefined;
}) {
  if (!selected) return <p>每次创建任务时明确选择。</p>;
  const provider = providers?.find((value) => value.id === selected);
  return (
    <dl className="routing-selection">
      <div>
        <dt>连接名称</dt>
        <dd>{provider?.label ?? (providers ? '已失效的连接' : '连接信息尚未读取')}</dd>
      </div>
      <div>
        <dt>连接标识</dt>
        <dd>{selected}</dd>
      </div>
      {provider && (
        <>
          <div>
            <dt>模型</dt>
            <dd>{provider.model}</dd>
          </div>
          <div>
            <dt>验证状态</dt>
            <dd>{provider.verified ? '已验证' : '需验证'}</dd>
          </div>
          <div>
            <dt>费用信息</dt>
            <dd>{provider.priceKnown ? `${provider.currency}价格已知` : '费用未知'}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

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
  const fieldId = useId();
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
  return (
    <section className="intelligence-section project-model-routing" aria-label="项目角色模型">
      <h3>角色模型</h3>
      <p className="field-help">
        新任务冻结执行和复核模型；已有任务及累计预算保持。费用未知时无法承诺节省比例。
      </p>
      {archived && (
        <p className="routing-status" role="status">
          项目已归档，角色模型仅供核对。
        </p>
      )}
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
      {(
        [
          ['配置读取失败', readError],
          ['角色模型保存未完成', saveError],
          ['本机草稿读写失败', draftError],
          ['本机草稿格式无法读取', parseError],
        ] as const
      ).map(
        ([title, detail]) =>
          detail && (
            <div className="routing-error" role="alert" key={title}>
              <strong>{title}</strong>
              <p className="routing-reading" role="region" aria-label={`${title}完整说明`} tabIndex={0}>
                {detail}
              </p>
              {title === '本机草稿读写失败' && !ready && (
                <button type="button" className="text-button" onClick={() => setRetry((value) => value + 1)}>
                  重试角色草稿
                </button>
              )}
            </div>
          ),
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
          <dl className="routing-basis" id={`${fieldId}-basis`}>
            <div>
              <dt>已读配置</dt>
              <dd>{record ? `版本 ${record.revision}${current ? '' : ' · 尚未重新确认'}` : '尚未读回'}</dd>
            </div>
            <div>
              <dt>当前输入依据</dt>
              <dd>
                {saved ? '本机草稿' : '已读配置'} · 版本 {draft.expectedRevision}
              </dd>
            </div>
          </dl>
          <label className="intelligence-check">
            <input
              type="checkbox"
              checked={draft.policy.enabled}
              disabled={locked}
              onChange={(event) => change({ enabled: event.target.checked })}
            />
            启用项目角色模型
          </label>
          <div className="routing-roles">
            {(['worker', 'reviewer'] as const).map((role) => (
              <div className="routing-role" key={role}>
                <label htmlFor={`${fieldId}-${role}`}>
                  {role === 'worker' ? '执行任务' : '复核任务'}
                  <select
                    id={`${fieldId}-${role}`}
                    aria-describedby={`${fieldId}-${role}-help`}
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
                <p className="field-help" id={`${fieldId}-${role}-help`}>
                  所选连接的完整信息见下方。
                </p>
                <div
                  className="routing-reading"
                  role="region"
                  aria-label={`${role === 'worker' ? '执行任务' : '复核任务'}所选连接完整信息`}
                  tabIndex={0}
                >
                  <RoutingSelection selected={draft.policy[role]} providers={record?.providers} />
                </div>
              </div>
            ))}
          </div>
          {stale && (
            <div className="intelligence-issue">
              <p>角色配置已变化，请比较后再保存。</p>
              <div className="routing-comparison">
                {(
                  [
                    ['当前配置', record!.revision, record!.policy],
                    ['我的输入', draft.expectedRevision, draft.policy],
                  ] as const
                ).map(([title, revision, policy]) => (
                  <section className="routing-comparison-card" key={title} aria-label={title}>
                    <h4>{title}</h4>
                    <p>
                      版本 {revision} · {policy.enabled ? '启用' : '关闭'}
                    </p>
                    <div
                      className="routing-reading"
                      role="region"
                      aria-label={`${title}角色选择完整信息`}
                      tabIndex={0}
                    >
                      {(['worker', 'reviewer'] as const).map((role) => (
                        <div key={role}>
                          <h5>{role === 'worker' ? '执行任务' : '复核任务'}</h5>
                          <RoutingSelection selected={policy[role]} providers={record?.providers} />
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
              <button
                type="button"
                className="secondary"
                disabled={locked || !current}
                aria-describedby={`${fieldId}-basis ${fieldId}-rebase`}
                onClick={() =>
                  update((value) => (value ? { ...value, expectedRevision: record!.revision } : value))
                }
              >
                保留角色选择，以当前版本核对
              </button>
              <p className="field-help" id={`${fieldId}-rebase`}>
                仅更新本机输入的版本依据，角色选择保持；还需明确保存。
              </p>
            </div>
          )}
          <div className="project-actions routing-actions">
            <button
              type="button"
              className="secondary"
              disabled={locked || !current || stale || !saved}
              aria-describedby={`${fieldId}-basis ${fieldId}-save`}
              onClick={() =>
                void save({
                  expectedRevision: draft.expectedRevision,
                  policy: draft.policy,
                  commandId: crypto.randomUUID(),
                })
              }
            >
              {busy ? '正在保存角色模型…' : '保存角色模型'}
            </button>
            {saved && !pending && (
              <button
                type="button"
                className="text-button"
                disabled={locked}
                aria-describedby={`${fieldId}-discard`}
                onClick={() => update(() => undefined)}
              >
                舍弃角色配置草稿
              </button>
            )}
          </div>
          <p className="field-help" id={`${fieldId}-save`}>
            保存只影响之后创建的任务；关闭角色模型时，当前角色选择仍保留在配置中。
          </p>
          {saved && !pending && (
            <p className="field-help" id={`${fieldId}-discard`}>
              舍弃只移除本机角色配置草稿，其他项目草稿和已保存配置保留。
            </p>
          )}
          <p className="field-help">角色输入随本机项目草稿保留，关闭后可继续核对。</p>
        </>
      )}
    </section>
  );
}
