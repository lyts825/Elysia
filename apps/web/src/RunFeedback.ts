import type { Event, Operation, Run, Task } from '../../../packages/contracts/src/index';

type FeedbackDetail = {
  run: Run;
  tasks: Task[];
  operations: Operation[];
  events: Event[];
};
export type RunFeedback = {
  text: string;
  action?: 'artifacts' | 'plan' | 'reply' | 'archive' | 'limits' | 'settings' | 'new';
  control?: 'pause' | 'resume' | 'retry';
  limit?: {
    code: string;
    message: string;
    explanation: string;
    recheck: boolean;
    tasks: { id: string; title: string; code: string; message: string }[];
  };
};
const limitCodes = /^(?:TIME_BUDGET|STEP_LIMIT|REQUEST_BUDGET|TOKEN_BUDGET|COST_BUDGET|CONTEXT_LIMIT)$/;

export function getRunFeedback(detail: FeedbackDetail, archived: boolean): RunFeedback {
  const { run, tasks, operations, events } = detail;
  const noun = run.kind === 'chat' ? '独立对话' : '任务';
  const terminal = run.status === 'DONE' || run.status === 'CANCELLED';
  if (archived)
    return {
      text: terminal ? `已归档，恢复后可查看记录；继续工作请新建${noun}` : '已归档，恢复归档后可继续',
      action: 'archive',
    };
  if (run.status === 'CANCELLED') return { text: `已取消，记录保留；继续工作可新建${noun}`, action: 'new' };
  if (run.status === 'DONE') return { text: '交付已完成，可查看产物与验证记录', action: 'artifacts' };

  const uncertain = operations.filter(
    (operation) =>
      operation.status === 'UNCERTAIN' &&
      !tasks.some((task) => task.id === operation.taskId && ['DONE', 'CANCELLED'].includes(task.status)),
  ).length;
  const limited = tasks.filter((task) => task.status === 'WAITING' && task.waitReason === 'limit');
  if (run.reason === 'limit' || limited.length) {
    const expired = !!run.startedAt && Date.now() - run.startedAt >= run.limits.maxMinutes * 60000;
    const targets = limited.length ? limited : tasks.filter((task) => task.id === run.rootTaskId);
    const currentLimits = targets.map((task) => {
      let waitingFrom = -1;
      for (let index = events.length - 1; index >= 0; index--) {
        const item = events[index];
        if (item.type !== 'task.updated' || item.taskId !== task.id) continue;
        const state = item.payload as Partial<Task> | null;
        if (state?.status !== 'WAITING' || state.waitReason !== 'limit') {
          if (waitingFrom < 0) waitingFrom = index + 1;
          break;
        }
        waitingFrom = index;
      }
      const event = [...events].reverse().find((item) => {
        const payload = item.payload as { taskId?: string; code?: string } | null;
        const inCurrentWait =
          waitingFrom < 0 ? item.type === 'limit.reached' : events.indexOf(item) >= waitingFrom;
        return (
          inCurrentWait &&
          (item.type === 'limit.reached' || item.type === 'error') &&
          (item.taskId || payload?.taskId) === task.id &&
          typeof payload?.code === 'string' &&
          limitCodes.test(payload.code)
        );
      });
      const payload = event?.payload as { code: string; message?: string } | undefined;
      const code = payload?.code || (expired ? 'TIME_BUDGET' : 'UNKNOWN_LIMIT');
      const message =
        typeof payload?.message === 'string' && payload.message
          ? payload.message
          : expired
            ? '运行时间达到上限'
            : '已达到运行上限，具体原因未记录';
      return { id: task.id, title: task.spec.title, code, message };
    });
    const code = currentLimits.length === 1 ? currentLimits[0].code : 'MULTIPLE_LIMITS';
    const message =
      currentLimits.length === 1 ? currentLimits[0].message : `${currentLimits.length} 个任务达到运行上限`;
    const chatTime = run.kind === 'chat' && code === 'TIME_BUDGET';
    const hard =
      (expired && run.kind !== 'chat') ||
      currentLimits.some(
        (item) =>
          item.code === 'STEP_LIMIT' ||
          item.code === 'REQUEST_BUDGET' ||
          (item.code === 'TIME_BUDGET' && run.kind !== 'chat'),
      );
    const explanation = chatTime
      ? '恢复会重新开始本轮聊天计时；请求次数、Token 和费用预算仍累计，原有步骤上限也保留。'
      : hard
        ? '直接恢复不会重置累计时间、步骤或请求次数。可保留当前记录，新建任务并重新确认范围与预算。'
        : '恢复前请核对实际用量、资料范围与模型上下文；重新检查不会增加已授权预算，上限未解除时仍会等待。';
    return {
      text: uncertain ? `${uncertain} 项副作用待核验；${message}` : message,
      action: uncertain ? 'artifacts' : 'limits',
      control: chatTime
        ? 'resume'
        : ['READY', 'RUNNING'].includes(run.status) &&
            tasks.some((task) => ['READY', 'RUNNING'].includes(task.status))
          ? 'pause'
          : undefined,
      limit: { code, message, explanation, recheck: !hard, tasks: currentLimits },
    };
  }
  const control = ['READY', 'RUNNING'].includes(run.status)
    ? 'pause'
    : run.status === 'FAILED'
      ? 'retry'
      : run.status === 'WAITING' &&
          ['paused', 'interrupted', 'rate_limit', 'subscription_limit'].includes(run.reason || '')
        ? 'resume'
        : undefined;
  if (uncertain)
    return {
      text: `${run.reason === 'paused' ? '已暂停；' : ''}${uncertain} 项副作用待核验，请检查本机证据`,
      action: 'artifacts',
      control,
    };
  if (run.status === 'FAILED')
    return { text: run.reason ? `执行失败：${run.reason}` : '执行失败，可按已有授权重试', control };
  if (run.status === 'WAITING') {
    switch (run.reason) {
      case 'plan':
        return { text: '等待接受计划，请核对分工、型号与验收项', action: 'plan' };
      case 'user':
        return {
          text: run.kind === 'chat' ? '等待下一条消息' : '等待你的回答，可在下方补充说明',
          action: 'reply',
        };
      case 'verification':
        return { text: '副作用待核验，请检查本机证据', action: 'artifacts' };
      case 'paused':
        return { text: '已暂停，检查点与记录已保留', control };
      case 'interrupted':
        return { text: '服务中断，检查记录后可恢复', control };
      case 'subscription_limit':
        return { text: 'ChatGPT 订阅额度受限，请在模型设置中核对用量', action: 'settings', control };
      case 'rate_limit':
        return { text: '账号请求或 Token 速率受限，额度恢复后可继续', control };
      case 'children':
        return { text: '等待子任务交付，随后集成与验收' };
    }
  }
  const root = tasks.find((task) => task.id === run.rootTaskId);
  return {
    text:
      root?.status === 'WAITING' && root.waitReason === 'children'
        ? '子代理按依赖推进，总代理等待交付后集成'
        : run.reason || '进度与结果自动保存',
    control,
  };
}

export function archiveFeedback(run: Run, projectArchived: boolean): string {
  if (run.status === 'DONE' || run.status === 'CANCELLED')
    return `记录已归档。恢复后可查看记录；继续工作请新建${run.kind === 'chat' ? '独立对话' : '任务'}。`;
  return projectArchived ? '所属项目已归档，恢复项目后可继续。' : '对话已归档，恢复后可继续。';
}
