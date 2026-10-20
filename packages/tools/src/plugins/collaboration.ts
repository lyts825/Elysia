import { z } from 'zod';
import { TaskSpec, Evidence, invariant, type Task } from '../../../contracts/src/index.js';
import { defineTool, type ToolServices, type ToolInvocation, type ToolContribution } from '../tool-plugin.js';
import type { PluginContributions } from '../../../plugins/src/index.js';

const schemas = {
  clarify: z.object({ questions: z.array(z.string().min(1)).min(1).max(6) }),
  spawn_task: TaskSpec,
  allocate_context: z.object({
    taskId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    windowTokens: z.number().int().min(4096).max(1000000),
  }),
  join_tasks: z.object({ taskIds: z.array(z.string()).min(1).max(11) }),
  submit_result: z.object({
    summary: z.string().min(1),
    evidence: z.array(Evidence).min(1),
    incomplete: z.array(z.string()),
  }),
};
export function collaborationTools(
  context: Pick<ToolServices, 'store' | 'kernel' | 'submit'>,
): PluginContributions<ToolContribution> {
  function execute_clarify({ task }: ToolInvocation, args: z.output<typeof schemas.clarify>) {
    let result: unknown;

    result = context.kernel.wait(task, 'user');
    context.kernel.event(
      task.runId,
      'decision.required',
      { taskId: task.id, reason: 'user', questions: args.questions },
      task.id,
    );

    return result;
  }
  function execute_spawn_task({ task }: ToolInvocation, args: z.output<typeof schemas.spawn_task>) {
    return context.kernel.spawn(task, args);
  }
  function execute_allocate_context(
    { task }: ToolInvocation,
    args: z.output<typeof schemas.allocate_context>,
  ) {
    return context.kernel.allocateContext(task, args.taskId, args.expectedRevision, args.windowTokens);
  }
  function execute_join_tasks({ task }: ToolInvocation, args: z.output<typeof schemas.join_tasks>) {
    let result: unknown;

    const children = args.taskIds.map((key: string) => context.store.require<Task>('tasks', key));
    invariant(
      new Set(args.taskIds).size === args.taskIds.length &&
        children.every((t: Task) => t.runId === task.runId && t.parentTaskId === task.id),
      'TASK_SCOPE',
      '只能等待实际直属子任务，且不能重复指定',
    );
    result = children.every((t: Task) => ['DONE', 'FAILED', 'CANCELLED'].includes(t.status))
      ? children.map((t: Task) => ({ id: t.id, status: t.status, result: t.result }))
      : context.kernel.wait(task, 'children', args.taskIds);

    return result;
  }
  async function execute_submit_result(
    { task, signal }: ToolInvocation,
    args: z.output<typeof schemas.submit_result>,
  ) {
    return await context.submit(task, args, signal);
  }
  return {
    manifest: { id: 'tools.collaboration', version: '1.0.0', apiVersion: 1 },
    contributions: {
      clarify: defineTool(
        'clarify',
        schemas.clarify,
        '暂停当前任务并集中询问影响目标、授权或验收且无法从已有资料解决的关键问题。已授权步骤、实现方法、可逆修复和必要验证由你自行决定，不重复征求确认。',
        { transaction: true, serial: true, mutating: false, progress: false },
        execute_clarify,
      ),
      spawn_task: defineTool(
        'spawn_task',
        schemas.spawn_task,
        '在当前任务范围、权限和预算内创建必要子任务；key 在 run 内唯一，明确目标、交付及验收，不重复已有任务。返回的 taskId 才用于 join_tasks；reviewer 模型须符合当前合同。',
        { transaction: true, serial: true, mutating: false, progress: false },
        execute_spawn_task,
      ),
      allocate_context: defineTool(
        'allocate_context',
        schemas.allocate_context,
        '在直属子代理安全检查点为托管窗口分配大小。taskId和expectedRevision取当前children；窗口不得超过子模型上限，手动窗口只能由用户修改。',
        { transaction: true, serial: true, mutating: false, progress: false },
        execute_allocate_context,
      ),
      join_tasks: defineTool(
        'join_tasks',
        schemas.join_tasks,
        '等待 taskIds 指定的直属子任务并释放调用槽位，已结束则返回实际结果；ID 来自 children 或 spawn_task，不能使用 key，也不代表子任务一定成功。',
        { transaction: true, serial: true, mutating: false, progress: false },
        execute_join_tasks,
      ),
      submit_result: defineTool(
        'submit_result',
        schemas.submit_result,
        '提交本任务结果；每个验收项均需 evidence，criterion 从0开始。file 用可读路径及真实哈希；artifact 用本任务或已完成直属子任务的 ID；command 用本任务成功 exec 的 operationId。必需子任务须完成，incomplete 只有确无未完成项时才为空；普通摘要不能代替证据。',
        { transaction: false, serial: true, mutating: false, progress: false },
        execute_submit_result,
      ),
    },
  };
}
