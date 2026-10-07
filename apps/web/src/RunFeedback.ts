import type { Event, Operation, RequestRecord, Run, Task } from '../../../packages/contracts/src/index';

type FeedbackDetail = {
  run: Run;
  tasks: Task[];
  operations: Operation[];
  requests?: RequestRecord[];
  events: Event[];
  edges?: { taskId: string; dependencyId: string }[];
};
export type RunFeedback = {
  text: string;
  displayStatus?: 'WAITING';
  action?: 'artifacts' | 'plan' | 'reply' | 'questions' | 'archive' | 'limits' | 'settings' | 'new';
  control?: 'pause' | 'resume' | 'retry';
  resumeTaskId?: string;
  limit?: {
    code: string;
    message: string;
    explanation: string;
    recheck: boolean;
    tasks: { id: string; title: string; code: string; message: string }[];
  };
};
const limitCodes =
  /^(?:TIME_BUDGET|STEP_LIMIT|REQUEST_BUDGET|TOKEN_BUDGET|COST_BUDGET|CONTEXT_LIMIT|ACCOUNT_TOKEN_LIMIT)$/;

export function currentQuestions(detail: Pick<FeedbackDetail, 'tasks' | 'events'>) {
  const questions: { eventId: string; taskId: string; title: string; questions: string[]; seq: number }[] =
    [];
  for (const task of detail.tasks.filter((item) => item.status === 'WAITING' && item.waitReason === 'user')) {
    for (let index = detail.events.length - 1; index >= 0; index--) {
      const event = detail.events[index];
      const payload = event.payload as {
        status?: string;
        waitReason?: string;
        taskId?: string;
        questions?: unknown;
      } | null;
      if (
        event.type === 'task.updated' &&
        event.taskId === task.id &&
        (payload?.status !== 'WAITING' || payload.waitReason !== 'user')
      )
        break;
      if (event.type !== 'decision.required' || (event.taskId || payload?.taskId) !== task.id) continue;
      const values = Array.isArray(payload?.questions)
        ? payload.questions.filter((value): value is string => typeof value === 'string' && !!value.trim())
        : [];
      if (!values.length) continue;
      questions.push({
        eventId: event.eventId,
        taskId: task.id,
        title: task.spec.role === 'coordinator' ? '总代理' : task.spec.title,
        questions: values,
        seq: event.seq,
      });
      break;
    }
  }
  return questions.sort((a, b) => a.seq - b.seq);
}

export function rateResumeAt(task: Task): number | null {
  const value =
    task.rateLimit === undefined
      ? (task.result as { resumeAt?: unknown } | null)?.resumeAt
      : task.rateLimit?.resumeAt;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function rateWaitText(
  task: Task,
  automatic: boolean,
  now = Date.now(),
  dependenciesReady = true,
): string {
  const resumeAt = rateResumeAt(task);
  const providerWait = task.rateLimit?.source === 'provider';
  const label = providerWait ? '模型服务暂时受限' : '账号速率受限';
  if (!automatic) return `${providerWait ? '等待模型服务重试' : '等待账号额度'}，运行恢复后再检查`;
  if (!dependenciesReady) return '等待前置任务完成，再按记录时间重新检查';
  if (resumeAt === null) return `${label}，未记录重试时间`;
  const seconds = Math.max(0, Math.ceil((resumeAt - now) / 1000));
  if (!seconds) return '等待时间已到，待重新调度';
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  return `${label}，约 ${duration}后自动重试`;
}

export function getRunFeedback(detail: FeedbackDetail, archived: boolean, now = Date.now()): RunFeedback {
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
    const expired = !!run.startedAt && now - run.startedAt >= run.limits.maxMinutes * 60000;
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
          item.code === 'ACCOUNT_TOKEN_LIMIT' ||
          (item.code === 'TIME_BUDGET' && run.kind !== 'chat'),
      );
    const explanation = chatTime
      ? '恢复会重新开始本轮聊天计时；请求次数、Token 和费用预算仍累计，原有步骤上限也保留。'
      : currentLimits.some((item) => item.code === 'ACCOUNT_TOKEN_LIMIT')
        ? '单次请求所需 Token 超过账号每分钟上限，等待不会解除。请减少资料，或在模型设置中调整额度后新建任务。'
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
  const rateTasks = tasks.filter((task) => task.status === 'WAITING' && task.waitReason === 'rate_limit');
  const rootRateTask = tasks.find(
    (task) =>
      task.id === run.rootTaskId &&
      (task.status === 'READY' || (task.status === 'WAITING' && task.waitReason === 'rate_limit')),
  );
  const rootTimed = !!rootRateTask && rateResumeAt(rootRateTask) !== null;
  const rootRateWait = run.status === 'WAITING' && run.reason === 'rate_limit';
  const rateTargets =
    rootRateWait && rootRateTask && !rateTasks.includes(rootRateTask)
      ? [...rateTasks, rootRateTask]
      : rateTasks;
  const timedRateTasks = rateTargets.filter((task) => rateResumeAt(task) !== null);
  const nextRateTask = [...timedRateTasks]
    .filter((task) =>
      (detail.edges || [])
        .filter((edge) => edge.taskId === task.id)
        .every((edge) =>
          tasks.some((dependency) => dependency.id === edge.dependencyId && dependency.status === 'DONE'),
        ),
    )
    .sort((a, b) => rateResumeAt(a)! - rateResumeAt(b)!)[0];
  const unknownRateTasks = rateTargets.length - timedRateTasks.length;
  const rateText =
    rootRateWait && !rootTimed
      ? '主任务未记录有效重试时间，请检查后手动恢复'
      : nextRateTask
        ? `${rateTargets.length > 1 ? `${rateTargets.length} 个任务等待；` : ''}${rateWaitText(nextRateTask, true, now)}` +
          (unknownRateTasks ? `；${unknownRateTasks} 个任务未记录重试时间，可暂停后恢复重新检查` : '')
        : timedRateTasks.length
          ? '等待前置任务完成，再按记录时间重新检查'
          : '未记录有效重试时间，可暂停后恢复重新检查';
  const control = ['READY', 'RUNNING'].includes(run.status)
    ? 'pause'
    : run.status === 'FAILED'
      ? 'retry'
      : run.status === 'WAITING' &&
          ['paused', 'interrupted', 'rate_limit', 'subscription_limit'].includes(run.reason || '')
        ? run.reason === 'rate_limit' && rootTimed
          ? 'pause'
          : 'resume'
        : undefined;
  if (uncertain)
    return {
      text: `${run.reason === 'paused' ? '已暂停；' : ''}${uncertain} 项副作用待核验，请检查本机证据`,
      action: 'artifacts',
      control,
    };
  if (run.status === 'FAILED')
    return { text: run.reason ? `执行失败：${run.reason}` : '执行失败，可按已有授权重试', control };
  const root = tasks.find((task) => task.id === run.rootTaskId);
  const userTasks = tasks.filter((task) => task.status === 'WAITING' && task.waitReason === 'user');
  const priorityWait =
    rateTasks.length ||
    tasks.some((task) => task.status === 'WAITING' && task.waitReason === 'verification') ||
    detail.requests?.some((request) => request.status === 'UNKNOWN') ||
    (run.status === 'WAITING' &&
      ['plan', 'verification', 'rate_limit', 'subscription_limit'].includes(run.reason || ''));
  if (run.kind === 'task' && userTasks.length && !priorityWait) {
    const active =
      tasks.some((task) => ['READY', 'RUNNING', 'VERIFYING'].includes(task.status)) ||
      detail.requests?.some((request) => request.status === 'RESERVED') ||
      operations.some((operation) => operation.status === 'INTENT');
    const rootPaused = root?.status === 'WAITING' && root.waitReason === 'paused';
    return {
      text: `${active ? '部分代理等待回答' : '等待你的回答'}${rootPaused ? '；总代理已暂停' : ''}`,
      displayStatus: active ? undefined : 'WAITING',
      action: currentQuestions(detail).length ? 'questions' : 'reply',
      control: active ? control : undefined,
      resumeTaskId: rootPaused ? root.id : undefined,
    };
  }
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
        return { text: rateText, control };
      case 'children':
        return { text: '等待子任务交付，随后集成与验收' };
    }
  }
  return {
    text:
      rateTasks.length && ['READY', 'RUNNING'].includes(run.status)
        ? rateText
        : root?.status === 'WAITING' && root.waitReason === 'children'
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
