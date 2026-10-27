/* 提供交付复核状态的显示标签。 */
import type { DeliveryReviewStatus } from '../../../packages/contracts/src/workflow';
export const reviewStatusLabels: Record<DeliveryReviewStatus, string> = {
  unreviewed: '未复核',
  accepted: '已采纳',
  changes_requested: '需修改',
  stale: '需重新复核',
};
