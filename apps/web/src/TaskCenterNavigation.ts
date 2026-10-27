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

// The list is a snapshot. Resolve the destination again from freshly read detail;
// navigation never accepts a plan, resumes execution, or settles a request.
export function taskCenterDestination(
  detail: Detail,
  target: TaskCenterTarget,
  archived: boolean,
  terminalSurface: boolean,
): TaskCenterDestination {
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
