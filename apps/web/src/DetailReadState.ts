import type {
  RunDetailCoverage,
  ExecutionHold,
  EventPreviewCoverage,
} from '../../../packages/contracts/src/run-reads';

export type DetailReadState = {
  readOnly?: boolean;
  readOnlyReason?: string | null;
  localExecutionStopped?: boolean;
  executionHold?: ExecutionHold | null;
  detailCoverage?: RunDetailCoverage;
  eventPreviewCoverage?: EventPreviewCoverage;
};

export function detailReadReason(detail?: DetailReadState | null): string {
  if (!Object.values(detail?.detailCoverage || {}).some((part) => !part.complete)) return '';
  return detail?.readOnlyReason || '部分执行记录暂时无法读取，当前仅供查看。修复后请重试读取。';
}
