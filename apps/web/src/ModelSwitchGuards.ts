/* 判断任务是否可以继续以及模型切换的限制。 */
import type { Operation, RequestRecord, Run, Task } from '../../../packages/contracts/src/index';
import { detailReadReason, type DetailReadState } from './DetailReadState';

type SwitchDetail = DetailReadState & {
  run: Run;
  tasks: Task[];
  requests: RequestRecord[];
  operations: Operation[];
};
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
export function modelSwitchReason(detail: SwitchDetail, archived: boolean, taskId: string) {
  return taskBoundaryReason(detail, archived, taskId, false);
}
export function taskResumeReason(detail: SwitchDetail, archived: boolean, taskId: string) {
  if (detailReadReason(detail)) return detailReadReason(detail);
  const task = detail.tasks.find((item) => item.id === taskId);
  if (task?.waitReason === 'dependency_failed')
    return '请先定位并恢复依赖源，等待它完成；此任务不能直接恢复。';
  return taskBoundaryReason(detail, archived, taskId, true);
}
function taskBoundaryReason(detail: SwitchDetail, archived: boolean, taskId: string, resume: boolean) {
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
