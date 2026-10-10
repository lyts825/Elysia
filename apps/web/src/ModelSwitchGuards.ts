import type { Operation, RequestRecord, Run, Task } from '../../../packages/contracts/src/index';

type SwitchDetail = { run: Run; tasks: Task[]; requests: RequestRecord[]; operations: Operation[] };
export function modelTaskCanContinue(task: Task) {
  return (
    task.status === 'FAILED' ||
    (task.status === 'WAITING' &&
      ['paused', 'interrupted', 'limit', 'rate_limit', 'subscription_limit'].includes(task.waitReason || ''))
  );
}
export function modelSwitchReason(detail: SwitchDetail, archived: boolean, taskId: string) {
  if (detail.run.execution?.kind === 'docker-agent') return '终端配置在创建时冻结，调整 Agent 请新建任务。';
  const task = detail.tasks.find((item) => item.id === taskId);
  if (archived) return '请先恢复归档的会话或项目，再切换模型。';
  if (
    !task ||
    ['DONE', 'CANCELLED'].includes(detail.run.status) ||
    ['DONE', 'CANCELLED'].includes(task.status)
  )
    return '任务已结束，模型记录仅供查看。';
  if (
    task.status === 'VERIFYING' ||
    task.waitReason === 'verification' ||
    detail.requests.some((item) => item.taskId === taskId && item.status === 'UNKNOWN') ||
    detail.operations.some((item) => item.taskId === taskId && item.status === 'UNCERTAIN')
  )
    return '请先核验此代理的请求或操作，再切换模型。';
  if (
    !['WAITING', 'FAILED'].includes(task.status) ||
    detail.requests.some((item) => item.taskId === taskId && item.status === 'RESERVED') ||
    detail.operations.some((item) => item.taskId === taskId && item.status === 'INTENT')
  )
    return '此代理正在执行，请先暂停，再切换模型。';
  return '';
}
