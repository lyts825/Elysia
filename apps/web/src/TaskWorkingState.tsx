/**
 * 展示和管理任务工作状态检查点。
 *
 * EN: Displays and edits task working-state checkpoints.
 *
 * 本模块管理任务检查点读取、要求草稿、批准/撤销命令及结果未知后的核对；以运行和任务身份隔离编辑器，保留命令 ID 和版本依据，服务端负责最终状态转换。
 * EN: Owns checkpoint reads, requirement drafts, approval/revocation commands, and reconciliation after unknown outcomes. Editors are isolated by run/task and retain command IDs/revisions; the server owns final transitions.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import type { TaskWorkingStateView } from '../../../packages/contracts/src/working-state';
import type { WorkbenchCache } from './WorkbenchCache';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import './task-working-state.css';

const pendingShape = z.discriminatedUnion('kind', [
  /**
   * 保存审批或撤销请求的命令 ID 和期望版本，结果未知时可继续核对。
   *
   * EN: Retains approval/revocation command IDs and expected revisions so unknown outcomes can be reconciled.
   */
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
/**
 * 从未知异常提取可显示文本，非 Error 值使用保留输入的通用提示；不改变草稿或命令状态。
 * EN: Extracts display text from an unknown failure, using a draft-preservation fallback for non-Error values without changing draft/command state.
 */
const message = (issue: unknown) => (issue instanceof Error ? issue.message : '请求失败，输入已保留。');
/**
 * 读取工作状态的结构化草稿与待核对命令；旧客户端的纯文本要求仍可完整恢复。
 * 能识别为新版草稿的损坏数据必须报错并保留原文，不能误当纯文本后覆盖其命令身份。
 *
 * EN: Reads structured working-state drafts/pending commands and preserves legacy plain requirements. Recognizably new corrupt data fails without overwriting its command identity as plain text.
 */
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
  /**
   * 旧客户端把完整要求作为纯文本保存。
   *
   * EN: Earlier clients stored the complete requirements as plain text.
   */
  return { version: 1, kind: 'working-state', requirements: raw };
}
/**
 * 导出当前输入或不可读原稿为本地文本，延迟释放 URL 使下载点击可完成。
 *
 * EN: Downloads current text or unreadable originals and delays URL revocation until the click can complete.
 */
function download(value: string, taskId: string) {
  const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `working-state-${taskId}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/**
 * 按运行和任务强制重建编辑器，避免上一任务的确认状态或 pending 命令串入新任务。
 *
 * EN: Remounts by run/task identity so prior confirmation or pending commands cannot leak into another task.
 */
export function TaskWorkingState(props: { runId: string; taskId: string; cache: WorkbenchCache }) {
  return <WorkingStateEditor key={`${props.runId}:${props.taskId}`} {...props} />;
}
/**
 * 将“当前服务端检查点”“用户有效要求”和“批准/撤销待确认请求”分开管理。
 * 批准必须绑定已读取的 snapshotHash、revision 和用户确认；断连后保留同一命令供重试核对。
 *
 * EN: Separates current server checkpoint, user requirements, and pending approval/revocation. Approval binds the read snapshotHash/revision and explicit confirmation; disconnection retains the exact command for reconciliation.
 */
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
  const editorId = useId();
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
  /**
   * 以缓存中的最新原稿执行变换，严格校验后整份保存；失败返回 false 并阻止后续网络提交。
   *
   * EN: Transforms the latest cached original, validates, and saves it whole; false on failure prevents network submission.
   */
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
  /**
   * 核对响应中快照来源属于本编辑器任务，不能仅凭请求 URL 假定返回内容归属正确。
   *
   * EN: Verifies that response snapshot ownership matches this task instead of assuming the URL guarantees returned contents.
   */
  function validateView(next: TaskWorkingStateView) {
    if (next.draft.source.runId !== runId || next.draft.source.taskId !== taskId)
      throw Error('返回的工作状态所属不匹配，请重新核对。');
  }
  /**
   * 刷新安全检查点时取消上次读取并撤销旧确认；已读 view 可保留展示，但 current=false 禁止新批准。
   * 写入进行中不发起新读取，避免界面先应用一个早于待提交操作的快照。
   *
   * EN: Refreshing cancels earlier reads and invalidates confirmation. Old view may remain visible, but current=false blocks new approval; no read starts during a write.
   */
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
  /**
   * 发送前把精确请求保存进草稿，重试只接受同一命令负载。新批准还须核对当前视图和输入。
   * 成功只清除匹配 commandId 的 pending；明确 4xx 拒绝使旧确认失效，未知结果则保留原请求。
   * 批准工作状态仅影响后续上下文压缩，不启动或恢复执行。
   *
   * EN: Persists the exact request before sending; retries accept only that payload and new approvals recheck view/input. Success clears only matching commandId; definitive 4xx invalidates confirmation while unknown outcomes retain the request. Saving affects later compaction only, not execution.
   */
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
      <h3>长任务工作状态</h3>
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
        <p
          className="field-error working-state-reading"
          role="alert"
          tabIndex={0}
          aria-label="工作状态读取问题全文"
        >
          {readError}
        </p>
      )}
      {saveError && (
        <p
          className="field-error working-state-reading"
          role="alert"
          tabIndex={0}
          aria-label="工作状态保存问题全文"
        >
          {saveError}
        </p>
      )}
      {draftError && (
        <div className="field-error working-state-error-group">
          <p
            className="working-state-reading"
            role="alert"
            tabIndex={0}
            aria-label="工作状态本机草稿问题全文"
          >
            {draftError}
          </p>
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
          <dl className="working-state-facts" aria-label="待核对原请求版本">
            <div>
              <dt>原状态版本</dt>
              <dd>{pending.expectedRevision}</dd>
            </div>
            <div>
              <dt>请求类型</dt>
              <dd>{pending.kind === 'approve' ? '批准要求' : '撤销状态'}</dd>
            </div>
          </dl>
          {pending.kind === 'approve' && (
            <details>
              <summary>查看上次批准的完整要求</summary>
              <p className="working-state-text" role="region" tabIndex={0} aria-label="待核对原请求完整要求">
                {pending.currentRequirements}
              </p>
            </details>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={() => void save(pending)}>
            重试核对工作状态
          </button>
        </div>
      )}
      {view && (
        <>
          <dl className="working-state-facts" aria-label="已读快照核对范围">
            <div>
              <dt>已读消息范围</dt>
              <dd>{view.draft.source.messageCount} 条</dd>
            </div>
            <div>
              <dt>工作状态版本</dt>
              <dd>{view.revision}</dd>
            </div>
            <div>
              <dt>本次读取</dt>
              <dd>{current ? '已读取当前状态' : '保留上次结果，尚未确认'}</dd>
            </div>
          </dl>
          {view.reason && (
            <p
              className="field-help working-state-reading"
              role="region"
              tabIndex={0}
              aria-label="工作状态核对条件全文"
            >
              {view.reason}
            </p>
          )}
          {view.approved && (
            <p
              role="status"
              className="working-state-reading"
              tabIndex={0}
              aria-label="已保存工作状态适用情况"
            >
              {view.approvedValid
                ? '已有生效的工作状态。'
                : `旧工作状态已失效：${view.approvedInvalidReason}`}
            </p>
          )}
          <details>
            <summary>查看任务、子任务与证据</summary>
            <pre role="region" tabIndex={0} aria-label="工作状态任务子任务与证据完整快照">
              {JSON.stringify(view.draft.state, null, 2)}
            </pre>
          </details>
          {view.approved && (
            <details>
              <summary>查看上次确认的要求</summary>
              <p
                className="working-state-text"
                role="region"
                tabIndex={0}
                aria-label="已保存工作状态完整要求"
              >
                {view.approved.currentRequirements}
              </p>
            </details>
          )}
          <details>
            <summary>本次快照与已批准来源</summary>
            <dl
              className="working-state-facts working-state-reading"
              role="region"
              tabIndex={0}
              aria-label="工作状态快照与批准完整来源"
            >
              <div>
                <dt>本次快照时间</dt>
                <dd>{view.draft.capturedAt}</dd>
              </div>
              <div>
                <dt>本次快照任务</dt>
                <dd>{view.draft.source.taskId}</dd>
              </div>
              <div>
                <dt>本次快照任务版本</dt>
                <dd>{view.draft.source.taskRevision}</dd>
              </div>
              <div>
                <dt>本次快照哈希</dt>
                <dd>{view.draft.snapshotHash}</dd>
              </div>
              <div>
                <dt>原始历史引用</dt>
                <dd>{view.draft.source.originalRef}</dd>
              </div>
              {view.approved && (
                <>
                  <div>
                    <dt>上次批准时间</dt>
                    <dd>{view.approved.approval.approvedAt}</dd>
                  </div>
                  <div>
                    <dt>上次批准哈希</dt>
                    <dd>{view.approved.approval.approvedHash}</dd>
                  </div>
                  <div>
                    <dt>上次批准的任务版本</dt>
                    <dd>{view.approved.source.taskRevision}</dd>
                  </div>
                </>
              )}
            </dl>
          </details>
          <p className="working-state-draft-label">当前编辑草稿 · 需勾选核对并明确保存，才成为已批准状态</p>
          <label className="working-state-editor">
            当前有效要求、已完成事项和下一步
            <textarea
              rows={6}
              aria-describedby={`${editorId}-count`}
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
          <p id={`${editorId}-count`} className={tooLong ? 'field-error' : 'field-help'}>
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
