/**
 * 任务中心分类、条目和读取结果的契约。
 * 列表、变更游标与通知修订分别建模，标题等非执行编辑不产生完成通知。
 *
 * EN: Defines task-center categories, items, and read results.
 * Models lists, change cursors, and notification revisions separately; cosmetic edits do not create completion notifications.
 */
import type { Run, Message } from './index.js';
import type { RecordPage, ProjectionReadCoverage, ProjectionReadIssue, ExecutionHold } from './run-reads.js';
import type { DeliveryReviewIssue, DeliveryReviewStatus } from './workflow.js';

export type TaskCenterCategory =
  | 'running'
  | 'waiting'
  | 'verification'
  | 'done'
  | 'failed'
  | 'paused'
  | 'unavailable';
/**
 * 中心条目保留状态、分类和修订；读取失败或持久暂停可独立表达。
 *
 * EN: Items retain execution status, category, and revision; read failures and durable holds are independently represented.
 */
export type TaskCenterItem = {
  id: string;
  title: string;
  projectId: string | null;
  kind: Run['kind'];
  status: Run['status'] | null;
  revision: number;
  category: TaskCenterCategory;
  changeRevision: number;
  reason?: string;
  /**
   * 持久调度暂停，独立于底层执行状态。
   *
   * EN: Durable scheduling hold; independent of the underlying execution status.
   */
  executionHold?: ExecutionHold;
  updatedAt?: string;
  reviewStatus?: DeliveryReviewStatus;
  reviewedAt?: string;
  reviewIssue?: DeliveryReviewIssue;
  readIssue?: ProjectionReadIssue;
  /**
   * 当前有意义的状态变化，不随标题或归档编辑而推进。
   *
   * EN: A current meaningful transition, never advanced by title or archive edits.
   */
  notification?: { status: 'DONE' | 'WAITING' | 'FAILED' | 'UNCERTAIN'; revision: number };
};
export type TaskCenterPage = {
  items: TaskCenterItem[];
  page: RecordPage;
  /**
   * 执行、项目、搜索范围内，复核筛选之前的覆盖情况。
   *
   * EN: Coverage before review filtering, within the execution/project/search scope.
   */
  reviewCoverage: { complete: boolean; unavailable: number };
  /**
   * 状态/复核筛选之前的未知执行记录；其查询归属也可能未知。
   *
   * EN: Unknown execution records before state/review filtering; query membership may also be unknown.
   */
  projectionCoverage?: ProjectionReadCoverage;
};
/**
 * 从 cursor 续读轻量变更；resetRequired 要求重建基线，item=null 表示该条已离开当前结果。
 *
 * EN: Continues lightweight changes from cursor; resetRequired rebuilds the baseline and item=null means the row left the result.
 */
export type TaskCenterChanges = {
  items: { id: string; changeRevision: number; item: TaskCenterItem | null }[];
  cursor: number;
  hasMore: boolean;
  baseline?: boolean;
  resetRequired?: boolean;
};
/**
 * 搜索只返回可定位摘要，完整消息正文和上下文需单独读取。
 *
 * EN: Search returns locatable summaries only; full messages and context require separate reads.
 */
export type MessageSearchPage = {
  items: { messageId: string; revision: number; role: Message['role']; snippet: string }[];
  page: RecordPage;
};
