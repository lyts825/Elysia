/**
 * 定义、读取和校验复核来源及其备注。
 * 规范化复核备注身份、严格读取选择草稿并校验条数和编码体积，供多个面板共享；不静默裁剪用户原文。
 * EN: Defines, restores, and validates review-source notes. Normalizes review-note identity, strictly reads selection drafts, and checks count/encoded size for shared panels without silently trimming user text.
 */
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
/**
 * pending 与 added 分离，fingerprint 记录整组选取时的比较基线。
 * EN: Separate pending/added; fingerprint captures the collection baseline when selected.
 */
export type ReviewSourceState = z.infer<typeof shape>;
/**
 * 返回新的版本1备注来源状态，待选和已加入列表独立为空，尚未绑定交付指纹。
 * EN: Returns fresh version-1 note-source state with independent empty pending/added lists and no delivery fingerprint.
 */
export const emptyReviewSource = (): ReviewSourceState => ({
  version: 1,
  pending: [],
  added: [],
  fingerprint: null,
});
/**
 * 保留可验证来源字段并统一缺省值，避免相同备注因属性顺序或缺省 reviewId 生成不同身份。
 * EN: Preserve verifiable source fields and normalize defaults so ordering or absent reviewId does not change note identity.
 */
export const normalizeReviewNote = (note: ReviewSourceNote): ReviewSourceNote => ({
  origin: note.origin,
  reviewId: note.reviewId ?? null,
  fingerprint: note.fingerprint,
  criterionIndex: note.criterionIndex,
  criterionText: note.criterionText,
  note: note.note,
});
/**
 * 以固定字段顺序生成键，缺省的 reviewId 统一为 null。
 * EN: Build keys in fixed field order and normalize absent reviewId to null.
 */
export const reviewNoteKey = (note: ReviewSourceNote) => JSON.stringify(normalizeReviewNote(note));
/**
 * 缺省数据创建空状态；格式无效返回 undefined，调用方可保留原始内容。
 * EN: Absent data starts empty; invalid input returns undefined so caller can preserve originals.
 */
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
/**
 * 同时检查条数、正文和标准快照字节数；超限时提示减少选择，不截断原文。
 * EN: Check count and encoded note/criterion bytes together; ask users to reduce selection rather than truncating originals.
 */
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
