/* 定义、读取和校验复核来源及其备注。 */
import { z } from 'zod';
import {
  ReviewSourceNote,
  reviewSourceTextByteLength,
  reviewSourceSnapshotByteLength,
  reviewSourceTextLimitBytes,
  reviewSourceSnapshotLimitBytes,
} from '../../../packages/contracts/src/workflow';

const shape = z.object({
  version: z.literal(1),
  pending: z.array(ReviewSourceNote),
  added: z.array(ReviewSourceNote),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type ReviewSourceState = z.infer<typeof shape>;
export const emptyReviewSource = (): ReviewSourceState => ({
  version: 1,
  pending: [],
  added: [],
  fingerprint: null,
});
export const normalizeReviewNote = (note: ReviewSourceNote): ReviewSourceNote => ({
  origin: note.origin,
  reviewId: note.reviewId ?? null,
  fingerprint: note.fingerprint,
  criterionIndex: note.criterionIndex,
  criterionText: note.criterionText,
  note: note.note,
});
/** 以固定字段顺序生成键，缺省的 reviewId 统一为 null。 */
export const reviewNoteKey = (note: ReviewSourceNote) => JSON.stringify(normalizeReviewNote(note));
/** 缺省数据创建空状态；格式无效返回 undefined，调用方可保留原始内容。 */
export function readReviewSource(raw: unknown): ReviewSourceState | undefined {
  if (raw === undefined || raw === null) return emptyReviewSource();
  const result = shape.safeParse(raw);
  if (!result.success) return;
  return {
    ...result.data,
    pending: result.data.pending.map(normalizeReviewNote),
    added: result.data.added.map(normalizeReviewNote),
  };
}
/** 同时检查条数、正文和标准快照字节数；超限时提示减少选择，不截断原文。 */
export function reviewNotesIssue(notes: ReviewSourceNote[]) {
  if (notes.length > 40) return '最多带入 40 条复核备注，请减少选择。';
  if (notes.some((note) => !ReviewSourceNote.safeParse(note).success))
    return '有备注或原标准超出可带入范围，请调整选择；原文仍保留。';
  if (reviewSourceTextByteLength(notes) > reviewSourceTextLimitBytes)
    return '所选备注正文超过 16 KiB，请减少选择；原文不会截断。';
  if (reviewSourceSnapshotByteLength(notes) > reviewSourceSnapshotLimitBytes)
    return '所选备注及原标准超过 32 KiB，请减少选择；原文不会截断。';
  return '';
}
