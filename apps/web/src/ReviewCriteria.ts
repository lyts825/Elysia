/* 读取交付复核所需的验收标准。 */
import type { DeliveryCriterion, DeliveryReview } from '../../../packages/contracts/src/workflow';
import { ApiError, type SurfaceClient } from './api';
import type { ReviewNote } from './ReviewDraft';

/** Resolve only the pages needed by notes, without mixing delivery versions. */
export async function readReviewCriteria(
  api: SurfaceClient['api'],
  initial: DeliveryReview,
  notes: ReviewNote[],
  signal: AbortSignal,
) {
  // 只加载备注引用的页，避免为少量备注拉取全部验收标准。
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
    // 每页必须属于同一运行、根版本和交付指纹，避免把新旧标准混在一起。
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
