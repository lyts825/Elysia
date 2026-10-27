/**
 * 解析任务中心条目对应的导航目标。
 *
 * EN: Resolves navigation targets for task-center entries.
 *
 * 本模块是导航目标解析层：根据新读取的详情及读取完整性，输出工作台应打开的页面和任务定位信息；仅做状态优先级判定，不发起请求或执行恢复命令。
 * EN: Resolves navigation destinations and task focus from freshly read details and read coverage. It applies state precedence only, without requests or recovery commands.
 */
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
 *
 * EN: Resolves from freshly read full detail; the list category is only a hint. Read errors, archives, terminal acceptance, unknown operations/usage, and full summaries have priority. Navigation neither accepts plans, resumes work, nor settles unknown requests.
 */
export function taskCenterDestination(
  detail: Detail,
  target: TaskCenterTarget,
  archived: boolean,
  terminalSurface: boolean,
): TaskCenterDestination {
  /**
   * 先处理只读、归档及结果未知等优先级更高的状态，再决定具体目标页面。
   *
   * EN: Handles read-only/archive/unknown outcomes before selecting a specific destination.
   */
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
  /**
   * 历史 UNKNOWN 请求可能不在当前会话预览中，
   * 即使列表或 Run 仍为 READY，也应以完整汇总确定入口。
   *
   * EN: A historical UNKNOWN request can be outside the conversation preview, even
   * when the list or Run still says READY. Resolve from the complete summary.
   */
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
