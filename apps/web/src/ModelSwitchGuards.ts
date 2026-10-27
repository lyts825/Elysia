/**
 * 判断任务是否可以继续以及模型切换的限制。
 * 为切换和恢复共用详情完整性、运行状态与副作用边界检查；返回可展示原因，不执行任何模型写入。
 * EN: Determines continuation and model-switch boundaries. Shares detail-completeness, run-state, and side-effect boundary checks for switching/resuming, returning displayable reasons without changing models.
 */
import type { Operation, RequestRecord, Run, Task } from '../../../packages/contracts/src/index';
import { detailReadReason, type DetailReadState } from './DetailReadState';

type SwitchDetail = DetailReadState & {
  run: Run;
  tasks: Task[];
  requests: RequestRecord[];
  operations: Operation[];
};
/**
 * 判断任务状态是否属于界面允许尝试续接的范围，最终准入仍由服务端检查。
 * EN: Check UI continuation states only; the server performs final admission.
 */
export function modelTaskCanContinue(task: Task) {
  return (
    task.status === 'FAILED' ||
    (task.status === 'CANCELLED' && !!task.parentTaskId) ||
    (task.status === 'WAITING' &&
      ['paused', 'interrupted', 'limit', 'rate_limit', 'subscription_limit', 'no_progress'].includes(
        task.waitReason || '',
      ))
  );
}
/**
 * 返回切换禁用原因，空字符串表示界面允许尝试；最终是否可切换仍由写接口按当前状态决定。
 * EN: Return a disabled reason or empty text to permit an attempt; writes still recheck current state.
 */
export function modelSwitchReason(detail: SwitchDetail, archived: boolean, taskId: string) {
  return taskBoundaryReason(detail, archived, taskId, false);
}
/**
 * 续接共用切换边界，但依赖失败必须先恢复依赖源，且允许已取消的子分支走局部恢复。
 * EN: Continuation shares switch boundaries, but dependency failure requires fixing its source first; cancelled child branches may recover locally.
 */
export function taskResumeReason(detail: SwitchDetail, archived: boolean, taskId: string) {
  if (detailReadReason(detail)) return detailReadReason(detail);
  const task = detail.tasks.find((item) => item.id === taskId);
  if (task?.waitReason === 'dependency_failed')
    return '请先定位并恢复依赖源，等待它完成；此任务不能直接恢复。';
  return taskBoundaryReason(detail, archived, taskId, true);
}
/**
 * 集中计算任务切换或恢复的阻断原因；先检查读取完整性，再核对归档、执行类型、活动请求及副作用边界，返回可展示的原因。
 * EN: Computes the blocking reason for task model switching or resumption, checking read completeness before archive, executor, active-request, and side-effect boundaries; returns a user-facing reason.
 */
function taskBoundaryReason(detail: SwitchDetail, archived: boolean, taskId: string, resume: boolean) {
  /**
   * 切换和恢复共用执行边界：数据不完整、未知副作用或活动请求均先阻止操作。
   * EN: Switch/resume share execution boundaries: incomplete reads, uncertain effects, and active requests block first.
   */
  if (detailReadReason(detail)) return detailReadReason(detail);
  if (detail.run.execution?.kind === 'docker-agent') return '终端配置在创建时冻结，调整 Agent 请新建任务。';
  const task = detail.tasks.find((item) => item.id === taskId);
  if (archived)
    return resume ? '请先恢复归档的会话或项目，再继续此代理。' : '请先恢复归档的会话或项目，再切换模型。';
  if (
    !task ||
    ['DONE', 'CANCELLED'].includes(detail.run.status) ||
    task.status === 'DONE' ||
    (task.status === 'CANCELLED' && !(resume && task.parentTaskId))
  )
    return resume ? '任务已结束，不能恢复此代理。' : '任务已结束，模型记录仅供查看。';
  if (
    task.status === 'VERIFYING' ||
    task.waitReason === 'verification' ||
    detail.requests.some((item) => item.taskId === taskId && item.status === 'UNKNOWN') ||
    detail.operations.some((item) => item.taskId === taskId && item.status === 'UNCERTAIN')
  )
    return resume ? '请先核验此代理的请求或操作，再继续。' : '请先核验此代理的请求或操作，再切换模型。';
  if (
    !['WAITING', 'FAILED', ...(resume && task.parentTaskId ? ['CANCELLED'] : [])].includes(task.status) ||
    detail.requests.some((item) => item.taskId === taskId && item.status === 'RESERVED') ||
    detail.operations.some((item) => item.taskId === taskId && item.status === 'INTENT')
  )
    return resume
      ? '此代理仍有执行中的请求或操作，请等待当前执行结束。'
      : '此代理正在执行，请先暂停，再切换模型。';
  return '';
}
