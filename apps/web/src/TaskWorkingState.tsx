import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { TaskWorkingStateView } from '../../../packages/contracts/src/working-state';
import type { WorkbenchCache } from './WorkbenchCache';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import './task-working-state.css';

const pendingShape = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('approve'),
      commandId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
      expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      currentRequirements: z.string().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('revoke'),
      commandId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);
const draftShape = z
  .object({
    version: z.literal(1),
    kind: z.literal('working-state'),
    requirements: z.string().max(190000),
    pending: pendingShape.optional(),
  })
  .strict();
type Draft = z.infer<typeof draftShape>;
type Pending = z.infer<typeof pendingShape>;
const message = (issue: unknown) => (issue instanceof Error ? issue.message : '请求失败，输入已保留。');
function parseDraft(raw: unknown): Draft {
  if (raw === undefined || raw === '') return { version: 1, kind: 'working-state', requirements: '' };
  if (typeof raw !== 'string' || raw.length > 200000) throw Error('工作状态草稿无法读取，原文已保留。');
  try {
    const value = JSON.parse(raw);
    if (value?.kind === 'working-state') return draftShape.parse(value);
  } catch (issue) {
    if (raw.includes('"kind":"working-state"') || issue instanceof z.ZodError)
      throw Error('工作状态草稿格式无法读取，原文已保留。');
  }
  // Earlier clients stored the complete requirements as plain text.
  return { version: 1, kind: 'working-state', requirements: raw };
}
function download(value: string, taskId: string) {
  const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `working-state-${taskId}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function TaskWorkingState(props: { runId: string; taskId: string; cache: WorkbenchCache }) {
  return <WorkingStateEditor key={`${props.runId}:${props.taskId}`} {...props} />;
}
function WorkingStateEditor({
  runId,
  taskId,
  cache,
}: {
  runId: string;
  taskId: string;
  cache: WorkbenchCache;
}) {
  const { api, mutation } = useSurfaceClient();
  const [view, setView] = useState<TaskWorkingStateView>();
  const [requirements, setRequirements] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [reading, setReading] = useState(false),
    [current, setCurrent] = useState(false);
  const [readError, setReadError] = useState(''),
    [saveError, setSaveError] = useState(''),
    [draftError, setDraftError] = useState(''),
    [notice, setNotice] = useState('');
  const [draftReady, setDraftReady] = useState(false),
    [draftRetry, setDraftRetry] = useState(0),
    [pending, setPending] = useState<Pending>();
  const live = useRef(true),
    writing = useRef(false),
    reader = useRef<AbortController | null>(null);
  const key = `draft:working-state:${runId}:${taskId}`,
    endpoint = `/runs/${runId}/tasks/${taskId}/working-state`;
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
        if (!active) return;
        const value = parseDraft(cache.get(key));
        setRequirements(value.requirements);
        setPending(value.pending);
        setDraftReady(true);
        setDraftError('');
      })
      .catch((issue) => {
        if (active) setDraftError(message(issue));
      });
    return () => {
      active = false;
    };
  }, [key, cache, draftRetry]);
  function persist(change: (value: Draft) => Draft) {
    try {
      if (!draftReady || !live.current) return false;
      const value = draftShape.parse(change(parseDraft(cache.get(key))));
      const raw = JSON.stringify(value);
      if (raw.length > 200000) throw Error('工作状态草稿超过容量，原稿保留。');
      cache.set(key, raw);
      setPending(value.pending);
      setDraftError('');
      return true;
    } catch (issue) {
      setDraftError(message(issue));
      return false;
    }
  }
  function validateView(next: TaskWorkingStateView) {
    if (next.draft.source.runId !== runId || next.draft.source.taskId !== taskId)
      throw Error('返回的工作状态所属不匹配，请重新核对。');
  }
  async function read() {
    if (writing.current) return;
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    setReading(true);
    setCurrent(false);
    setConfirmed(false);
    setReadError('');
    try {
      const next = await api<TaskWorkingStateView>(endpoint, undefined, undefined, controller.signal);
      validateView(next);
      if (live.current && !controller.signal.aborted) {
        setView(next);
        setCurrent(true);
      }
    } catch (issue) {
      if (live.current && !controller.signal.aborted) setReadError(message(issue));
    } finally {
      if (live.current && reader.current === controller) {
        reader.current = null;
        setReading(false);
      }
    }
  }
  const tooLong = requirements.length > 16000;
  const locked = busy || !!pending || !draftReady;
  async function save(request: Pending) {
    if (writing.current || !live.current) return;
    if (
      !persist((value) => {
        if (value.pending) {
          if (JSON.stringify(value.pending) !== JSON.stringify(pendingShape.parse(request)))
            throw Error('待核对的状态请求已变化。');
          return value;
        }
        if (
          pending ||
          !current ||
          !view?.canApprove ||
          request.expectedRevision !== view.revision ||
          (request.kind === 'approve' &&
            (!confirmed ||
              value.requirements !== request.currentRequirements ||
              view.draft.snapshotHash !== request.expectedSnapshotHash))
        )
          throw Error('状态或输入已变化，请重新核对后确认。');
        return { ...value, pending: request };
      })
    )
      return;
    writing.current = true;
    setBusy(true);
    setSaveError('');
    setNotice('');
    const { kind, ...body } = request;
    try {
      const next = await mutation<TaskWorkingStateView>(endpoint, {
        ...body,
        ...(kind === 'revoke' ? { action: 'revoke' } : { confirmed: true }),
      });
      validateView(next);
      if (!live.current) return;
      reader.current?.abort();
      setReading(false);
      setView(next);
      setCurrent(true);
      setConfirmed(false);
      setReadError('');
      persist((value) =>
        value.pending?.commandId === request.commandId ? { ...value, pending: undefined } : value,
      );
      setNotice(
        kind === 'revoke'
          ? '已撤销工作状态，后续恢复原历史压缩方式。'
          : '已保存核对后的工作状态；下次达到压缩阈值时使用，未启动或恢复执行。',
      );
    } catch (issue) {
      if (!live.current) return;
      const definitive =
        issue instanceof ApiError &&
        issue.kind === 'http' &&
        (issue.status ?? 0) >= 400 &&
        (issue.status ?? 0) < 500;
      if (definitive) {
        persist((value) =>
          value.pending?.commandId === request.commandId ? { ...value, pending: undefined } : value,
        );
        setCurrent(false);
        setConfirmed(false);
      }
      setSaveError(
        message(issue) +
          (definitive ? ' 请重新读取并核对；输入已保留。' : ' 结果尚未确认，重试将核对同一请求。'),
      );
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="task-working-state" aria-label="长任务工作状态">
      <strong>长任务工作状态</strong>
      <p className="field-help">
        在安全检查点核对当前有效要求。明确保存后，较早历史可用此状态摘要替代；原始对话保留，之后的新消息仍逐条保留。权限与预算不变。
      </p>
      <div className="workflow-actions">
        <button type="button" className="secondary" disabled={busy || reading} onClick={() => void read()}>
          {reading ? '正在读取工作状态…' : view ? '重新读取当前状态' : '读取并核对当前状态'}
        </button>
        {reading && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              reader.current?.abort();
              setReading(false);
              setCurrent(false);
              setReadError('读取已取消，已读内容与输入保留；重新读取成功后才能批准。');
            }}
          >
            取消读取工作状态
          </button>
        )}
      </div>
      {view && !current && <p role="status">显示上次读取结果，当前任务状态尚未确认。</p>}
      {readError && (
        <p className="field-error" role="alert">
          {readError}
        </p>
      )}
      {saveError && (
        <p className="field-error" role="alert">
          {saveError}
        </p>
      )}
      {draftError && (
        <div className="field-error" role="alert">
          <p>{draftError}</p>
          <button type="button" className="text-button" onClick={() => setDraftRetry((value) => value + 1)}>
            重新读取状态草稿
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => download(draftReady ? requirements : String(cache.get(key) ?? ''), taskId)}
          >
            导出状态原稿
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div className="working-state-pending">
          <p>
            上次{pending.kind === 'approve' ? '批准' : '撤销'}
            结果待核对，保留原版本、内容与请求。此重试只核对原操作。
          </p>
          {pending.kind === 'approve' && (
            <details>
              <summary>查看上次批准的完整要求</summary>
              <p className="working-state-text">{pending.currentRequirements}</p>
            </details>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={() => void save(pending)}>
            重试核对工作状态
          </button>
        </div>
      )}
      {view && (
        <>
          <p className="field-help">
            核对范围：{view.draft.source.messageCount} 条消息 · 当前状态版本 {view.revision}。{view.reason}
          </p>
          {view.approved && (
            <p role="status">
              {view.approvedValid
                ? '已有生效的工作状态。'
                : `旧工作状态已失效：${view.approvedInvalidReason}`}
            </p>
          )}
          <details>
            <summary>查看任务、子任务与证据</summary>
            <pre>{JSON.stringify(view.draft.state, null, 2)}</pre>
          </details>
          {view.approved && (
            <details>
              <summary>查看上次确认的要求</summary>
              <p className="working-state-text">{view.approved.currentRequirements}</p>
            </details>
          )}
          <label className="working-state-editor">
            当前有效要求、已完成事项和下一步
            <textarea
              rows={6}
              value={requirements}
              disabled={locked}
              placeholder="核对原对话后填写；保留仍有效的约束、否定要求、未决问题和证据位置。不要仅填写‘继续’。"
              onChange={(event) => {
                const value = event.target.value;
                setRequirements(value);
                setConfirmed(false);
                setNotice('');
                persist((draft) => ({ ...draft, requirements: value }));
              }}
            />
          </label>
          <p className={tooLong ? 'field-error' : 'field-help'}>
            {requirements.length.toLocaleString()} / 16,000 字符
            {tooLong ? '，请缩短后再保存；原文没有截断。' : ''}
          </p>
          <label className="working-state-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked || !current || !view.canApprove || tooLong}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对原对话；以上内容完整保留当前有效要求，允许用它替代核对范围内的较早历史。
          </label>
          <div className="workflow-actions">
            <button
              type="button"
              className="secondary"
              disabled={
                locked || !current || !view.canApprove || !confirmed || !requirements.trim() || tooLong
              }
              onClick={() =>
                void save({
                  kind: 'approve',
                  commandId: crypto.randomUUID(),
                  expectedRevision: view.revision,
                  expectedSnapshotHash: view.draft.snapshotHash,
                  currentRequirements: requirements,
                })
              }
            >
              保存已核对状态
            </button>
            {view.approved && (
              <button
                type="button"
                className="text-button"
                disabled={locked || !current || !view.canApprove}
                onClick={() =>
                  void save({
                    kind: 'revoke',
                    commandId: crypto.randomUUID(),
                    expectedRevision: view.revision,
                  })
                }
              >
                撤销并恢复原历史压缩
              </button>
            )}
            <button type="button" className="text-button" onClick={() => download(requirements, taskId)}>
              导出当前要求
            </button>
          </div>
        </>
      )}
    </section>
  );
}
