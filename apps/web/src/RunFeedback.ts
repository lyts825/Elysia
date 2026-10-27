/* 处理运行反馈的数据和状态。 */
import type { Event, Operation, RequestRecord, Run, Task } from '../../../packages/contracts/src/index';
import type { CurrentQuestion, RunCurrentQuestions } from '../../../packages/contracts/src/run-reads';
import { detailReadReason, type DetailReadState } from './DetailReadState';

type FeedbackDetail = DetailReadState & {
  run: Run;
  tasks: Task[];
  operations: Operation[];
  requests?: RequestRecord[];
  events: Event[];
  currentQuestions?: RunCurrentQuestions;
  edges?: { taskId: string; dependencyId: string }[];
};
export type RunFeedback = {
  text: string;
  displayStatus?: 'WAITING';
  action?: 'artifacts' | 'plan' | 'reply' | 'questions' | 'archive' | 'limits' | 'settings' | 'new' | 'tasks';
  control?: 'pause' | 'resume' | 'retry';
  resumeTaskId?: string;
  blockedTaskId?: string;
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

type QuestionDetail = Pick<FeedbackDetail, 'tasks' | 'events' | 'currentQuestions'> & { run?: Run };
const questionsInactive = (detail: Pick<QuestionDetail, 'run'>) =>
  !!detail.run &&
  (['DONE', 'CANCELLED'].includes(detail.run.status) || detail.run.execution?.kind === 'docker-agent');

/** 仅为活动原生运行返回问题覆盖不足文案；空字符串表示没有需要额外展示的读取提示。 */
export function currentQuestionsReadNotice(detail: Pick<QuestionDetail, 'run' | 'currentQuestions'>) {
  // 仅活动运行显示覆盖不足提示；截断与读取故障使用不同文案。
  if (questionsInactive(detail) || detail.currentQuestions?.coverage.complete !== false) return '';
  return detail.currentQuestions.coverage.limited
    ? '部分待答问题超出单次核对范围，暂无法完整确认；已有输入和任务状态保持。'
    : '部分待答问题记录暂时无法读取，可重试读取；已有输入和任务状态保持。';
}

/**
 * 新服务端以当前问题投影为准，包括显式空列表；只保留实际仍 WAITING/user 的任务。
 * 旧服务端兼容路径反向查看事件，遇到离开等待状态的事件即停止，避免复活已回答的问题。
 */
export function currentQuestions(detail: QuestionDetail): CurrentQuestion[] {
  // 新服务端的当前问题投影优先；旧服务端才从最近事件向前查找。
  if (questionsInactive(detail)) return [];
  const waiting = detail.tasks.filter(
    (item) =>
      item.status === 'WAITING' &&
      item.waitReason === 'user' &&
      (!detail.run || item.runId === detail.run.id),
  );
  // An explicit empty projection closes older questions. Only older servers
  // without this field use the recent-event compatibility path.
  if (detail.currentQuestions !== undefined) {
    const taskIds = new Set(waiting.map((task) => task.id));
    return [...detail.currentQuestions.items]
      .filter((question) => taskIds.has(question.taskId))
      .sort((a, b) => a.seq - b.seq);
  }
  const questions: CurrentQuestion[] = [];
  for (const task of waiting) {
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

/** 解析可信的正数恢复时间；明确出现新版 rateLimit 字段时不回退 result 中的旧值。 */
export function rateResumeAt(task: Task): number | null {
  // 兼容旧任务的 result.resumeAt，同时优先使用明确的速率限制记录。
  const value =
    task.rateLimit === undefined
      ? (task.result as { resumeAt?: unknown } | null)?.resumeAt
      : task.rateLimit?.resumeAt;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 把限流来源、恢复时间、自动执行资格及依赖状态组合为展示文本。
 * now 由外层计时器传入；本函数只计算提示，不负责计时或安排真正重试。
 */
export function rateWaitText(
  task: Task,
  automatic: boolean,
  now = Date.now(),
  dependenciesReady = true,
): string {
  // 暂停或依赖未就绪时不承诺自动重试；倒计时只用于展示。
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

/**
 * 将运行、任务、请求和操作记录归纳为一个优先级明确的状态提示与可用动作。
 * 读取不完整、归档和终态先处理；副作用核验、预算、依赖和用户问题再决定动作。
 * control/action 是界面建议，实际恢复或重试仍必须由服务端核验，不能据此绕过预算。
 */
export function getRunFeedback(detail: FeedbackDetail, archived: boolean, now = Date.now()): RunFeedback {
  // 详情不完整和归档状态优先，其余状态再决定可展示的操作与原因。
  if (detailReadReason(detail))
    return { text: '部分执行记录无法读取；请查看读取提示并重试，运行状态保持原记录' };
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
  if (
    run.reason === 'peer_review_limit' ||
    tasks.some((task) => task.status === 'WAITING' && task.waitReason === 'peer_review_limit')
  )
    return { text: '评审轮次已用完，查看意见并新建任务继续；恢复不会重置轮次', action: 'tasks' };
  if (detail.localExecutionStopped) {
    if (
      detail.requests?.some((record) => record.status === 'UNKNOWN') ||
      operations.some((record) => record.status === 'UNCERTAIN')
    )
      return { text: '本机调度已停止；请先核验未确定的请求或操作，再恢复执行', action: 'artifacts' };
    if (run.reason === 'plan') return { text: '本机调度已停止；请先核对待接受的计划', action: 'plan' };
    const blocked = tasks.find((task) =>
      ['dependency_failed', 'no_progress'].includes(task.waitReason || ''),
    );
    if (blocked)
      return {
        text: '本机调度已停止；请先处理阻塞分支，再明确恢复',
        action: 'tasks',
        blockedTaskId: blocked.id,
      };
    return { text: '本机调度已停止，记录已可读取；明确恢复后才继续，累计预算保持', control: 'resume' };
  }

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
      // 仅关联当前这次 limit 等待期间的限制事件，不能把上次已解除的错误套到现状态。
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
    // 聊天单轮计时可重开；累计步骤/请求等硬上限不会因点击恢复而重置。
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
    // 只有依赖已经完成的限流任务才有资格形成最近自动重试提示。
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
  const blocked = tasks.filter(
    (task) =>
      task.status === 'WAITING' && ['dependency_failed', 'no_progress'].includes(task.waitReason || ''),
  );
  const control = ['READY', 'RUNNING'].includes(run.status)
    ? 'pause'
    : blocked.length
      ? undefined
      : run.status === 'FAILED'
        ? 'retry'
        : run.status === 'WAITING' &&
            ['paused', 'interrupted', 'rate_limit', 'subscription_limit', 'terminal_unavailable'].includes(
              run.reason || '',
            )
          ? run.reason === 'rate_limit' && rootTimed
            ? 'pause'
            : 'resume'
          : undefined;
  // 已发生但结果未知的副作用优先要求用户核验，不能被普通暂停或失败文案掩盖。
  if (uncertain)
    return {
      text: `${run.reason === 'paused' ? '已暂停；' : ''}${uncertain} 项副作用待核验，请检查本机证据`,
      action: 'artifacts',
      control,
    };
  if (blocked.length) {
    const stalled = blocked.find((task) => task.waitReason === 'no_progress');
    const dependency = blocked.find((task) => task.waitReason === 'dependency_failed');
    const active = tasks.some((task) => ['READY', 'RUNNING', 'VERIFYING'].includes(task.status));
    return {
      text: stalled
        ? `相同工具错误重复发生，${stalled.spec.title} 已暂停；请检查后局部继续${active ? '，其他分支仍在推进' : ''}`
        : dependency?.dependencyBlock?.causes.length
          ? `依赖分支失败或已取消，请定位来源后恢复${active ? '；其他分支仍在推进' : ''}`
          : '依赖恢复中，等待完成；无需恢复父任务',
      displayStatus: active ? undefined : 'WAITING',
      action: 'tasks',
      blockedTaskId: stalled?.id || dependency?.id,
      control: active && ['READY', 'RUNNING'].includes(run.status) ? 'pause' : undefined,
    };
  }
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
  // 仅在没有更高优先级阻塞时突出待答问题；其他代理仍活动时不把整个运行误显示为停住。
  if (run.kind === 'task' && userTasks.length && !priorityWait) {
    const active =
      tasks.some((task) => ['READY', 'RUNNING', 'VERIFYING'].includes(task.status)) ||
      detail.requests?.some((request) => request.status === 'RESERVED') ||
      operations.some((operation) => operation.status === 'INTENT');
    const rootPaused = root?.status === 'WAITING' && root.waitReason === 'paused';
    return {
      text: `${active ? '部分代理等待回答' : '等待你的回答'}${rootPaused ? '；总代理已暂停' : ''}`,
      displayStatus: active ? undefined : 'WAITING',
      action: currentQuestions(detail).length || currentQuestionsReadNotice(detail) ? 'questions' : 'reply',
      control: active ? control : undefined,
      resumeTaskId: rootPaused ? root.id : undefined,
    };
  }
  if (run.status === 'WAITING') {
    switch (run.reason) {
      case 'terminal_review':
        return { text: '终端已结束，请审阅日志和差异后验收', action: 'artifacts' };
      case 'terminal_unavailable':
        return { text: 'Docker、镜像或终端环境未就绪，修复后可继续', control };
      case 'terminal_verification':
        return { text: '终端执行已中断，请检查日志与文件后填写核验说明；不会自动重跑', action: 'artifacts' };
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

/** 区分终结记录、新任务入口与项目级归档限制，给出解除当前归档影响所需的操作。 */
export function archiveFeedback(run: Run, projectArchived: boolean): string {
  if (run.status === 'DONE' || run.status === 'CANCELLED')
    return `记录已归档。恢复后可查看记录；继续工作请新建${run.kind === 'chat' ? '独立对话' : '任务'}。`;
  return projectArchived ? '所属项目已归档，恢复项目后可继续。' : '对话已归档，恢复后可继续。';
}
