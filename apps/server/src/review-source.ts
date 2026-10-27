/** 捕获交付审阅使用的来源快照。 */
import { AppError, invariant, type Run, type Task } from '../../../packages/contracts/src/index.js';
import {
  ReviewSourceNote,
  reviewSourceTextByteLength,
  reviewSourceTextLimitBytes,
  reviewSourceSnapshotByteLength,
  reviewSourceSnapshotLimitBytes,
  type RunSourceSelection,
} from '../../../packages/contracts/src/workflow.js';
import { stable, type Store } from '../../../packages/storage/src/index.js';
import { deliveryFingerprint } from './delivery-fingerprint.js';
import { savedReviewSnapshot } from './delivery-review-history.js';

/** Saved reviews are verified against their record; drafts remain explicitly user-supplied material. */
export function captureReviewSource(store: Store, run: Run, selection: RunSourceSelection) {
  const notes = (selection.reviewNotes ?? []).map((note) => ({
    ...ReviewSourceNote.parse(note),
    reviewId: note.reviewId ?? null,
  }));
  if (!notes.length) return {};
  invariant(notes.length <= 40, 'SOURCE_REVIEW_LIMIT', '最多选择 40 条复核备注');
  invariant(
    reviewSourceTextByteLength(notes) <= reviewSourceTextLimitBytes,
    'SOURCE_REVIEW_TEXT_LIMIT',
    '所选复核备注正文超过 16 KiB，请减少选择；内容不会自动截断',
  );
  invariant(
    reviewSourceSnapshotByteLength(notes) <= reviewSourceSnapshotLimitBytes,
    'SOURCE_REVIEW_SNAPSHOT_LIMIT',
    '复核备注及原标准快照超过 32 KiB，请减少选择；内容不会自动截断',
  );
  invariant(
    new Set(notes.map((note) => stable(note))).size === notes.length,
    'SOURCE_REVIEW_DUPLICATE',
    '同一复核备注不能重复加入',
  );
  const root = store.require<Task>('tasks', run.rootTaskId);
  invariant(
    run.kind === 'task' &&
      !!run.projectId &&
      (run.execution?.kind ?? 'native') === 'native' &&
      run.status === 'DONE' &&
      root.runId === run.id &&
      root.status === 'DONE',
    'SOURCE_REVIEW_SCOPE',
    '复核备注只能来自已交付的原生项目任务',
  );
  const fingerprint = deliveryFingerprint(store, run, root);
  if (fingerprint !== selection.expectedDeliveryFingerprint)
    throw new AppError('SOURCE_DELIVERY_CHANGED', '来源交付版本已变化，请重新核对所选备注', false, null, 409);
  for (const note of notes) {
    if (note.origin !== 'saved') continue;
    const review = note.reviewId ? savedReviewSnapshot(store, run.id, note.reviewId) : run.deliveryReview;
    const criterion = review?.criteriaNotes.find((item) => item.index === note.criterionIndex);
    const expectedNote = note.criterionIndex === null ? review?.note : criterion?.note;
    const expectedText = note.criterionIndex === null ? null : (criterion?.criterionText ?? null);
    if (
      !review ||
      note.fingerprint !== review.fingerprint ||
      note.note !== expectedNote ||
      note.criterionText !== expectedText
    )
      throw new AppError(
        'SOURCE_REVIEW_CHANGED',
        '所选已保存复核备注与记录不一致，请重新读取并选择',
        false,
        null,
        409,
      );
  }
  return { reviewNotes: notes, capturedDeliveryFingerprint: fingerprint };
}
