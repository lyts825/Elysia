// 运行详情读取、覆盖情况及分页投影的契约。
export type ProjectionReadIssue = {
  code: 'READ_MODEL_UNAVAILABLE';
  message: string;
  retryable: true;
};
// complete 表示读取覆盖完整；unavailable 单独计数无法读取的记录。
export type ProjectionReadCoverage = { complete: boolean; unavailable: number };
export type DetailCollectionCoverage = ProjectionReadCoverage & {
  total: number;
  /** Selected conversation records do not validate every historical body. */
  scope: 'all' | 'selected';
};
export type RunDetailCoverage = {
  tasks: DetailCollectionCoverage;
  requests: DetailCollectionCoverage;
  operations: DetailCollectionCoverage;
};
export type CurrentQuestion = {
  eventId: string;
  taskId: string;
  title: string;
  questions: string[];
  seq: number;
};
/** 仅当前仍未回答的问题；limited/unavailableTaskIds 区分读取受限与确实没有问题。 */
export type RunCurrentQuestions = {
  items: CurrentQuestion[];
  coverage: ProjectionReadCoverage & { limited: boolean };
  unavailableTaskIds: string[];
};
export type EventPreviewCoverage = ProjectionReadCoverage & { limited: boolean };
/** 停止动作的分项结果，调度暂停、持久记录与本机进程停止必须分别核验。 */
export type RunStopCurrentResult = {
  runId: string;
  interrupted: boolean;
  schedulingPaused: true;
  persistentPauseRecorded: boolean;
  localExecutionStopped: boolean;
  replayed: boolean;
  message: string;
};
/** 跨重启保留的调度暂停，独立于任务状态；不可读记录修复后仍需显式恢复。 */
export type ExecutionHold = {
  reason: 'user_stop' | 'recovery_unreadable';
  since: string;
  issueCount: number;
  message: string;
};
/** 按稳定 before 游标读取记录；total 是范围内总数，不是当前页长度。 */
export type RecordPage = {
  total: number;
  limit: number;
  before: string | null;
  hasMore: boolean;
  nextBefore: string | null;
};
/** 完整账本的独立汇总，costKnown=false 时 cost 仅含已知金额，不能视为完整费用。 */
export type RunUsageSummary = {
  readCoverage?: ProjectionReadCoverage;
  requestCount: number;
  settledCount: number;
  unknownCount: number;
  totalTokens: number;
  costKnown: boolean;
  cost: number;
  providers: { providerId: string; input: number; cacheRead: number | null; ttftMs: number | null }[];
};
import type { Run } from './index.js';
export type RunListItem = Pick<
  Run,
  | 'id'
  | 'revision'
  | 'title'
  | 'objective'
  | 'kind'
  | 'projectId'
  | 'rootTaskId'
  | 'status'
  | 'reason'
  | 'archived'
  | 'createdAt'
> & {
  execution?: { kind: 'docker-agent' | 'native' };
  /** Exact full-objective search membership for retained or selected rows outside the page. */
  matchesQuery?: boolean;
};
