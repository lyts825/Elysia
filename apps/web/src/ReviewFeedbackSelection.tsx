/* 选择需要处理的评审反馈。 */
import { useId } from 'react';
import type { DeliveryReview, ReviewSourceNote } from '../../../packages/contracts/src/workflow';
import { readLocalReviewDraft, reviewCandidates, type ReviewCandidate } from './ReviewDraft';
import {
  emptyReviewSource,
  readReviewSource,
  reviewNoteKey,
  reviewNotesIssue,
  type ReviewSourceState,
} from './ReviewSourceState';
import { ReviewSourceNoteBody, ReviewSourceNotes } from './ReviewSourceNotes';
import { ReviewHistory } from './ReviewHistory';
import './handoff-selection.css';
import './review-feedback-selection.css';

/** 汇总已保存与本机反馈，并让调用方决定哪些备注加入后续任务。 */
export function ReviewFeedbackSelection({
  runId,
  value,
  reading,
  error,
  retry,
  selection,
  change,
  disabled,
  localDraft,
}: {
  runId: string;
  value?: DeliveryReview;
  reading: boolean;
  error: string;
  retry: () => void;
  selection: unknown;
  change: (state: ReviewSourceState) => void;
  disabled: boolean;
  localDraft?: unknown;
}) {
  const helpId = useId();
  const state = readReviewSource(selection);
  if (!state)
    return (
      <section className="workflow-source handoff-review review-feedback-selection" aria-label="复核备注选择">
        <p className="field-error" role="alert">
          备注选择草稿格式无法读取，原草稿仍保留。请先保留需要的内容，再明确清除此部分选择。
        </p>
        <button
          type="button"
          className="secondary"
          disabled={disabled}
          onClick={() => change(emptyReviewSource())}
        >
          清除无法读取的备注选择
        </button>
      </section>
    );
  const local = readLocalReviewDraft(localDraft);
  const items = value
    ? reviewCandidates(value.userReview, local, value.fingerprint, value.userReview?.reviewId ?? null)
    : [];
  // pending 表示勾选草稿，added 才会作为新任务来源提交；两组按完整来源字段生成键去重。
  const pendingKeys = new Set(state.pending.map(reviewNoteKey)),
    addedKeys = new Set(state.added.map(reviewNoteKey));
  const changed =
    !!value && !!(state.pending.length || state.added.length) && state.fingerprint !== value.fingerprint;
  const locked = disabled || reading || !!error || !value;
  /** 首次勾选固定当前交付指纹，已有选择不因重新读取而被静默更新为新版本。 */
  function toggle(note: ReviewSourceNote) {
    const key = reviewNoteKey(note);
    change({
      ...state!,
      fingerprint: state!.pending.length || state!.added.length ? state!.fingerprint : value!.fingerprint,
      pending: pendingKeys.has(key)
        ? state!.pending.filter((item) => reviewNoteKey(item) !== key)
        : [...state!.pending, note],
    });
  }
  const choices = (candidates: ReviewCandidate[]) =>
    candidates.map((item) => (
      <article className="handoff-note-option" key={item.id}>
        <label className="workflow-note-choice">
          <input
            type="checkbox"
            aria-describedby={helpId}
            checked={pendingKeys.has(reviewNoteKey(item.source))}
            disabled={
              locked ||
              !!reviewNotesIssue([item.source]) ||
              addedKeys.has(reviewNoteKey(item.source)) ||
              (!pendingKeys.has(reviewNoteKey(item.source)) && state.pending.length >= 40)
            }
            onChange={() => toggle(item.source)}
          />
          <span>
            {item.origin} · {item.stale ? '旧版本' : '当前版本'} · {item.title}
          </span>
        </label>
        {addedKeys.has(reviewNoteKey(item.source)) && <p className="handoff-state">已加入新任务来源</p>}
        <div
          className="handoff-reading"
          role="region"
          aria-label={`${item.title}原标准与备注全文`}
          tabIndex={0}
        >
          <ReviewSourceNoteBody note={item.source} compact showHeading={false} />
        </div>
        {reviewNotesIssue([item.source]) && <p className="field-error">{reviewNotesIssue([item.source])}</p>}
      </article>
    ));
  const addition = state.pending.filter((note) => !addedKeys.has(reviewNoteKey(note)));
  // 容量校验针对加入后的完整集合，不能让每条单独合规的备注合并后突破总字节预算。
  const combined = [...state.added, ...addition];
  const issue = reviewNotesIssue(combined);
  return (
    <details
      className="workflow-source handoff-review review-feedback-selection"
      open={!!local || !!state.pending.length || !!state.added.length}
    >
      <summary>选择复核备注（已保存／本机未保存／旧版本）</summary>
      <p className="field-help" id={helpId}>
        勾选与已加入内容分别保留。只有明确加入的备注会成为新任务来源，不占修改意见的 4000
        字额度，也不会保存或改变复核结论。
      </p>
      <dl className="review-feedback-counts" aria-label="本区备注与当前选择数量">
        <div>
          <dt>本区已列出</dt>
          <dd>{items.length} 条</dd>
        </div>
        <div>
          <dt>待加入</dt>
          <dd>{state.pending.length} 条</dd>
        </div>
        <div>
          <dt>已加入</dt>
          <dd>{state.added.length} 条</dd>
        </div>
      </dl>
      <p className="field-help">列出数量仅含本次已读来源与本机草稿，历史备注另行展开查看。</p>
      {reading && <p role="status">正在核对来源交付版本…</p>}
      {error && (
        <div role="alert" className="field-error workflow-read-error handoff-read-error">
          <p className="handoff-reading" role="region" aria-label="备注读取错误全文" tabIndex={0}>
            {error} 选择及备注草稿仍保留。
          </p>
          <button type="button" className="secondary" onClick={retry} disabled={disabled || reading}>
            重试读取备注
          </button>
        </div>
      )}
      {!reading && !error && !items.length && (
        <p className="field-help">当前没有可选择的复核备注，可查看历史。</p>
      )}
      {choices(items)}
      <ReviewHistory
        runId={runId}
        version={value?.runRevision ?? 0}
        renderNotes={(detail) =>
          choices(
            reviewCandidates(
              { ...detail.review, stale: detail.review.fingerprint !== value?.fingerprint },
              undefined,
              value?.fingerprint || '',
              detail.item.id,
            ),
          )
        }
      />
      {!!state.pending.length && (
        <section aria-label="待加入的复核备注">
          <h4>待加入 {state.pending.length} 条（尚未带入新任务）</h4>
          {state.pending.map((note, index) => (
            <div className="workflow-selection" key={reviewNoteKey(note) + index}>
              <div
                className="handoff-reading"
                role="region"
                aria-label={`待加入备注 ${index + 1} 全文`}
                tabIndex={0}
              >
                <ReviewSourceNoteBody note={note} compact />
              </div>
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                onClick={() => change({ ...state, pending: state.pending.filter((_, i) => i !== index) })}
              >
                取消此待选备注
              </button>
            </div>
          ))}
        </section>
      )}
      {changed && (
        <div className="inline-warning" role="alert">
          <p>来源交付版本已变化，待选和已加入的备注均已保留。请查看当前交付后，明确确认继续使用这些原文。</p>
          <button
            type="button"
            disabled={locked}
            onClick={() => change({ ...state, fingerprint: value!.fingerprint })}
          >
            已核对当前交付，保留这些备注
          </button>
        </div>
      )}
      {issue && (
        <p className="field-error" role="alert">
          {issue}
        </p>
      )}
      <div className="review-feedback-addition">
        <p className="field-help" id={`${helpId}-addition`}>
          本次待新增 {addition.length} 条，原已加入的 {state.added.length}{' '}
          条保留。勾选不会自动加入或保存复核结论。
        </p>
        <button
          type="button"
          className="secondary"
          aria-describedby={`${helpId} ${helpId}-addition`}
          disabled={locked || changed || !addition.length || !!issue}
          onClick={() => change({ ...state, added: combined, pending: [], fingerprint: value!.fingerprint })}
        >
          确认加入所选备注
        </button>
      </div>
      {!!state.added.length && (
        <div className="handoff-added-list" role="region" aria-label="已加入备注完整列表" tabIndex={0}>
          <ReviewSourceNotes
            notes={state.added}
            disabled={disabled}
            remove={(index) => change({ ...state, added: state.added.filter((_, i) => i !== index) })}
          />
        </div>
      )}
    </details>
  );
}
