import type { ReviewSourceNote } from '../../../packages/contracts/src/workflow';
import { useState } from 'react';
import { reviewNoteKey } from './ReviewSourceState';
import { deferredPanel } from './DeferredPanel';

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
  return (
    <>
      {showHeading && (
        <strong>
          {note.origin === 'saved' ? '已保存复核' : '本机备注资料'} ·{' '}
          {note.criterionIndex !== null
            ? `原第 ${note.criterionIndex + 1} 项`
            : note.criterionText
              ? '未关联旧备注'
              : '整体或未关联备注'}
        </strong>
      )}
      {(note.criterionIndex !== null || note.criterionText) && (
        <p className="workflow-prose">原标准：{note.criterionText ?? '旧标准内容未记录'}</p>
      )}
      {compact && note.note.length > 160 ? (
        <details>
          <summary>查看完整备注（{note.note.length} 字）</summary>
          <p className="workflow-prose">{note.note}</p>
        </details>
      ) : (
        <p className="workflow-prose">{note.note}</p>
      )}
      <details className="workflow-note-provenance">
        <summary>版本与来源信息</summary>
        <small>
          交付指纹 {note.fingerprint || '未记录'}
          <br />
          {note.reviewId
            ? `复核记录 ${note.reviewId}`
            : note.origin === 'saved'
              ? '旧版当前结论快照'
              : '用户明确选定的本机资料'}
        </small>
      </details>
    </>
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
  const visible =
    selected &&
    selected.runId === sourceRunId &&
    notes.some((note) => reviewNoteKey(note) === reviewNoteKey(selected.note))
      ? selected
      : undefined;
  return (
    <section aria-label="已加入的复核备注">
      <h4>已加入 {notes.length} 条复核备注</h4>
      {notes.map((note, index) => (
        <div className="workflow-selection" key={reviewNoteKey(note) + index}>
          <ReviewSourceNoteBody note={note} compact />
          {sourceRunId && note.origin === 'saved' && note.reviewId && (
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => setSelected({ runId: sourceRunId, note })}
            >
              查看原复核
            </button>
          )}
          {remove && (
            <button type="button" className="text-button" disabled={disabled} onClick={() => remove(index)}>
              移除此带入备注
            </button>
          )}
        </div>
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
