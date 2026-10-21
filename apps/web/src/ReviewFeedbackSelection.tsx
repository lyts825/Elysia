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
  const state = readReviewSource(selection);
  if (!state)
    return (
      <section className="workflow-source">
        <p className="field-error">
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
  const pendingKeys = new Set(state.pending.map(reviewNoteKey)),
    addedKeys = new Set(state.added.map(reviewNoteKey));
  const changed =
    !!value && !!(state.pending.length || state.added.length) && state.fingerprint !== value.fingerprint;
  const locked = disabled || reading || !!error || !value;
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
      <label className="workflow-note-choice" key={item.id}>
        <input
          type="checkbox"
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
          <strong>
            {item.origin} · {item.stale ? '旧版本' : '当前版本'} · {item.title}
            {addedKeys.has(reviewNoteKey(item.source)) ? '（已加入）' : ''}
          </strong>
          <ReviewSourceNoteBody note={item.source} compact showHeading={false} />
          {reviewNotesIssue([item.source]) && (
            <small className="field-error">{reviewNotesIssue([item.source])}</small>
          )}
        </span>
      </label>
    ));
  const addition = state.pending.filter((note) => !addedKeys.has(reviewNoteKey(note)));
  const combined = [...state.added, ...addition];
  const issue = reviewNotesIssue(combined);
  return (
    <details className="workflow-source" open={!!local || !!state.pending.length || !!state.added.length}>
      <summary>选择复核备注（已保存／本机未保存／旧版本）</summary>
      <p className="field-help">
        勾选与已加入内容分别保留。只有明确加入的备注会成为新任务来源，不占修改意见的 4000
        字额度，也不会保存或改变复核结论。
      </p>
      {reading && <p role="status">正在核对来源交付版本…</p>}
      {error && (
        <p role="alert" className="field-error">
          {error} 选择及备注草稿仍保留。
          <button type="button" className="secondary" onClick={retry} disabled={disabled || reading}>
            重试读取备注
          </button>
        </p>
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
              <ReviewSourceNoteBody note={note} compact />
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
      <button
        type="button"
        className="secondary"
        disabled={locked || changed || !addition.length || !!issue}
        onClick={() => change({ ...state, added: combined, pending: [], fingerprint: value!.fingerprint })}
      >
        确认加入所选备注
      </button>
      {!!state.added.length && (
        <ReviewSourceNotes
          notes={state.added}
          disabled={disabled}
          remove={(index) => change({ ...state, added: state.added.filter((_, i) => i !== index) })}
        />
      )}
    </details>
  );
}
