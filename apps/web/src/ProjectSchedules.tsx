import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ProjectScheduleCreate,
  ProjectScheduleUpdate,
  ProjectScheduleSettings,
  type ProjectSchedule,
  type ProjectScheduleList,
  type ProjectSchedulePreview,
} from '../../../packages/contracts/src/project-schedules';
import { ApiError } from './api';
import { useSurfaceClient } from './SurfaceClientContext';
import type { WorkbenchCache } from './WorkbenchCache';
import { ProjectScheduleHistory } from './ProjectScheduleHistory';
import './project-schedules.css';

const fieldsShape = z
  .object({
    sourceRunId: z.string(),
    scheduleId: z.string().optional(),
    name: z.string().max(160),
    mode: z.enum(['review', 'execute']),
    interval: z.string().max(10),
    count: z.string().max(10),
    until: z.string().max(40),
  })
  .strict();
const pendingShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), body: ProjectScheduleCreate }).strict(),
  z.object({ kind: z.literal('update'), id: z.string().uuid(), body: ProjectScheduleUpdate }).strict(),
]);
const draftShape = z
  .object({ version: z.literal(1), fields: fieldsShape, pending: pendingShape.optional() })
  .strict();
type Draft = z.infer<typeof draftShape>;
type Pending = z.infer<typeof pendingShape>;
const message = (error: unknown) => (error instanceof Error ? error.message : '请求失败，请重试。');
const stateLabels = { draft: '待启用', enabled: '已启用', paused: '已暂停', completed: '已结束' };
const localDate = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const initialFields = (): Draft['fields'] => ({
  sourceRunId: '',
  name: '',
  mode: 'review',
  interval: '60',
  count: '3',
  until: localDate(new Date(Date.now() + 7 * 86400000).toISOString()),
});
const recordFields = (record: ProjectSchedule): Draft['fields'] => ({
  sourceRunId: record.template.sourceRunId,
  scheduleId: record.id,
  name: record.settings.name,
  mode: record.settings.mode,
  interval: String(record.settings.intervalMinutes),
  count: String(record.settings.maxRuns),
  until: localDate(record.settings.until),
});
function parseDraft(raw: unknown): Draft {
  if (raw === undefined || raw === '') return { version: 1, fields: initialFields() };
  if (typeof raw !== 'string' || raw.length > 200000) throw Error('定时任务草稿无法读取，原文保留。');
  const result = draftShape.safeParse(JSON.parse(raw));
  if (!result.success) throw Error('定时任务草稿格式或版本无法读取，原文保留。');
  return result.data;
}

type ProjectSchedulesProps = {
  projectId: string;
  cache: WorkbenchCache;
  archived?: boolean;
  openRun: (id: string) => Promise<void>;
};
export function ProjectSchedules(props: ProjectSchedulesProps) {
  return <ProjectSchedulePanel key={props.projectId} {...props} />;
}
function ProjectSchedulePanel({ projectId, cache, archived = false, openRun }: ProjectSchedulesProps) {
  const { api, mutation } = useSurfaceClient();
  const base = `/projects/${projectId}/schedules`,
    key = `draft:project-schedules:${projectId}`;
  const [list, setList] = useState<ProjectScheduleList>();
  const [preview, setPreview] = useState<ProjectSchedulePreview>();
  const [historyId, setHistoryId] = useState('');
  const [loaded, setLoaded] = useState(false),
    [retryDraft, setRetryDraft] = useState(0),
    [, render] = useState(0);
  const [reading, setReading] = useState(false),
    [previewing, setPreviewing] = useState(false),
    [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState(false),
    [previewCurrent, setPreviewCurrent] = useState(false);
  const [readError, setReadError] = useState(''),
    [previewError, setPreviewError] = useState(''),
    [actionError, setActionError] = useState(''),
    [draftError, setDraftError] = useState(''),
    [notice, setNotice] = useState('');
  const [reviewed, setReviewed] = useState(false),
    [automatic, setAutomatic] = useState(false),
    [deleteTarget, setDeleteTarget] = useState<{ id: string; revision: number }>(),
    [resetConfirmed, setResetConfirmed] = useState(false);
  const live = useRef(true),
    writing = useRef(false),
    listReader = useRef<AbortController | null>(null),
    previewReader = useRef<AbortController | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      listReader.current?.abort();
      previewReader.current?.abort();
    };
  }, []);
  useEffect(() => {
    let active = true;
    void cache
      .ensureKey(key)
      .then(() => {
        if (active) {
          setLoaded(true);
          setDraftError('');
        }
      })
      .catch((error) => {
        if (active) setDraftError(message(error));
      });
    return () => {
      active = false;
    };
  }, [cache, key, retryDraft]);
  let draft: Draft | undefined,
    parseError = '';
  try {
    if (loaded) draft = parseDraft(cache.get(key));
  } catch (error) {
    parseError = message(error);
  }
  const fields = draft?.fields,
    pending = draft?.pending;
  const locked = busy || !!pending || archived || !draft;
  const selected = list?.schedules.find((item) => item.id === fields?.scheduleId);
  const shown = preview ?? selected;
  useEffect(() => setDeleteTarget(undefined), [selected?.id, selected?.revision]);
  function change(update: (value: Draft) => Draft) {
    try {
      const next = draftShape.parse(update(parseDraft(cache.get(key))));
      const text = JSON.stringify(next);
      if (text.length > 200000) throw Error('定时任务草稿超过容量上限，未覆盖原稿。');
      cache.set(key, text);
      render((n) => n + 1);
      setDraftError('');
      return true;
    } catch (error) {
      setDraftError(message(error));
      return false;
    }
  }
  function edit(values: Partial<Draft['fields']>) {
    if (locked) return;
    if (change((value) => ({ ...value, fields: { ...value.fields, ...values } }))) {
      setReviewed(false);
      setAutomatic(false);
      setDeleteTarget(undefined);
      setNotice('');
      if (values.sourceRunId !== undefined) {
        previewReader.current?.abort();
        setPreview(undefined);
        setPreviewCurrent(false);
        setPreviewing(false);
        setPreviewError('');
      }
    }
  }
  async function read() {
    listReader.current?.abort();
    const controller = new AbortController();
    listReader.current = controller;
    setReading(true);
    setCurrent(false);
    setReadError('');
    setReviewed(false);
    setAutomatic(false);
    setDeleteTarget(undefined);
    try {
      const result = await api<ProjectScheduleList>(base, undefined, undefined, controller.signal);
      if (result.projectId !== projectId || result.schedules.some((item) => item.projectId !== projectId))
        throw Error('定时任务所属项目不匹配。');
      if (live.current && !controller.signal.aborted) {
        setList(result);
        setCurrent(true);
      }
    } catch (error) {
      if (live.current && !controller.signal.aborted) setReadError(message(error));
    } finally {
      if (live.current && !controller.signal.aborted) setReading(false);
    }
  }
  useEffect(() => {
    void read();
  }, [api, projectId]);
  async function readPreview() {
    if (!fields?.sourceRunId || locked) return;
    previewReader.current?.abort();
    const controller = new AbortController();
    previewReader.current = controller;
    setPreviewing(true);
    setPreviewCurrent(false);
    setPreviewError('');
    setReviewed(false);
    setAutomatic(false);
    setDeleteTarget(undefined);
    try {
      const result = await api<ProjectSchedulePreview>(
        `${base}/preview?sourceRunId=${encodeURIComponent(fields.sourceRunId)}`,
        undefined,
        undefined,
        controller.signal,
      );
      if (result.projectId !== projectId || result.template.sourceRunId !== fields.sourceRunId)
        throw Error('模板来源不匹配。');
      if (live.current && !controller.signal.aborted) {
        setPreview(result);
        setPreviewCurrent(true);
      }
    } catch (error) {
      if (live.current && !controller.signal.aborted) setPreviewError(message(error));
    } finally {
      if (live.current && !controller.signal.aborted) setPreviewing(false);
    }
  }
  function select(record?: ProjectSchedule) {
    if (locked) return;
    const next = record ? recordFields(record) : initialFields();
    if (!change((value) => ({ ...value, fields: next }))) return;
    previewReader.current?.abort();
    setPreviewing(false);
    setPreview(undefined);
    setPreviewCurrent(false);
    setPreviewError('');
    setReviewed(false);
    setAutomatic(false);
    setDeleteTarget(undefined);
    setNotice('');
  }
  function settings() {
    if (!fields) throw Error('草稿尚未读取。');
    if (!fields.until || !Number.isFinite(Date.parse(fields.until))) throw Error('请选择有效截止时间。');
    const until =
      selected && fields.until === localDate(selected.settings.until)
        ? selected.settings.until
        : new Date(fields.until).toISOString();
    const result = ProjectScheduleSettings.safeParse({
      name: fields.name,
      mode: fields.mode,
      intervalMinutes: Number(fields.interval),
      maxRuns: Number(fields.count),
      until,
    });
    if (!result.success) throw Error('请填写名称、至少 5 分钟的间隔、1–100 次的上限及有效截止时间。');
    return result.data;
  }
  async function send(request: Pending) {
    if (writing.current || archived || !loaded) return;
    if (!change((value) => ({ ...value, pending: request }))) return;
    writing.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');
    setDeleteTarget(undefined);
    listReader.current?.abort();
    setReading(false);
    setCurrent(false);
    try {
      const result = (await mutation(
        request.kind === 'create' ? base : `${base}/${request.id}`,
        request.body,
        request.kind === 'create' ? 'POST' : 'PUT',
      )) as ProjectSchedule | { deleted: true; id: string };
      if (!live.current) return;
      const deleting = request.kind === 'update' && request.body.action === 'delete';
      if (deleting) {
        if (!result || !('deleted' in result) || result.deleted !== true || result.id !== request.id)
          throw new ApiError('删除结果的定时任务不匹配。', 'protocol');
      } else {
        if (
          !result ||
          !('projectId' in result) ||
          result.projectId !== projectId ||
          !z.string().uuid().safeParse(result.id).success ||
          (request.kind === 'update' && result.id !== request.id) ||
          (request.kind === 'create' && result.template?.sourceRunId !== request.body.sourceRunId)
        )
          throw new ApiError('保存结果的项目或定时任务不匹配。', 'protocol');
      }
      change((value) => {
        if (value.pending?.body.commandId !== request.body.commandId) return value;
        const replaceFields =
          request.kind === 'create' ||
          (value.fields.scheduleId === request.id &&
            (request.body.action === 'refresh' || request.body.action === 'delete'));
        return {
          ...value,
          pending: undefined,
          ...(replaceFields
            ? { fields: deleting ? initialFields() : recordFields(result as ProjectSchedule) }
            : {}),
        };
      });
      setReviewed(false);
      setAutomatic(false);
      setDeleteTarget(undefined);
      setPreviewCurrent(false);
      setPreview(undefined);
      setPreviewError('');
      setNotice(
        request.kind === 'create'
          ? '定时任务草稿已保存并打开；核对后可显式启用。'
          : '操作已保存，请核对最新状态。',
      );
      await read();
    } catch (error) {
      if (!live.current) return;
      const definitive =
        error instanceof ApiError &&
        error.kind === 'http' &&
        (error.status ?? 0) >= 400 &&
        (error.status ?? 0) < 500;
      if (definitive)
        change((value) =>
          value.pending?.body.commandId === request.body.commandId ? { ...value, pending: undefined } : value,
        );
      setActionError(
        message(error) +
          (definitive
            ? ' 输入已保留，请重新读取并核对后再操作。'
            : ' 结果尚未确认，原请求已保留，请核对同一请求。'),
      );
      setCurrent(false);
      setReviewed(false);
      setAutomatic(false);
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  }
  function saveTemplate() {
    if (locked || !current || !previewCurrent || !preview || !reviewed) return;
    try {
      const next = settings();
      if (fields?.scheduleId) {
        if (!selected) throw Error('当前定时任务已不在列表中，请重新读取。');
        void send({
          kind: 'update',
          id: selected.id,
          body: {
            commandId: crypto.randomUUID(),
            expectedRevision: selected.revision,
            action: 'refresh',
            captureHash: preview.captureHash,
            expectedSourceRevision: preview.template.sourceRevision,
            settings: next,
          },
        });
      } else
        void send({
          kind: 'create',
          body: {
            commandId: crypto.randomUUID(),
            sourceRunId: preview.template.sourceRunId,
            expectedSourceRevision: preview.template.sourceRevision,
            captureHash: preview.captureHash,
            settings: next,
          },
        });
    } catch (error) {
      setActionError(message(error));
    }
  }
  function act(record: ProjectSchedule, action: 'enable' | 'pause' | 'delete') {
    if (locked || !current) return;
    if (
      action === 'enable' &&
      (!reviewed || !unchanged || (record.settings.mode === 'execute' && !automatic))
    )
      return;
    if (action === 'delete' && (deleteTarget?.id !== record.id || deleteTarget.revision !== record.revision))
      return;
    void send({
      kind: 'update',
      id: record.id,
      body: {
        commandId: crypto.randomUUID(),
        expectedRevision: record.revision,
        action,
        ...(action === 'enable'
          ? {
              captureHash: record.captureHash,
              ...(record.settings.mode === 'execute' ? { confirmAutomaticExecution: true as const } : {}),
            }
          : {}),
      },
    });
  }
  let unchanged = false;
  try {
    const next = settings();
    unchanged =
      !!selected &&
      Object.entries(next).every(
        ([field, value]) => selected.settings[field as keyof ProjectScheduleSettings] === value,
      ) &&
      (!preview || preview.captureHash === selected.captureHash);
  } catch {
    /* Incomplete inputs keep activation disabled. */
  }
  const totalRuns = Number(fields?.count) || 0,
    budget = shown?.template.contract.budget;
  const exportDraft = () => {
    const raw = cache.get(key),
      url = URL.createObjectURL(
        new Blob([typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')], {
          type: 'text/plain;charset=utf-8',
        }),
      );
    const link = document.createElement('a');
    link.href = url;
    link.download = `project-schedules-${projectId}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="project-schedules" aria-label="项目定时任务">
      <header>
        <div>
          <h2>项目定时任务</h2>
          <p>
            复用已核对的原生任务。默认到期创建暂停任务，启动后才生成计划。服务关闭时不运行，重启跳过错过时段。
          </p>
        </div>
        <div className="schedule-actions">
          <button className="secondary" disabled={busy || reading} onClick={() => void read()}>
            {reading ? '正在读取定时任务…' : '刷新定时任务'}
          </button>
          {reading && (
            <button
              className="text-button"
              onClick={() => {
                listReader.current?.abort();
                setReading(false);
                setCurrent(false);
                setReadError('读取已取消，保留上次列表及草稿。');
              }}
            >
              取消读取定时任务
            </button>
          )}
          <button className="secondary" disabled={locked} onClick={() => select()}>
            新建定时任务
          </button>
        </div>
      </header>
      {archived && <p role="status">项目已归档；定时任务只读，到期检查会暂停调度。</p>}
      {(readError || actionError || draftError || parseError) && (
        <p className="field-error" role="alert">
          {readError || actionError || draftError || parseError}
        </p>
      )}
      {!loaded && (
        <button className="secondary" onClick={() => setRetryDraft((n) => n + 1)}>
          重试定时任务草稿
        </button>
      )}
      {parseError && (
        <div>
          <button className="secondary" onClick={exportDraft}>
            导出定时任务原稿
          </button>
          <label className="schedule-check">
            <input
              type="checkbox"
              checked={resetConfirmed}
              onChange={(e) => setResetConfirmed(e.target.checked)}
            />
            <span>我已保留原稿，清空不可读的本地草稿</span>
          </label>
          <button
            className="secondary"
            disabled={!resetConfirmed || archived}
            onClick={() => {
              cache.set(key, '');
              render((n) => n + 1);
              setResetConfirmed(false);
            }}
          >
            清空定时任务草稿
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div className="schedule-notice">
          <p>上次操作结果待核对。请求已保留，重试不会重复创建同一条任务。</p>
          <button className="secondary" disabled={busy || archived} onClick={() => void send(pending)}>
            核对同一定时请求
          </button>
        </div>
      )}
      <div className="schedule-list">
        {list?.schedules.map((record) => (
          <article
            key={record.id}
            aria-labelledby={`schedule-title-${record.id}`}
            data-selected={selected?.id === record.id || undefined}
          >
            <div className="schedule-card-heading">
              <h3 className="schedule-card-title" id={`schedule-title-${record.id}`}>
                {record.settings.name}
              </h3>
              <div className="schedule-card-state">
                <span className="schedule-status" data-state={record.status}>
                  {stateLabels[record.status]}
                </span>
                <span className="schedule-mode">
                  {record.settings.mode === 'review' ? '创建暂停任务' : '自动执行'}
                </span>
              </div>
            </div>
            <dl className="schedule-metrics">
              <div>
                <dt>间隔</dt>
                <dd>{record.settings.intervalMinutes} 分钟</dd>
              </div>
              <div>
                <dt>创建进度</dt>
                <dd>
                  {record.createdCount} / {record.settings.maxRuns} 次
                </dd>
              </div>
              <div>
                <dt>已跳过</dt>
                <dd>{record.skippedCount} 个时段</dd>
              </div>
            </dl>
            <dl className="schedule-timing">
              <div>
                <dt>下次调度</dt>
                <dd>{record.nextDueAt ? new Date(record.nextDueAt).toLocaleString() : '—'}</dd>
              </div>
              <div>
                <dt>截止时间</dt>
                <dd>{new Date(record.settings.until).toLocaleString()}</dd>
              </div>
            </dl>
            {record.reason && <p className="schedule-reason">{record.reason}</p>}
            <div className="schedule-actions">
              <button
                className="secondary"
                aria-label={`核对与编辑：${record.settings.name}`}
                disabled={locked || !current}
                onClick={() => select(record)}
              >
                核对与编辑
              </button>
              {record.status === 'enabled' && (
                <button
                  className="secondary"
                  disabled={locked || !current}
                  onClick={() => act(record, 'pause')}
                >
                  暂停后续调度
                </button>
              )}
              {record.lastRunId && (
                <button
                  className="text-button"
                  onClick={() =>
                    void openRun(record.lastRunId!).catch((error) => setActionError(message(error)))
                  }
                >
                  打开最近任务
                </button>
              )}
              <button
                type="button"
                className="text-button"
                aria-expanded={historyId === record.id}
                onClick={() => setHistoryId((currentId) => (currentId === record.id ? '' : record.id))}
              >
                查看创建历史
              </button>
            </div>
            {historyId === record.id && (
              <ProjectScheduleHistory
                projectId={projectId}
                scheduleId={record.id}
                name={record.settings.name}
                close={() => setHistoryId('')}
                openRun={openRun}
              />
            )}
          </article>
        ))}
      </div>
      {list && !list.schedules.length && <p>尚无定时任务。选择一条不带附件或快照的项目任务作为模板。</p>}
      {fields && (
        <div className="schedule-editor">
          <h3>{fields.scheduleId ? '核对已保存的定时任务' : '创建定时任务草稿'}</h3>
          <fieldset disabled={locked}>
            <label>
              来源任务
              <select
                value={fields.sourceRunId}
                disabled={!!fields.scheduleId}
                onChange={(e) => edit({ sourceRunId: e.target.value })}
              >
                <option value="">选择任务</option>
                {fields.sourceRunId && !list?.sources.some((source) => source.id === fields.sourceRunId) && (
                  <option value={fields.sourceRunId}>
                    {selected?.template.sourceTitle ?? fields.sourceRunId}（不在当前候选中）
                  </option>
                )}
                {list?.sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.title} · {source.status}
                  </option>
                ))}
              </select>
            </label>
            {list?.sourcesLimited && <p className="field-help">显示最近 50 条原生任务。</p>}
            <label>
              名称
              <input maxLength={160} value={fields.name} onChange={(e) => edit({ name: e.target.value })} />
            </label>
            <div className="schedule-fields">
              <label>
                间隔（分钟）
                <input
                  type="number"
                  min={5}
                  max={44640}
                  value={fields.interval}
                  onChange={(e) => edit({ interval: e.target.value })}
                />
              </label>
              <label>
                累计最多创建次数
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={fields.count}
                  onChange={(e) => edit({ count: e.target.value })}
                />
              </label>
              <label>
                截止时间（本地）
                <input
                  type="datetime-local"
                  value={fields.until}
                  onChange={(e) => edit({ until: e.target.value })}
                />
              </label>
            </div>
            <label>
              到期行为
              <select
                value={fields.mode}
                onChange={(e) => edit({ mode: e.target.value as 'review' | 'execute' })}
              >
                <option value="review">创建暂停任务，等待我启动并接受计划</option>
                <option value="execute">按已核对的权限和预算自动执行</option>
              </select>
            </label>
          </fieldset>
          <p className="field-help">
            截止时间须在未来 31
            天内。重新核对不会清零累计次数。上次任务未结束则跳过时段；配置变化、失败或待核验操作会暂停调度。
          </p>
          <div className="schedule-actions">
            <button
              className="secondary"
              disabled={locked || !fields.sourceRunId || previewing}
              onClick={() => void readPreview()}
            >
              {previewing ? '正在读取来源模板…' : '读取当前来源模板'}
            </button>
            {previewing && (
              <button
                className="text-button"
                onClick={() => {
                  previewReader.current?.abort();
                  setPreviewing(false);
                  setPreviewCurrent(false);
                  setPreviewError('模板读取已取消，保留上次内容。');
                }}
              >
                取消读取来源模板
              </button>
            )}
          </div>
          {previewError && (
            <p className="field-error" role="alert">
              {previewError}
            </p>
          )}
          {shown && (
            <div className="schedule-template">
              <h4>
                {preview ? (previewCurrent ? '当前来源模板' : '上次读取的来源模板') : '已保存的冻结模板'}
              </h4>
              <p>
                {shown.template.sourceTitle} · {shown.template.provider.label} /{' '}
                {shown.template.provider.model}
              </p>
              <p className="schedule-objective" role="region" aria-label="定时任务完整目标" tabIndex={0}>
                {shown.template.objective}
              </p>
              <p>
                每次最多 {budget?.maxRequests.toLocaleString()} 个请求、{budget?.maxTokens.toLocaleString()}{' '}
                Token；{totalRuns} 次累计上限 {((budget?.maxRequests ?? 0) * totalRuns).toLocaleString()}{' '}
                个请求、{((budget?.maxTokens ?? 0) * totalRuns).toLocaleString()} Token。
              </p>
              <p>
                {budget?.maxCost == null
                  ? '未设置货币预算；未知价格不作费用承诺。'
                  : `每次货币预算上限 ${budget.maxCost}，累计上限 ${budget.maxCost * totalRuns}（沿用来源任务的计价口径）。`}
              </p>
              <p>
                权限：读取{shown.template.contract.permissionProfile.read ? '允许' : '关闭'}；写入
                {shown.template.contract.permissionProfile.write ? '允许' : '关闭'}；执行命令
                {shown.template.contract.permissionProfile.exec ? '允许' : '关闭'}。
              </p>
              <p>
                写入路径：{shown.template.contract.permissionProfile.writePaths.join('、') || '无'}
                ；允许网址：{shown.template.contract.permissionProfile.urls.join('、') || '无'}。
              </p>
              <details>
                <summary>完整任务约定、执行限制与上下文策略</summary>
                <pre tabIndex={0} role="region" aria-label="完整任务约定、执行限制与上下文策略">
                  {JSON.stringify(
                    {
                      contract: shown.template.contract,
                      limits: shown.template.limits,
                      contextPolicy: shown.template.contextPolicy,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <p className="field-help">
                项目目录：{shown.template.environment.workspaceRoot}
                。保存时绑定当前项目能力、记忆、角色路由及模型配置；之后变化须重新核对。
              </p>
              <label className="schedule-check">
                <input
                  type="checkbox"
                  disabled={locked || !current || previewing || (!!preview && !previewCurrent)}
                  checked={reviewed}
                  onChange={(e) => {
                    setReviewed(e.target.checked);
                    setAutomatic(false);
                  }}
                />
                <span>我已核对以上模板、权限、预算、次数和截止时间</span>
              </label>
              {selected?.settings.mode === 'execute' && unchanged && (
                <label className="schedule-check">
                  <input
                    type="checkbox"
                    disabled={locked || !reviewed}
                    checked={automatic}
                    onChange={(e) => setAutomatic(e.target.checked)}
                  />
                  <span>允许到期后自动执行，可能使用上述写入、命令和网络权限并产生模型费用</span>
                </label>
              )}
            </div>
          )}
          <div className="schedule-actions">
            <button
              className={selected ? 'secondary' : 'primary'}
              disabled={locked || !current || !previewCurrent || !preview || !reviewed}
              onClick={saveTemplate}
            >
              {selected ? '保存重新核对的模板' : '保存定时任务草稿'}
            </button>
            {selected && selected.status !== 'enabled' && (
              <button
                className="primary"
                disabled={
                  locked ||
                  !current ||
                  !unchanged ||
                  !reviewed ||
                  (selected.settings.mode === 'execute' && !automatic)
                }
                onClick={() => act(selected, 'enable')}
              >
                启用已保存的定时任务
              </button>
            )}
          </div>
          {selected && (
            <div className="schedule-delete">
              <h4>删除定时任务</h4>
              <label className="schedule-check">
                <input
                  type="checkbox"
                  disabled={locked || !current || previewing}
                  checked={deleteTarget?.id === selected.id && deleteTarget.revision === selected.revision}
                  onChange={(e) =>
                    setDeleteTarget(
                      e.target.checked ? { id: selected.id, revision: selected.revision } : undefined,
                    )
                  }
                />
                <span>确认删除这条定时任务；已创建的任务仍保留</span>
              </label>
              <button
                className="text-button"
                disabled={
                  locked ||
                  !current ||
                  deleteTarget?.id !== selected.id ||
                  deleteTarget.revision !== selected.revision
                }
                onClick={() => act(selected, 'delete')}
              >
                删除定时任务
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
