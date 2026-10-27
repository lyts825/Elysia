/* 解析任务中心条目对应的导航目标。 */
import type { TaskCenterCategory } from '../../../packages/contracts/src/task-center';
import { detailReadReason } from './DetailReadState';
import { getRunFeedback } from './RunFeedback';

type Detail = Parameters<typeof getRunFeedback>[0] & {
  summaryDeferred?: boolean;
  usageSummary?: { unknownCount: number };
};
export type TaskCenterTarget = TaskCenterCategory | 'review';
export type TaskCenterDestination =
  | { kind: 'summary' | 'status' | 'review' | 'terminal-review' | 'usage' }
  | { kind: 'operation'; operationId: string }
  | { kind: 'tasks'; taskId?: string }
  | { kind: 'artifacts' | 'plan' | 'reply' | 'questions' | 'archive' | 'limits' | 'settings' };

/**
 * 用刚读取的完整详情重新确定任务中心的跳转目标，列表分类仅是入口提示。
 * 读取异常、归档、终端验收、未知操作/用量和完整摘要依次优先；这里只导航，
 * 不接受计划、不恢复执行，也不替用户结算未知请求。
 */
export function taskCenterDestination(
  detail: Detail,
  target: TaskCenterTarget,
  archived: boolean,
  terminalSurface: boolean,
): TaskCenterDestination {
  // 先处理只读、归档及结果未知等优先级更高的状态，再决定具体目标页面。
  if (detailReadReason(detail) || detail.readOnly) return { kind: 'status' };
  if (archived) return { kind: 'archive' };
  const { run } = detail;
  if (run.status === 'WAITING' && run.reason === 'terminal_review' && run.execution?.kind === 'docker-agent')
    return { kind: 'terminal-review' };
  const operation = detail.operations.find(
    (item) =>
      item.status === 'UNCERTAIN' &&
      (run.execution?.kind !== 'docker-agent' || item.name === 'terminal_agent'),
  );
  if (operation) return { kind: 'operation', operationId: operation.id };
  if (detail.requests?.some((item) => item.status === 'UNKNOWN') || detail.usageSummary?.unknownCount)
    return { kind: 'usage' };
  // A historical UNKNOWN request can be outside the conversation preview, even
  // when the list or Run still says READY. Resolve from the complete summary.
  if (detail.summaryDeferred) return { kind: 'summary' };
  if (
    target === 'review' &&
    !terminalSurface &&
    run.kind === 'task' &&
    run.status === 'DONE' &&
    run.execution?.kind !== 'docker-agent'
  )
    return { kind: 'review' };
  const feedback = getRunFeedback(detail, archived);
  if (feedback.action === 'tasks') return { kind: 'tasks', taskId: feedback.blockedTaskId };
  if (feedback.action && feedback.action !== 'new') return { kind: feedback.action };
  return { kind: 'status' };
}
