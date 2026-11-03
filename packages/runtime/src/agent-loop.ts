/**
 * 执行原生代理的单步循环，协调上下文、模型和工具。
 * 单步串联未决调用恢复、上下文、模型及有序工具意图；调度、预算和权限由对应服务掌管，未知副作用不盲目重放。
 * EN: Runs one native-agent step by coordinating context, model requests, and tools. One step coordinates pending-call recovery, context, model and ordered tools; dedicated services own scheduling/budgets/permissions and unknown effects are never blindly replayed.
 */
import type { Store } from '../../storage/src/index.js';
import type { Kernel } from '../../kernel/src/index.js';
import {
  AppError,
  inspectToolCalls,
  type Message,
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
  /**
   * 注入内核、工具、请求、运行控制和上下文编译器；本实例仅编排单步，不自行拥有调度队列。
   * EN: Injects kernel, tools, request runner, run control, and context compiler; this instance orchestrates one step without owning a scheduling queue.
   */
  constructor(
    readonly kernel: Kernel<Store>,
    readonly gateway: ToolGateway,
    private readonly tools: ToolExecutionService,
    private readonly requests: ModelRequestRunner,
    private readonly control: RunControl,
    private readonly compiler: ContextCompiler,
  ) {}
  /**
   * 执行一次原生代理步骤：先恢复未配对的工具结果，再编译上下文并请求模型。 限流、任务状态变化或步骤上限会提前结束本步，后续由调度器重新判断。
   * EN: Executes one native-agent step: recover unpaired tool results, compile context, and request the model. Rate limits, changed task state, or step limits return control to the scheduler.
   */
  async step(task: Task, signal: AbortSignal) {
    if (this.kernel.store.require<Run>('runs', task.runId).limits.scheduling === 'async')
      return this.asyncStep(task, signal);
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
    /**
     * 先取得执行权并重放未完成的工具调用，再编译新的模型上下文。
     * EN: Claim execution and replay unfinished tool calls before compiling the next model context.
     */
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
    /**
     * 准备工具期间任务可能被停止或修改，因此继续前重新读取持久状态。
     * EN: Tool preparation can overlap a stop or edit, so reread persistent state before continuing.
     */
    task = store.require<Task>('tasks', task.id);
    if (task.status !== 'RUNNING') return;
    run = store.require<Run>('runs', task.runId);
    const agent = store.require<Agent>('agents', task.agentId);
    let context: CompiledContext;
    /**
     * 编译失败也可能携带可展示的窗口指标，先发布这些证据，再交调度器处理限额等待。
     * EN: A failed compilation may still contain useful window metrics; publish them before the scheduler handles the limit wait.
     */
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
    /**
     * undefined 表示已转入限流等等待，不能继续把它作为空的完成回复执行下一步。
     * EN: Undefined means that the request entered a wait such as rate limiting; it is not an empty completed response.
     */
    if (!response) return;
    const { message: assistantMessage, completed } = response;
    attempt = response.attempt;
    signal.throwIfAborted();
    if (completed.calls.length)
      await this.tools.executeCalls(task, attempt, completed.calls, signal, assistantMessage.id);
    else if (store.require<Run>('runs', task.runId).kind === 'chat') {
      /**
       * 聊天轮次没有工具调用时让出控制权，等待用户输入。
       * EN: A chat turn without tool calls yields control and waits for user input.
       */
      store.tx(() => {
        this.kernel.wait(store.require<Task>('tasks', task.id), 'user');
        store.put('attempts', {
          ...store.require<Attempt>('attempts', attempt.id),
          status: 'DONE',
          lease: null,
        });
      });
    } else {
      /**
       * 非聊天任务需要显式续行提示，才能继续推进未完成的目标。
       * EN: Non-chat tasks need an explicit continuation prompt to keep advancing unfinished goals.
       */
      this.kernel.appendMessage(
        task,
        'user',
        nativeContinuationNotice(store.require<Task>('tasks', task.id)),
        { purpose: 'runtime_notice' },
      );
    }
    task = store.require('tasks', task.id);
    /**
     * 单步结束归还 READY 使其他候选有机会执行；工具内部若已转为等待/完成则保持其状态。
     * EN: Return a still-running task to READY for fairness; preserve any wait or completion established by its tools.
     */
    if (task.status === 'RUNNING') {
      if (this.gateway.backgroundJobs.hasUnsettled(task.runId))
        this.kernel.wait(
          task,
          this.kernel.store.hasUncertainOperation(task.runId, task.id) ? 'verification' : 'background_job',
        );
      else this.kernel.updateTask(task, 'READY');
    }
    this.kernel.checkpoint(attempt.id);
  }
  /** 每次只持有一个阶段；模型完成与阶段游标同事务落库，工具结果沿既有幂等路径恢复。 */
  private async asyncStep(task: Task, signal: AbortSignal) {
    const store = this.kernel.store;
    const { attempt, lease } = store.tx(() => ({
      attempt: this.kernel.claim(task.id),
      lease: store.scheduling.claim(task.id),
    }));
    const live = () =>
      !signal.aborted &&
      store.scheduling.owns(lease) &&
      !store.getExecutionHold(task.runId) &&
      store.require<Task>('tasks', task.id).status === 'RUNNING' &&
      ['READY', 'RUNNING'].includes(store.require<Run>('runs', task.runId).status);
    try {
      if (!live()) return;
      if (lease.stage === 'finish') {
        store.tx(() => {
          if (!live()) return;
          this.kernel.flushRuntimeNotices(task);
          const message = lease.messageId ? store.require<Message>('messages', lease.messageId) : undefined;
          task = store.require<Task>('tasks', task.id);
          if (!message?.calls?.length) {
            if (store.require<Run>('runs', task.runId).kind === 'chat') {
              // 新消息可能已在模型提交与收尾之间应用；不能再次等待并吞掉该轮唤醒。
              const nextTurn =
                message &&
                this.kernel
                  .history(task)
                  .some(
                    (entry) =>
                      entry.ordinal > message.ordinal && entry.role === 'user' && entry.sourceInboxId,
                  );
              if (!nextTurn) this.kernel.wait(task, 'user');
              store.put('attempts', {
                ...store.require<Attempt>('attempts', attempt.id),
                status: 'DONE',
                lease: null,
              });
            } else
              this.kernel.appendMessage(task, 'user', nativeContinuationNotice(task), {
                purpose: 'runtime_notice',
              });
          }
          store.scheduling.advance(lease, 'model', null);
          this.finishStage(task.id, attempt.id);
        });
        return;
      }
      task = await this.gateway.prepare(store.require('tasks', task.id), signal);
      if (!live()) return;
      if (lease.stage === 'tools') {
        await this.tools.replayPending(task, attempt, signal, 1);
        store.tx(() => {
          if (!store.scheduling.owns(lease) || signal.aborted || store.getExecutionHold(task.runId)) return;
          const pending = inspectToolCalls(this.kernel.history(task));
          if (pending.error) throw new AppError(pending.error.code, pending.error.message);
          if (!pending.pending.length) store.scheduling.advance(lease, 'finish');
          this.finishStage(task.id, attempt.id);
        });
        return;
      }
      const run = store.require<Run>('runs', task.runId);
      if (attempt.steps >= run.limits.maxSteps) {
        this.control.waitAtLimit(task, 'STEP_LIMIT', '运行步骤达到上限');
        return;
      }
      const definitions = await this.gateway.prepareDefinitions(task, signal);
      if (!live()) return;
      this.kernel.flushRuntimeNotices(task);
      task = store.require<Task>('tasks', task.id);
      const agent = store.require<Agent>('agents', task.agentId);
      let context: CompiledContext;
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
      const metrics = this.requests.publishContext(
        task,
        attempt,
        ContextRuntimeMetrics.parse(context.manifest.contextWindow),
      );
      const response = await this.requests.run(task, attempt, agent, context, metrics, signal, lease);
      if (response && live()) store.tx(() => this.finishStage(task.id, attempt.id));
    } finally {
      store.scheduling.release(lease);
    }
  }
  private finishStage(taskId: string, attemptId: string) {
    const store = this.kernel.store;
    const task = store.require<Task>('tasks', taskId);
    if (task.status === 'RUNNING') {
      if (store.scheduling.stage(task.id) !== 'tools' && this.gateway.backgroundJobs.hasUnsettled(task.runId))
        this.kernel.wait(
          task,
          store.hasUncertainOperation(task.runId, task.id) ? 'verification' : 'background_job',
        );
      else this.kernel.updateTask(task, 'READY', { waitReason: undefined });
    }
    this.kernel.checkpoint(attemptId);
  }
}
