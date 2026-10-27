/**
 * 描述详情读取状态并生成人可读的原因。
 * 集中描述详情覆盖完整性并生成阻断原因，供交接和模型切换复用；不把空数组自动视为完整数据。
 * EN: Describes detail-read coverage and produces readable explanations. Models detail completeness and produces shared blocking reasons for handoff/model switching, without assuming an empty array proves complete data.
 */
import type {
  RunDetailCoverage,
  ExecutionHold,
  EventPreviewCoverage,
} from '../../../packages/contracts/src/run-reads';

/**
 * 服务端投影读取覆盖与持久执行暂停分别记录；事件预览缺口不等同于业务实体不可读。
 * EN: Track server projection coverage and durable execution holds separately; an event-preview gap does not mean business entities are unreadable.
 */
export type DetailReadState = {
  readOnly?: boolean;
  readOnlyReason?: string | null;
  localExecutionStopped?: boolean;
  executionHold?: ExecutionHold | null;
  detailCoverage?: RunDetailCoverage;
  eventPreviewCoverage?: EventPreviewCoverage;
};

/**
 * 任一详情分区读取不完整时返回只读提示；完整或尚无覆盖信息时返回空字符串。
 * EN: Return a read-only explanation when any detail partition is incomplete; return an empty string for complete data or absent coverage metadata.
 */
export function detailReadReason(detail?: DetailReadState | null): string {
  if (!Object.values(detail?.detailCoverage || {}).some((part) => !part.complete)) return '';
  return detail?.readOnlyReason || '部分执行记录暂时无法读取，当前仅供查看。修复后请重试读取。';
}
