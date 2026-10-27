/**
 * 运行详情读取、覆盖情况及分页投影的契约。
 * 轻量状态与正文覆盖分开，读取错误既不能修改执行状态，也不能被当作记录不存在。
 *
 * EN: Defines run-detail reads, coverage, and paged projections.
 * Separates lightweight state from body coverage; read errors neither change execution state nor imply absence.
 */
export type ProjectionReadIssue = {
  code: 'READ_MODEL_UNAVAILABLE';
  message: string;
  retryable: true;
};
/**
 * complete 表示读取覆盖完整；unavailable 单独计数无法读取的记录。
 *
 * EN: complete indicates full read coverage; unavailable separately counts unreadable records.
 */
export type ProjectionReadCoverage = { complete: boolean; unavailable: number };
export type DetailCollectionCoverage = ProjectionReadCoverage & {
  total: number;
  /**
   * 选中的会话记录不能验证全部历史正文。
   *
   * EN: Selected conversation records do not validate every historical body.
   */
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
/**
 * 仅当前仍未回答的问题；limited/unavailableTaskIds 区分读取受限与确实没有问题。
 *
 * EN: Only currently unanswered questions; limited/unavailableTaskIds distinguish read limits from confirmed absence.
 */
export type RunCurrentQuestions = {
  items: CurrentQuestion[];
  coverage: ProjectionReadCoverage & { limited: boolean };
  unavailableTaskIds: string[];
};
export type EventPreviewCoverage = ProjectionReadCoverage & { limited: boolean };
/**
 * 停止动作的分项结果，调度暂停、持久记录与本机进程停止必须分别核验。
 *
 * EN: Separate stop outcomes for scheduling, durable state, and local processes must each be verified.
 */
export type RunStopCurrentResult = {
  runId: string;
  interrupted: boolean;
  schedulingPaused: true;
  persistentPauseRecorded: boolean;
  localExecutionStopped: boolean;
  replayed: boolean;
  message: string;
};
/**
 * 跨重启保留的调度暂停，独立于任务状态；不可读记录修复后仍需显式恢复。
 *
 * EN: A scheduling hold survives restarts independently of task status; repairing unreadable rows still requires explicit resume.
 */
export type ExecutionHold = {
  reason: 'user_stop' | 'recovery_unreadable';
  since: string;
  issueCount: number;
  message: string;
};
/**
 * 按稳定 before 游标读取记录；total 是范围内总数，不是当前页长度。
 *
 * EN: Pages records with a stable before cursor; total is the scope count, not this page length.
 */
export type RecordPage = {
  total: number;
  limit: number;
  before: string | null;
  hasMore: boolean;
  nextBefore: string | null;
};
/**
 * 完整账本的独立汇总，costKnown=false 时 cost 仅含已知金额，不能视为完整费用。
 *
 * EN: An independent full-ledger summary; if costKnown is false, cost contains known amounts only, not the complete cost.
 */
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
  /**
   * 对当前页之外保留或选中行的完整目标文本做精确搜索归属判断。
   *
   * EN: Exact full-objective search membership for retained or selected rows outside the page.
   */
  matchesQuery?: boolean;
};
