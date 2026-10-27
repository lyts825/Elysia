/**
 * 提供交付复核状态的显示标签。
 * 集中提供复核状态到中文显示标签的映射，保证列表与详情用词一致；不改变服务端状态机。
 * EN: Provides display labels for delivery review status. Centralizes review-state-to-Chinese-label mappings for consistent list/detail wording without changing the server state machine.
 */
import type { DeliveryReviewStatus } from '../../../packages/contracts/src/workflow';
/**
 * 将持久化状态映射为界面文案；stale 明确表达旧结论失效，不继续显示为已采纳。
 * EN: Map saved states to labels; stale explicitly invalidates an old decision rather than keeping it accepted.
 */
export const reviewStatusLabels: Record<DeliveryReviewStatus, string> = {
  unreviewed: '未复核',
  accepted: '已采纳',
  changes_requested: '需修改',
  stale: '需重新复核',
};
