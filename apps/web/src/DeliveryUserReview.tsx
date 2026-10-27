/**
 * 收集用户对交付内容的复核意见。
 * 保存用户逐项备注与交付复核结论，关联标准原文和交付指纹；交付变化时保留输入并要求重新核对。
 * EN: Collects human feedback on a delivery. Stores per-criterion notes and user review conclusions bound to criterion text and delivery fingerprint, retaining input and requiring reinspection after delivery changes.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DeliveryCriterion,
  DeliveryReview,
  DeliveryReviewState,
} from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';

import { readReviewDraft, type ReviewDraft } from './ReviewDraft';
import { readReviewCriteria } from './ReviewCriteria';
import { DeliveryChanges } from './DeliveryChanges';
import { ArtifactChanges } from './ArtifactChanges';
import { UnlinkedReviewNotes } from './UnlinkedReviewNotes';
import './delivery-user-review.css';

/**
 * 将人工复核草稿与已读交付指纹绑定。编辑保存在上层草稿，保存通过运行/根修订与指纹做并发校验。
 * 旧备注和无法重新关联的标准保留为 unlinked，不因重新读取或保存新结论而丢弃。
 * EN: Bind the human-review draft to the loaded delivery fingerprint. The parent stores edits; saving uses run/root revisions and fingerprint for concurrency checks. Preserve older notes and criteria that cannot be relinked as unlinked, rather than discarding them during rereads or new decisions.
 */
export function DeliveryUserReview({
  value,
  rawDraft,
  changeDraft,
  disabled,
  reading,
  readVersion,
  activity,
  reload,
  saved,
  children,
}: {
  value: DeliveryReview;
  rawDraft: unknown;
  changeDraft: (raw: string) => void;
  disabled: boolean;
  reading: boolean;
  readVersion: number;
  activity: (busy: boolean) => void;
  reload: () => void;
  saved: (value: DeliveryReviewState) => void;
  children: (note: (criterion: DeliveryCriterion) => ReactNode) => ReactNode;
}) {
  const { api, mutation } = useSurfaceClient();
  const descriptionId = useId();
  const draft = useMemo(() => readReviewDraft(rawDraft, value), [rawDraft, value]);
  /**
   * 本地草稿优先恢复，保存与旧备注重新关联分别跟踪进行状态。
   * EN: Restore the local draft first. Track saving and relinking old notes as separate activities.
   */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [busy, setBusy] = useState(false),
    [reconciling, setReconciling] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [conflict, setConflict] = useState(false);
  const reconcileRequest = useRef<AbortController | null>(null);
  /**
   * 交付身份或读取代次变化时重置核对中的标志；清理取消旧核对请求并解除引用，不让旧基线继续核验当前草稿。
   * EN: Resets reconciliation-in-progress state when delivery identity or read generation changes; cleanup aborts and detaches the old reconciliation request so its baseline cannot verify the current draft.
   */
  useEffect(() => {
    setReconciling(false);
    return () => {
      reconcileRequest.current?.abort();
      reconcileRequest.current = null;
    };
  }, [value.runId, value.runRevision, value.rootRevision, value.fingerprint, readVersion]);
  /**
   * 重新读取的代次变化时清除旧提交错误，使新的核对流程显示自己的反馈。
   * EN: Clears prior submission errors on a new read generation so the new review flow owns its feedback.
   */
  useEffect(() => {
    setConflict(false);
    setError('');
  }, [readVersion]);
  const changed = draft.fingerprint !== value.fingerprint;
  /**
   * 使用最新 ref 合并一次局部编辑；达到本机容量时拒绝本次写入，不能静默截断已有文字。
   * EN: Merge a local edit into the latest ref. At the local capacity limit reject the write instead of silently truncating existing text.
   */
  const patch = (next: Partial<ReviewDraft>) => {
    setNotice('');
    const updated = { ...draftRef.current, ...next };
    const raw = JSON.stringify(updated);
    if (raw.length > 200000) {
      setError('复核草稿已达到本机保存上限，本次输入未写入。请先复制并移除不再需要的旧备注。');
      return false;
    }
    draftRef.current = updated;
    changeDraft(raw);
    return true;
  };
  const readonly = disabled || reading || busy || reconciling;
  /**
   * 重读备注涉及的验收项，只保留原标准仍逐字相同的关联，其余转为未关联并清除旧结论。
   * EN: Reread referenced criteria and retain links only when the original wording still matches exactly. Move the rest to unlinked and clear the old decision.
   */
  async function reconcile() {
    if (readonly || conflict || reconcileRequest.current) return;
    const controller = new AbortController();
    reconcileRequest.current = controller;
    const before = draftRef.current;
    const token = JSON.stringify(before);
    setReconciling(true);
    setError('');
    try {
      const criteria = await readReviewCriteria(api, value, before.criteriaNotes, controller.signal);
      if (controller.signal.aborted) return;
      /**
       * 校验读取期间草稿未被其他输入改变，不能用旧快照覆盖更新后的编辑。
       * EN: Check that no other input changed the draft while reading; an older snapshot must not replace later edits.
       */
      if (JSON.stringify(draftRef.current) !== token) {
        setError('复核草稿已变化，请核对最新输入后重试。');
        return;
      }
      const kept = before.criteriaNotes.filter(
        (note) => !note.unknownStandard && criteria.get(note.index)?.text === note.text,
      );
      const detached = before.criteriaNotes.filter((note) => !kept.includes(note));
      patch({
        fingerprint: value.fingerprint,
        decision: '',
        criteriaNotes: kept,
        unlinked: [
          ...before.unlinked,
          ...detached.map((note) => ({ ...note, fingerprint: before.fingerprint })),
        ],
      });
    } catch (issue) {
      if (!controller.signal.aborted) {
        setError(issue instanceof Error ? issue.message : '验收项读取失败，备注草稿已保留。');
        if (issue instanceof ApiError && issue.status === 409) setConflict(true);
      }
    } finally {
      if (reconcileRequest.current === controller) {
        reconcileRequest.current = null;
        setReconciling(false);
      }
    }
  }
  /**
   * 为指定验收项生成受控复核备注编辑器；交付已变更时停止编辑，旧备注缺少原标准时给出核对提示。
   * EN: Builds a controlled review-note editor for one criterion. Editing is withheld after delivery changes, and legacy notes missing their original standard prompt verification.
   */
  const noteEditor = (criterion: DeliveryCriterion) => {
    if (changed) return null;
    const current = draft.criteriaNotes.find((item) => item.index === criterion.index);
    return (
      <label className="workflow-review-note">
        <span>我的复核备注</span>
        {current?.unknownStandard && (
          <small className="field-help">此条旧备注未记录原标准，请核对当前验收项后保存。</small>
        )}
        <textarea
          aria-label={`第 ${criterion.index + 1} 项复核备注`}
          aria-describedby={`${descriptionId}-criterion-${criterion.index}`}
          value={current?.note || ''}
          maxLength={1000}
          rows={2}
          disabled={readonly || changed || (!current && draft.criteriaNotes.length >= 40)}
          onChange={(event) =>
            patch({
              criteriaNotes: [
                ...draft.criteriaNotes.filter((item) => item.index !== criterion.index),
                ...(event.target.value
                  ? [
                      {
                        index: criterion.index,
                        text: criterion.text,
                        note: event.target.value,
                        unknownStandard: false,
                      },
                    ]
                  : []),
              ],
            })
          }
        />
        <small
          className="field-help delivery-review-count"
          id={`${descriptionId}-criterion-${criterion.index}`}
        >
          {(current?.note || '').length}/1000 字
          {!current && draft.criteriaNotes.length >= 40 && ' · 已有 40 项备注，请先移除其他备注再新增。'}
        </small>
      </label>
    );
  };
  /**
   * 保存明确结论和当前已关联备注；失败保留草稿，409 后需重读，不自动重发旧版本意见。
   * EN: Save the explicit decision and currently linked notes. Keep the draft on failure; a 409 requires rereading instead of automatically resubmitting feedback against an old version.
   */
  async function save() {
    if (readonly || changed || conflict || !draft.decision) return;
    setBusy(true);
    activity(true);
    setError('');
    try {
      const result = await mutation<DeliveryReviewState>(
        `/runs/${value.runId}/delivery/review`,
        {
          expectedRevision: value.runRevision,
          expectedRootRevision: value.rootRevision,
          expectedFingerprint: value.fingerprint,
          decision: draft.decision,
          note: draft.note,
          criteriaNotes: draft.criteriaNotes.map(({ index, note }) => ({ index, note })),
        },
        'PUT',
      );
      saved(result);
      changeDraft(draft.unlinked.length ? JSON.stringify(draft) : '');
      setNotice(
        draft.unlinked.length
          ? '复核已保存；未关联的旧备注仍保留为本机草稿，可手动关联到当前标准或整体备注。'
          : '复核已保存，执行记录保持不变。',
      );
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : '保存失败，备注草稿已保留。');
      if (issue instanceof ApiError && issue.status === 409) setConflict(true);
    } finally {
      setBusy(false);
      activity(false);
    }
  }
  return (
    <>
      <section className="workflow-user-review delivery-user-review" aria-label="用户复核">
        <header className="delivery-review-heading">
          <h3>用户复核</h3>
          <div className="delivery-review-saved-status">
            <span className="field-help">已保存结论</span>
            <span className="delivery-review-status">
              {value.userReview?.stale
                ? '旧结论已失效'
                : value.userReview?.decision === 'accepted'
                  ? '已采纳'
                  : value.userReview?.decision === 'changes_requested'
                    ? '需修改'
                    : '未复核'}
            </span>
          </div>
        </header>
        <p className="field-help" id={`${descriptionId}-scope`}>
          你的结论只针对当前交付版本，与执行完成和结构核验分别记录。未保存备注会保留为本机草稿。
        </p>
        {value.userReview && <p className="field-help">上次保存：{value.userReview.reviewedAt}</p>}
        <details className="delivery-review-basis">
          <summary>核对当前交付与草稿依据</summary>
          <dl className="delivery-review-reading" role="region" aria-label="复核版本依据全文" tabIndex={0}>
            <div>
              <dt>已读任务修订</dt>
              <dd>{value.runRevision}</dd>
            </div>
            <div>
              <dt>已读根任务修订</dt>
              <dd>{value.rootRevision}</dd>
            </div>
            <div>
              <dt>当前交付指纹</dt>
              <dd>{value.fingerprint}</dd>
            </div>
            <div>
              <dt>当前输入依据</dt>
              <dd>{draft.fingerprint}</dd>
            </div>
          </dl>
        </details>
        {readonly && (
          <p className="field-help" role="status">
            {busy
              ? '正在保存复核，请稍候。'
              : reconciling
                ? '正在核对验收项，输入暂不可编辑。'
                : reading
                  ? '正在读取交付，当前输入保留。'
                  : '当前为只读，备注与结论暂不可编辑。'}
          </p>
        )}
        <DeliveryChanges value={value.changeSummary} />
        {value.userReview?.reviewId && (
          <ArtifactChanges
            runId={value.runId}
            reviewId={value.userReview.reviewId}
            fingerprint={value.fingerprint}
            reload={reload}
            reading={reading}
          />
        )}
        {(changed || conflict) && (
          <div className="inline-warning" role="alert">
            <p>
              {changed
                ? '交付版本已变化，旧结论不适用于当前版本。输入已保留，请重新核对证据。'
                : '保存时记录已变化。请重新读取交付；当前输入已保留。'}
            </p>
            <button
              type="button"
              className="secondary"
              disabled={reading || busy || reconciling}
              onClick={reload}
            >
              重新读取交付
            </button>
            {changed && !reading && (
              <button
                type="button"
                className="secondary"
                disabled={readonly || conflict}
                onClick={() => void reconcile()}
              >
                {reconciling ? '正在核对备注对应的验收项…' : '已核对新版本，保留备注重新决定'}
              </button>
            )}
          </div>
        )}
        {changed && !!draft.criteriaNotes.length && (
          <details className="delivery-review-old-notes" open>
            <summary>旧交付版本的逐项备注 · {draft.criteriaNotes.length} 项</summary>
            <ol>
              {draft.criteriaNotes.map((item) => (
                <li key={item.index}>
                  <h4>原第 {item.index + 1} 项</h4>
                  <p className="field-help">原验收标准</p>
                  <p
                    className="workflow-prose delivery-review-reading"
                    role="region"
                    aria-label={`草稿原第 ${item.index + 1} 项标准全文`}
                    tabIndex={0}
                  >
                    {item.text}
                  </p>
                  <p className="field-help">保留的复核备注</p>
                  <p
                    className="workflow-prose delivery-review-reading"
                    role="region"
                    aria-label={`草稿原第 ${item.index + 1} 项备注全文`}
                    tabIndex={0}
                  >
                    {item.note}
                  </p>
                </li>
              ))}
            </ol>
          </details>
        )}
        {!!draft.unlinked.length && (
          <UnlinkedReviewNotes
            key={`${value.fingerprint}:${readVersion}`}
            value={value}
            draft={draft}
            disabled={readonly || changed || conflict}
            change={patch}
          />
        )}
        <label>
          <span>本次复核结论</span>
          <select
            aria-label="用户复核结论"
            aria-describedby={`${descriptionId}-decision`}
            value={draft.decision}
            disabled={readonly || changed}
            onChange={(event) => patch({ decision: event.target.value as ReviewDraft['decision'] })}
          >
            <option value="">请选择结论</option>
            <option value="accepted">采纳当前交付</option>
            <option value="changes_requested">要求修改</option>
          </select>
          <small className="field-help" id={`${descriptionId}-decision`}>
            选择结论后，使用下方按钮保存；修改选择不会自动保存。
          </small>
        </label>
        <label>
          <span>整体备注</span>
          <textarea
            aria-label="整体复核备注"
            aria-describedby={`${descriptionId}-overall`}
            rows={3}
            maxLength={4000}
            value={draft.note}
            disabled={readonly}
            onChange={(event) => patch({ note: event.target.value })}
          />
          <small className="field-help delivery-review-count" id={`${descriptionId}-overall`}>
            {draft.note.length}/4000 字
          </small>
        </label>
        <p className="field-help">
          逐项备注已填写 {draft.criteriaNotes.length}/40 项；在下方验收标准中编辑。
        </p>
        {error && (
          <p
            className="workflow-read-error delivery-review-reading"
            role="alert"
            aria-label="复核操作错误全文"
            tabIndex={0}
          >
            {error} 当前输入已保留。
          </p>
        )}
        {notice && (
          <p className="delivery-review-notice" role="status">
            {notice}
          </p>
        )}
        <div className="delivery-review-actions">
          <p className="field-help" id={`${descriptionId}-save-range`}>
            本次保存当前结论、整体备注和 {draft.criteriaNotes.length} 项逐项备注。
            {draft.unlinked.length > 0 && `${draft.unlinked.length} 条未关联旧备注仍只保留在本机草稿中。`}
          </p>
          <button
            type="button"
            className="primary"
            disabled={readonly || changed || conflict || !draft.decision}
            aria-describedby={`${descriptionId}-scope ${descriptionId}-decision ${descriptionId}-save-range`}
            onClick={() => void save()}
          >
            {busy ? '正在保存…' : '保存复核结论'}
          </button>
        </div>
      </section>
      {children(noteEditor)}
    </>
  );
}
