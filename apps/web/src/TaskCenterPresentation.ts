/**
 * 生成任务中心分类和条目的显示信息。
 *
 * EN: Builds display labels and actions for task-center categories and items.
 *
 * 本模块把任务中心列表投影转换为分类标签、状态、提示和动作文案；它保留读取异常和待核验状态的区别，不能替代打开任务时的详情复核。
 * EN: Maps task-center list projections to category labels, statuses, hints, and actions. It preserves distinctions between read failures and verification needs; opening a task still requires a fresh detail check.
 */
import type { TaskCenterCategory, TaskCenterItem } from '../../../packages/contracts/src/task-center';

export const taskCenterCategoryLabels: Record<TaskCenterCategory, string> = {
  running: '执行中',
  waiting: '待回应',
  verification: '待核验',
  done: '已结束',
  failed: '失败',
  paused: '暂停',
  unavailable: '无法读取',
};

const reasons: Record<string, { action: string; hint: string }> = {
  user: { action: '回答', hint: '等待你的回答。' },
  plan: { action: '确认计划', hint: '请核对分工、型号与验收项。' },
  limit: { action: '查看限制', hint: '已达到运行限制，请核对预算与用量。' },
  peer_review_limit: { action: '查看评审', hint: '评审轮次已用完，查看意见并新建任务继续。' },
  subscription_limit: { action: '查看设置', hint: '订阅额度受限，请核对用量。' },
  no_progress: { action: '查看分支', hint: '工具错误重复发生，请检查后继续此分支。' },
  dependency_failed: { action: '查看分支', hint: '依赖分支受阻，请先处理来源。' },
  terminal_review: { action: '验收', hint: '终端已结束，请审阅日志与差异。' },
  verification: { action: '核验', hint: '请求或操作结果未确定，请核对记录。' },
  terminal_verification: { action: '核验', hint: '终端已中断，请核对日志与文件。' },
  paused: { action: '查看', hint: '执行已暂停，检查记录后可恢复。' },
  interrupted: { action: '查看', hint: '执行已中断，请检查记录后恢复。' },
  rate_limit: { action: '查看', hint: '服务或账号受限，请查看重试状态。' },
  terminal_unavailable: { action: '查看', hint: '终端环境未就绪，请检查后恢复。' },
};

/**
 * 把列表快照转换为状态标签、动作和提示，区分执行结束与用户复核。
 * 持久暂停优先显示停止调度原因，读取异常不伪造执行状态；真正打开后仍须重新读取详情决定目标。
 *
 * EN: Maps a row snapshot to labels/actions while separating execution end from human review. Durable holds take precedence, and read errors never fabricate execution state; opening still rereads detail.
 */
export function taskCenterPresentation(item: TaskCenterItem): {
  status: string;
  action: string;
  hint?: string;
  target: TaskCenterCategory | 'review';
  review: boolean;
} {
  /**
   * 读取异常与可复核状态优先显示；其余根据分类和等待原因生成动作提示。
   *
   * EN: Read errors and reviewable state take display priority; otherwise category and wait reason determine guidance.
   */
  const status = item.readIssue
    ? taskCenterCategoryLabels.unavailable
    : item.status === 'CANCELLED'
      ? '已取消'
      : item.category === 'paused' && item.executionHold
        ? '已停止调度'
        : taskCenterCategoryLabels[item.category];
  const review =
    !item.readIssue &&
    item.kind === 'task' &&
    item.status === 'DONE' &&
    item.category === 'done' &&
    !!(item.reviewStatus || item.reviewIssue);
  if (item.readIssue)
    return {
      status,
      action: '详情',
      target: 'unavailable',
      review: false,
      ...(item.executionHold ? { hint: '本机调度已停止，请先重试读取记录。' } : {}),
    };
  if (review) return { status, action: item.reviewIssue ? '检查' : '复核', target: 'review', review };
  if (item.category === 'done') return { status, action: '查看', target: item.category, review };

  const reason = reasons[item.reason || ''];
  const action =
    item.category === 'verification' && item.reason !== 'terminal_review'
      ? '核验'
      : item.category === 'paused' &&
          item.executionHold &&
          !['plan', 'no_progress', 'dependency_failed'].includes(item.reason || '')
        ? '查看'
        : reason?.action || '查看';
  const hint =
    item.category === 'verification' &&
    !['terminal_review', 'terminal_verification'].includes(item.reason || '')
      ? reasons.verification.hint
      : reason?.hint ||
        (item.category === 'failed'
          ? '执行失败，请查看错误并处理。'
          : item.category === 'waiting'
            ? '请查看当前等待原因与下一步。'
            : undefined);
  return {
    status,
    action,
    target: item.category,
    review,
    hint: item.executionHold
      ? item.executionHold.reason === 'recovery_unreadable'
        ? '本机调度已停止，请先重试读取记录。'
        : `本机调度已停止；${hint || '检查记录后可明确恢复。'}`
      : hint,
  };
}
