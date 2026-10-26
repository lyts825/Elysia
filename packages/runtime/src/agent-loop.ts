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
    task = store.require<Task>('tasks', task.id);
    if (task.status !== 'RUNNING') return;
    run = store.require<Run>('runs', task.runId);
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
    let metrics = this.requests.publishContext(
      task,
      attempt,
      ContextRuntimeMetrics.parse(context.manifest.contextWindow),
    );
    const response = await this.requests.run(task, attempt, agent, context, metrics, signal);
    if (!response) return;
    const { message: assistantMessage, completed } = response;
    attempt = response.attempt;
    signal.throwIfAborted();
    if (completed.calls.length)
      await this.tools.executeCalls(task, attempt, completed.calls, signal, assistantMessage.id);
    else if (store.require<Run>('runs', task.runId).kind === 'chat') {
      store.tx(() => {
        this.kernel.wait(store.require<Task>('tasks', task.id), 'user');
        store.put('attempts', {
          ...store.require<Attempt>('attempts', attempt.id),
          status: 'DONE',
          lease: null,
        });
      });
    } else {
      this.kernel.appendMessage(
        task,
        'user',
        nativeContinuationNotice(store.require<Task>('tasks', task.id)),
        { purpose: 'runtime_notice' },
      );
    }
    task = store.require('tasks', task.id);
    if (task.status === 'RUNNING') this.kernel.updateTask(task, 'READY');
    this.kernel.checkpoint(attempt.id);
  }
}
