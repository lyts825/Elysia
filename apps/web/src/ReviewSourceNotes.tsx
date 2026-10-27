/* 展示评审来源及其备注。 */
import type { ReviewSourceNote } from '../../../packages/contracts/src/workflow';
import { useId, useState } from 'react';
import { reviewNoteKey } from './ReviewSourceState';
import { deferredPanel } from './DeferredPanel';
import './review-source-notes.css';

const OriginalReview = deferredPanel(
  () => import('./OriginalReview').then((m) => m.OriginalReview),
  '原复核记录',
);

export function ReviewSourceNoteBody({
  note,
  compact = false,
  showHeading = true,
}: {
  note: ReviewSourceNote;
  compact?: boolean;
  showHeading?: boolean;
}) {
  // 来源、原标准和备注分别展示；未记录标准时不推断其内容。
  return (
    <div className="review-source-note-body">
      {showHeading && (
        <strong className="review-source-note-origin">
          {note.origin === 'saved' ? '已保存复核' : '本机备注资料'} ·{' '}
          {note.criterionIndex !== null
            ? `原第 ${note.criterionIndex + 1} 项`
            : note.criterionText
              ? '未关联旧备注'
              : '整体或未关联备注'}
        </strong>
      )}
      {(note.criterionIndex !== null || note.criterionText) && (
        <div className="review-source-note-field">
          <strong>原验收标准</strong>
          <p className="workflow-prose">{note.criterionText ?? '旧标准内容未记录'}</p>
        </div>
      )}
      {compact && note.note.length > 160 ? (
        <details className="review-source-note-text">
          <summary>查看完整备注（{note.note.length} 字）</summary>
          <p className="workflow-prose">{note.note}</p>
        </details>
      ) : (
        <div className="review-source-note-field">
          <strong>复核备注</strong>
          <p className="workflow-prose">{note.note}</p>
        </div>
      )}
      <details className="workflow-note-provenance">
        <summary>版本与来源信息</summary>
        <dl>
          <div>
            <dt>交付指纹</dt>
            <dd>{note.fingerprint || '未记录'}</dd>
          </div>
          <div>
            <dt>复核来源</dt>
            <dd>
              {note.reviewId || (note.origin === 'saved' ? '旧版当前结论快照' : '用户明确选定的本机资料')}
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
export function ReviewSourceNotes({
  notes,
  remove,
  disabled,
  sourceRunId,
}: {
  notes: ReviewSourceNote[];
  remove?: (index: number) => void;
  disabled?: boolean;
  sourceRunId?: string;
}) {
  const [selected, setSelected] = useState<{ runId: string; note: ReviewSourceNote }>();
  const headingId = useId();
  const visible =
    selected &&
    selected.runId === sourceRunId &&
    notes.some((note) => reviewNoteKey(note) === reviewNoteKey(selected.note))
      ? selected
      : undefined;
  return (
    <section className="review-source-notes" aria-labelledby={headingId}>
      <h4 id={headingId}>已加入 {notes.length} 条复核备注</h4>
      {!notes.length && <p className="field-help">尚未加入复核备注。</p>}
      {notes.map((note, index) => (
        <article
          className="workflow-selection review-source-note-card"
          key={reviewNoteKey(note) + index}
          aria-label={`第 ${index + 1} 条已加入备注`}
        >
          <div
            className="review-source-note-reading"
            role="region"
            tabIndex={0}
            aria-label={`第 ${index + 1} 条已加入备注的完整标准、正文与来源`}
          >
            <ReviewSourceNoteBody note={note} compact />
          </div>
          <div className="workflow-actions review-source-note-actions">
            {sourceRunId && note.origin === 'saved' && note.reviewId && (
              <button
                type="button"
                className="text-button"
                aria-label={`查看第 ${index + 1} 条备注的原复核`}
                disabled={disabled}
                onClick={() => setSelected({ runId: sourceRunId, note })}
              >
                查看原复核
              </button>
            )}
            {remove && (
              <button
                type="button"
                className="text-button"
                aria-label={`移除第 ${index + 1} 条已加入备注`}
                disabled={disabled}
                onClick={() => remove(index)}
              >
                移除此带入备注
              </button>
            )}
          </div>
        </article>
      ))}
      {visible && (
        <OriginalReview
          key={`${visible.runId}:${visible.note.reviewId}`}
          runId={visible.runId}
          note={visible.note}
          close={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}
