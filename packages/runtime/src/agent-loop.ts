/** 执行原生代理的单步循环，协调上下文、模型和工具。 */
import type { Store } from '../../storage/src/index.js';
import type { Kernel } from '../../kernel/src/index.js';
import {
  AppError,
  ContextRuntimeMetrics,
  type Agent,
  type Task,
  type Run,
  type Attempt,
  type Project,
} from '../../contracts/src/index.js';
import type { CompiledContext, ToolDefinition } from '../../contracts/src/model.js';
import { nativeContinuationNotice } from '../../context/src/harness.js';
import type { ToolGateway } from '../../tools/src/index.js';
import type { ToolExecutionService } from './tool-execution.js';
import type { ModelRequestRunner } from './model-request.js';
import type { RunControl } from './scheduler.js';

export type ContextCompiler = (task: Task, definitions: ToolDefinition[]) => CompiledContext;
export class NativeAgentLoop {
  constructor(
    readonly kernel: Kernel<Store>,
    readonly gateway: ToolGateway,
    private readonly tools: ToolExecutionService,
    private readonly requests: ModelRequestRunner,
    private readonly control: RunControl,
    private readonly compiler: ContextCompiler,
  ) {}
  /**
   * 执行一次原生代理步骤：先恢复未配对的工具结果，再编译上下文并请求模型。
   * 限流、任务状态变化或步骤上限会提前结束本步，后续由调度器重新判断。
   */
  async step(task: Task, signal: AbortSignal) {
    const cooldown = task.rateLimit;
    const store = this.kernel.store;
    const resumeAt = this.control.rateLimitResumeAt(task);
    const pendingRun = store.require<Run>('runs', task.runId);
    if (
      cooldown &&
      resumeAt !== undefined &&
      resumeAt > Date.now() &&
      task.status === 'READY' &&
      !pendingRun.archived &&
      ['READY', 'RUNNING'].includes(pendingRun.status) &&
      (!pendingRun.projectId || !store.require<Project>('projects', pendingRun.projectId).archived)
    ) {
      this.kernel.wait(task, 'rate_limit');
      return;
    }
    // 先取得执行权并重放未完成的工具调用，再编译新的模型上下文。
    let attempt = this.kernel.claim(task.id);
    task = await this.gateway.prepare(store.require('tasks', task.id), signal);
    await this.tools.replayPending(task, attempt, signal);
    task = store.require('tasks', task.id);
    if (task.status !== 'RUNNING') return;
    let run = store.require<Run>('runs', task.runId);
    if (attempt.steps >= run.limits.maxSteps) {
      this.control.waitAtLimit(task, 'STEP_LIMIT', '运行步骤达到上限');
      return;
    }
    const definitions = await this.gateway.prepareDefinitions(task, signal);
    // 准备工具期间任务可能被停止或修改，因此继续前重新读取持久状态。
    task = store.require<Task>('tasks', task.id);
    if (task.status !== 'RUNNING') return;
    run = store.require<Run>('runs', task.runId);
    const agent = store.require<Agent>('agents', task.agentId);
    let context: CompiledContext;
    // 编译失败也可能携带可展示的窗口指标，先发布这些证据，再交调度器处理限额等待。
    try {
      context = this.compiler(task, definitions);
    } catch (error) {
      const metrics =
        error instanceof AppError
          ? ContextRuntimeMetrics.safeParse(
              (error.details as { contextMetrics?: unknown } | undefined)?.contextMetrics,
            )
          : null;
      if (metrics?.success) this.requests.publishContext(task, attempt, metrics.data);
      throw error;
    }
    let metrics = this.requests.publishContext(
      task,
      attempt,
      ContextRuntimeMetrics.parse(context.manifest.contextWindow),
    );
    const response = await this.requests.run(task, attempt, agent, context, metrics, signal);
    // undefined 表示已转入限流等等待，不能继续把它作为空的完成回复执行下一步。
    if (!response) return;
    const { message: assistantMessage, completed } = response;
    attempt = response.attempt;
    signal.throwIfAborted();
    if (completed.calls.length)
      await this.tools.executeCalls(task, attempt, completed.calls, signal, assistantMessage.id);
    else if (store.require<Run>('runs', task.runId).kind === 'chat') {
      // 聊天轮次没有工具调用时让出控制权，等待用户输入。
      store.tx(() => {
        this.kernel.wait(store.require<Task>('tasks', task.id), 'user');
        store.put('attempts', {
          ...store.require<Attempt>('attempts', attempt.id),
          status: 'DONE',
          lease: null,
        });
      });
    } else {
      // 非聊天任务需要显式续行提示，才能继续推进未完成的目标。
      this.kernel.appendMessage(
        task,
        'user',
        nativeContinuationNotice(store.require<Task>('tasks', task.id)),
        { purpose: 'runtime_notice' },
      );
    }
    task = store.require('tasks', task.id);
    // 单步结束归还 READY 使其他候选有机会执行；工具内部若已转为等待/完成则保持其状态。
    if (task.status === 'RUNNING') this.kernel.updateTask(task, 'READY');
    this.kernel.checkpoint(attempt.id);
  }
}
