/**
 * 读取交付复核所需的验收标准。
 * 根据当前验收依据读取完整标准并验证所属版本，供反馈和备注关联复用；读取不足时不以截断列表替代完整标准。
 * EN: Reads acceptance criteria needed to relink review notes. Reads full criteria against current acceptance evidence and validates revision ownership for feedback/note linking; incomplete reads do not substitute a truncated list for full criteria.
 */
import type { DeliveryCriterion, DeliveryReview } from '../../../packages/contracts/src/workflow';
import { ApiError, type SurfaceClient } from './api';
import type { ReviewNote } from './ReviewDraft';

/**
 * 只解析备注需要的页，不能混合交付版本。
 * EN: Resolve only the pages needed by notes, without mixing delivery versions.
 */
/**
 * 根据旧备注索引只读取必要验收页，返回 index 到当前标准的映射用于逐字重关联。
 * 所有页必须仍属于首屏的运行、根版本、交付指纹及分页范围，任一变化整体失败。
 * EN: Read only criteria pages referenced by old note indices and return an index-to-current-text map for exact relinking. All pages must match initial run/root revision/fingerprint/range, or fail the whole operation.
 */
export async function readReviewCriteria(
  api: SurfaceClient['api'],
  initial: DeliveryReview,
  notes: ReviewNote[],
  signal: AbortSignal,
) {
  /**
   * 只加载备注引用的页，避免为少量备注拉取全部验收标准。
   * EN: Load referenced pages only rather than every criterion for a few notes.
   */
  const criteria = new Map<number, DeliveryCriterion>(initial.criteria.map((item) => [item.index, item]));
  const { total, limit, offset: initialOffset } = initial.criteriaPage;
  const offsets = new Set(
    notes
      .filter((note) => !note.unknownStandard && note.index < total)
      .map((note) => Math.floor(note.index / limit) * limit)
      .filter((offset) => offset !== initialOffset),
  );
  for (const offset of offsets) {
    signal.throwIfAborted();
    const next = await api<DeliveryReview>(
      `/runs/${initial.runId}/delivery?criteriaOffset=${offset}&expectedRootRevision=${initial.rootRevision}`,
      undefined,
      undefined,
      signal,
    );
    signal.throwIfAborted();
    /**
     * 每页必须属于同一运行、根版本和交付指纹，避免把新旧标准混在一起。
     * EN: Each page must share run/root revision/fingerprint so old/new criteria cannot mix.
     */
    if (
      next.runId !== initial.runId ||
      next.runRevision !== initial.runRevision ||
      next.rootTaskId !== initial.rootTaskId ||
      next.rootRevision !== initial.rootRevision ||
      next.fingerprint !== initial.fingerprint ||
      next.criteriaPage.total !== total ||
      next.criteriaPage.offset !== offset ||
      next.criteriaPage.limit !== limit
    )
      throw new ApiError('交付记录已变化，请重新读取交付后核对备注。', 'http', 409, 'DELIVERY_CHANGED');
    for (const item of next.criteria) criteria.set(item.index, item);
  }
  if (notes.some((note) => !note.unknownStandard && note.index < total && !criteria.has(note.index)))
    throw new ApiError('验收项读取不完整，请重试核对备注。', 'protocol');
  return criteria;
}
