/* 描述详情读取状态并生成人可读的原因。 */
import type {
  RunDetailCoverage,
  ExecutionHold,
  EventPreviewCoverage,
} from '../../../packages/contracts/src/run-reads';

/** 服务端投影读取覆盖与持久执行暂停分别记录；事件预览缺口不等同于业务实体不可读。 */
export type DetailReadState = {
  readOnly?: boolean;
  readOnlyReason?: string | null;
  localExecutionStopped?: boolean;
  executionHold?: ExecutionHold | null;
  detailCoverage?: RunDetailCoverage;
  eventPreviewCoverage?: EventPreviewCoverage;
};

/** 任一详情分区读取不完整时返回只读提示；完整或尚无覆盖信息时返回空字符串。 */
export function detailReadReason(detail?: DetailReadState | null): string {
  if (!Object.values(detail?.detailCoverage || {}).some((part) => !part.complete)) return '';
  return detail?.readOnlyReason || '部分执行记录暂时无法读取，当前仅供查看。修复后请重试读取。';
}
