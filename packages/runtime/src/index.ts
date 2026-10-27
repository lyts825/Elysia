/** 组装原生执行器及其运行时依赖。 */
import { ToolCallReviewer } from './tool-review.js';
import type { Store } from '../../storage/src/index.js';
import {
  AppError,
  type Agent,
  type Task,
  type Run,
  type Attempt,
  type ToolCall,
} from '../../contracts/src/index.js';
import type { ProviderAdapter } from '../../contracts/src/model.js';
import type { ReasoningDelta } from '../../contracts/src/reasoning.js';
import type { Kernel } from '../../kernel/src/index.js';
import { ToolGateway } from '../../tools/src/index.js';
import { compileContext } from '../../context/src/index.js';
import { ProviderRegistry, nativeProviderPlugins } from '../../providers/src/index.js';
import { ExecutionPlugins, type ExecutionPlugin } from './execution-plugins.js';
import { ExecutionScheduler } from './scheduler.js';
import { NativeAgentLoop, type ContextCompiler } from './agent-loop.js';
import { ModelRequestRunner } from './model-request.js';
import { ToolExecutionService } from './tool-execution.js';

export interface ExecutorAdapter {
  capabilities: { recursive: boolean; recoverable: boolean };
  start(): void;
  interrupt(runId: string, taskId?: string): Promise<void>;
  resume(runId: string): void;
  dispose(): Promise<void>;
}
export interface NativeExecutorOptions {
  /** 可注入同一内核拥有的工具网关；默认网关装配独立工具审核服务。 */
  gateway?: ToolGateway;
  /** 每次按 Agent 冻结绑定构造适配器，便于不同执行子任务保持模型隔离。 */
  adapterFactory?: (agent: Agent) => ProviderAdapter;
  /** 编译器只负责当前任务上下文，调用顺序和持久化由代理循环控制。 */
  compiler?: ContextCompiler;
  /** 宿主入口归属谓词；直接 step 和调度器派发都使用同一判断。 */
  acceptRun?: (run: Run) => boolean;
  executionPlugins?: (gateway: ToolGateway) => readonly ExecutionPlugin[];
}
/** Compatibility facade. Scheduling, requests, tools and the loop have independent owners. */
/** 装配调度、代理循环、工具网关和执行通道，并公开运行控制入口。 */
export class NativeExecutor implements ExecutorAdapter {
  readonly capabilities = { recursive: true, recoverable: true };
  readonly gateway: ToolGateway;
  readonly executionPlugins: ExecutionPlugins;
  readonly scheduler: ExecutionScheduler;
  readonly tools: ToolExecutionService;
  readonly requests: ModelRequestRunner;
  readonly loop: NativeAgentLoop;
  onDelta: (runId: string, taskId: string, text: string, requestId: string, offset: number) => void =
    () => {};
  onReasoningDelta: (value: ReasoningDelta) => void = () => {};
  adapterFactory: (agent: Agent) => ProviderAdapter;
  acceptRun: (run: Run) => boolean;
  constructor(
    readonly kernel: Kernel<Store>,
    options: NativeExecutorOptions = {},
  ) {
    const providers = options.adapterFactory ? undefined : new ProviderRegistry(nativeProviderPlugins());
    this.adapterFactory = options.adapterFactory ?? ((agent) => providers!.adapter(agent.providerBinding));
    const reviewer = new ToolCallReviewer(kernel, (agent) => this.adapterFactory(agent));
    this.gateway =
      options.gateway ?? new ToolGateway(kernel, { reviewModel: reviewer.review.bind(reviewer) });
    this.acceptRun = options.acceptRun ?? (() => true);
    this.executionPlugins = new ExecutionPlugins([
      {
        manifest: { id: 'execution.native', version: '1.0.0', apiVersion: 1 },
        contributions: { native: { step: (task, signal) => this.loop.step(task, signal) } },
      },
      ...(options.executionPlugins?.(this.gateway) ?? []),
    ]);
    this.scheduler = new ExecutionScheduler(kernel, this.executionPlugins, {
      acceptRun: (run) => this.acceptRun(run),
      step: (task, signal) => this.step(task, signal),
      cancelProcesses: (taskIds) => this.gateway.cancelCommands(taskIds),
      disposeTools: () => this.gateway.dispose(),
    });
    this.tools = new ToolExecutionService(kernel, this.gateway);
    this.requests = new ModelRequestRunner(kernel, this.scheduler, {
      adapterFactory: (agent) => this.adapterFactory(agent),
      onDelta: (...args) => this.onDelta(...args),
      onReasoningDelta: (value) => this.onReasoningDelta(value),
    });
    this.loop = new NativeAgentLoop(
      kernel,
      this.gateway,
      this.tools,
      this.requests,
      this.scheduler,
      options.compiler ?? ((task, definitions) => compileContext(kernel.store, task, definitions)),
    );
  }
  get active() {
    return this.scheduler.active;
  }
  start() {
    this.scheduler.start();
  }
  resume(runId: string) {
    this.scheduler.resume(runId);
  }
  tick() {
    return this.scheduler.tick();
  }
  runtimeSnapshot(runId?: string) {
    return this.scheduler.runtimeSnapshot(runId);
  }
  isLocallyStopped(runId: string) {
    return this.scheduler.isLocallyStopped(runId);
  }
  releaseLocalStop(runId: string) {
    return this.scheduler.releaseLocalStop(runId);
  }
  stopCurrent(runId: string) {
    return this.scheduler.stopCurrent(runId);
  }
  interrupt(runId: string, taskId?: string) {
    return this.scheduler.interrupt(runId, taskId);
  }
  dispose() {
    return this.scheduler.dispose();
  }
  fail(task: Task, error: unknown) {
    return this.scheduler.fail(task, error);
  }
  tool(task: Task, attempt: Attempt, call: ToolCall, signal: AbortSignal, assistantMessageId?: string) {
    return this.tools.tool(task, attempt, call, signal, assistantMessageId);
  }
  executeCalls(
    task: Task,
    attempt: Attempt,
    calls: ToolCall[],
    signal: AbortSignal,
    assistantMessageId?: string,
  ) {
    return this.tools.executeCalls(task, attempt, calls, signal, assistantMessageId);
  }
  replayPending(task: Task, attempt: Attempt, signal: AbortSignal) {
    return this.tools.replayPending(task, attempt, signal);
  }
  /** 统一直接调用与调度路径的入口归属检查，拒绝发生在通道执行和内核 claim 之前。 */
  async step(task: Task, signal: AbortSignal) {
    if (this.scheduler.isClosing) throw new AppError('EXECUTOR_DISPOSED', '执行器已释放');
    signal.throwIfAborted();
    const run = this.kernel.store.require<Run>('runs', task.runId);
    if (!this.acceptRun(run)) throw new AppError('SURFACE_EXECUTION', '当前入口不执行此类型任务');
    return this.executionPlugins.forRun(run).step(task, signal);
  }
}
