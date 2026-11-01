/**
 * 组装原生执行器及其运行时依赖。
 * 把调度、请求、工具、循环和外部通道连接到同一内核，宿主可注入适配器并接收增量；门面不直接持有账号保险库能力。
 * EN: Composes the native executor and its runtime dependencies. Connects scheduler/requests/tools/loop/external channels to one kernel with host adapters/deltas; the facade holds no account-vault capability.
 */
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
  /**
   * 可注入同一内核拥有的工具网关；默认网关装配独立工具审核服务。
   * EN: Allows injection of a tool gateway owned by the same kernel; the default gateway wires an independent tool-review service.
   */
  gateway?: ToolGateway;
  /**
   * 每次按 Agent 冻结绑定构造适配器，便于不同执行子任务保持模型隔离。
   * EN: Creates an adapter from each agent's frozen binding, keeping model selection isolated between execution tasks.
   */
  adapterFactory?: (agent: Agent) => ProviderAdapter;
  /**
   * 编译器只负责当前任务上下文，调用顺序和持久化由代理循环控制。
   * EN: The compiler only builds the current task context; the agent loop controls invocation order and persistence.
   */
  compiler?: ContextCompiler;
  /**
   * 宿主入口归属谓词；直接 step 和调度器派发都使用同一判断。
   * EN: Defines host-surface ownership; direct steps and scheduler dispatch use the same predicate.
   */
  acceptRun?: (run: Run) => boolean;
  executionPlugins?: (gateway: ToolGateway) => readonly ExecutionPlugin[];
}
/**
 * 装配调度、代理循环、工具网关和执行通道，并公开运行控制入口。
 * EN: Composes scheduling, agent loops, tool gateways, and execution channels and exposes run-control entry points.
 */
export class NativeExecutor implements ExecutorAdapter {
  readonly capabilities = { recursive: true, recoverable: true };
  readonly gateway: ToolGateway;
  readonly executionPlugins: ExecutionPlugins;
  readonly scheduler: ExecutionScheduler;
  readonly tools: ToolExecutionService;
  readonly requests: ModelRequestRunner;
  readonly loop: NativeAgentLoop;
  /**
   * 可由宿主替换的公开文本增量回调；默认不消费事件，持久内容仍由请求服务保存。
   * EN: Host-replaceable public text-delta callback; default ignores events while request services persist authoritative content.
   */
  onDelta: (runId: string, taskId: string, text: string, requestId: string, offset: number) => void =
    () => {};
  /**
   * 可由宿主替换的推理显示增量回调；默认空实现不改变请求或推理存储。
   * EN: Host-replaceable reasoning-display callback whose default no-op does not alter request/reasoning persistence.
   */
  onReasoningDelta: (value: ReasoningDelta) => void = () => {};
  adapterFactory: (agent: Agent) => ProviderAdapter;
  acceptRun: (run: Run) => boolean;
  /**
   * 按依赖接口装配供应商、网关、调度器、请求和单步循环，冻结插件注册；外部回调通过门面转发。
   * EN: Composes providers, gateway, scheduler, request runner, and step loop through their interfaces, fixes plugin registration, and forwards external callbacks through the facade.
   */
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
        contributions: {
          native: {
            /**
             * 原生通道贡献只委托代理循环单步，不在插件中自行领取任务或调度其他运行。
             * EN: The native channel contribution delegates one agent-loop step without independently claiming tasks or scheduling other runs.
             */
            step: (task, signal) => this.loop.step(task, signal),
          },
        },
      },
      ...(options.executionPlugins?.(this.gateway) ?? []),
    ]);
    this.scheduler = new ExecutionScheduler(kernel, this.executionPlugins, {
      /**
       * 把调度归属检查转发到门面当前谓词，统一直接执行和调度路径。
       * EN: Forwards scheduler ownership checks to the facade predicate, keeping direct and scheduled paths consistent.
       */
      acceptRun: (run) => this.acceptRun(run),
      /**
       * 调度器步骤经门面入口再核对归属，不能直接绕过宿主执行检查。
       * EN: Routes scheduled steps through the facade to recheck ownership instead of bypassing host execution checks.
       */
      step: (task, signal) => this.step(task, signal),
      /**
       * 把调度取消范围交给工具网关，由网关同时处理本机进程与配置命令后端。
       * EN: Delegates cancellation scope to the gateway, which handles both local processes and the configured command backend.
       */
      cancelProcesses: (taskIds) => this.gateway.cancelCommands(taskIds),
      /**
       * 调度器释放阶段关闭共享网关，确保MCP、计划模块和命令资源统一收束。
       * EN: Closes the shared gateway during scheduler disposal, draining MCP, plan-module, and command resources together.
       */
      disposeTools: () => this.gateway.dispose(),
      backgroundWork: () => this.gateway.backgroundJobs.occupancy(),
      maintainBackgroundWork: () => this.gateway.backgroundJobs.pump(),
    });
    this.gateway.backgroundJobs.configure({
      isTaskActive: (taskId) => this.scheduler.active.has(taskId),
      wake: (runId) => this.scheduler.resume(runId),
      modelWork: () =>
        [...this.scheduler.active].map(([taskId, entry]) => ({
          taskId,
          runId: entry.runId,
          account: entry.account,
        })),
    });
    this.tools = new ToolExecutionService(kernel, this.gateway);
    this.requests = new ModelRequestRunner(kernel, this.scheduler, {
      /**
       * 请求执行时按代理冻结绑定创建适配器，而不是复用其他代理的当前模型选择。
       * EN: Creates adapters at request time from each agent's frozen binding rather than reusing another agent's current model choice.
       */
      adapterFactory: (agent) => this.adapterFactory(agent),
      /**
       * 将已持久化的正文片段转发给宿主监听器，保留运行、任务、请求和偏移身份。
       * EN: Forwards persisted text deltas to the host listener with run, task, request, and offset identity intact.
       */
      onDelta: (...args) => this.onDelta(...args),
      /**
       * 转发公开推理展示增量，不把可选显示缓存变成模型执行的依赖。
       * EN: Forwards public reasoning-display deltas without making optional display caching a model-execution dependency.
       */
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
  /**
   * 暴露调度器当前进程内的活动任务视图，区别于数据库中可能已陈旧的RUNNING状态。
   * EN: Exposes the scheduler's in-process active-task view, distinct from possibly stale persistent RUNNING state.
   */
  get active() {
    return this.scheduler.active;
  }
  /** 管理边界使用真实在途模型/后台命令事实；未知且未确认停止的作业同样阻止破坏性管理。 */
  hasActiveWork(runId: string, taskId?: string) {
    return (
      [...this.active].some(([key, entry]) => entry.runId === runId && (!taskId || key === taskId)) ||
      this.gateway.backgroundJobs
        .occupancy()
        .some((entry) => entry.runId === runId && (!taskId || entry.taskId === taskId))
    );
  }
  /**
   * 启动调度计时器；幂等与关闭保护由调度器负责。
   * EN: Starts the scheduling timer; the scheduler owns idempotency and shutdown guards.
   */
  start() {
    this.scheduler.start();
  }
  /**
   * 请求对指定运行重新调度，不在此改变任务状态或重置预算。
   * EN: Requests scheduling for a run without changing task state or resetting budgets here.
   */
  resume(runId: string) {
    this.scheduler.resume(runId);
  }
  /**
   * 触发并返回一轮合并后的调度Promise，方便宿主等待本轮准备和派发收束。
   * EN: Triggers and returns a coalesced scheduling-round promise so the host can await preparation and dispatch settlement.
   */
  tick() {
    return this.scheduler.tick();
  }
  /**
   * 读取调度与活动任务快照，可限定运行；该只读视图不启动工作。
   * EN: Reads queue and active-task snapshots, optionally scoped to a run; the read-only view does not start work.
   */
  runtimeSnapshot(runId?: string) {
    return this.scheduler.runtimeSnapshot(runId);
  }
  /**
   * 查询宿主持久停止是否阻止该运行调度，不把普通WAITING等同为持久停止。
   * EN: Checks whether a durable local hold blocks scheduling, rather than treating ordinary WAITING state as a durable stop.
   */
  isLocallyStopped(runId: string) {
    return this.scheduler.isLocallyStopped(runId);
  }
  /**
   * 委托调度器解除显式停止；调用方须先完成授权及记录可读性检查。
   * EN: Delegates release of an explicit local hold; callers must first establish authorization and readable records.
   */
  releaseLocalStop(runId: string) {
    return this.scheduler.releaseLocalStop(runId);
  }
  /**
   * 请求持久停止当前运行并等待取消结果，失败时仍保留调度停止以待核验。
   * EN: Requests a durable stop and awaits cancellation results, retaining the scheduling hold when stopping needs verification.
   */
  stopCurrent(runId: string) {
    return this.scheduler.stopCurrent(runId);
  }
  /**
   * 中断运行或指定任务子树的活动工作，停止范围和聚合错误由调度器统一处理。
   * EN: Interrupts active work for a run or task subtree; the scheduler owns scope and error aggregation.
   */
  interrupt(runId: string, taskId?: string) {
    return this.scheduler.interrupt(runId, taskId);
  }
  /**
   * 进入统一关闭流程，等待准备、活动步骤和通道清理，不仅关闭计时器。
   * EN: Enters coordinated shutdown and waits for preparation, active steps, and channel cleanup, not merely timer removal.
   */
  dispose() {
    return this.scheduler.dispose();
  }
  /**
   * 把步骤错误交给调度器按限额、取消及业务失败语义持久处理。
   * EN: Delegates step errors to scheduler persistence according to quota, cancellation, and business-failure semantics.
   */
  fail(task: Task, error: unknown) {
    return this.scheduler.fail(task, error);
  }
  /**
   * 将单次工具调用及其持久助手消息身份转交工具服务，复用槽位、审核和恢复规则。
   * EN: Delegates one tool call and its durable assistant-message identity to the tool service, preserving slot, review, and recovery rules.
   */
  tool(task: Task, attempt: Attempt, call: ToolCall, signal: AbortSignal, assistantMessageId?: string) {
    return this.tools.tool(task, attempt, call, signal, assistantMessageId);
  }
  /**
   * 委托同轮工具批次执行并按模型顺序保存配对结果；并发资格由工具策略决定。
   * EN: Delegates a tool-call batch with results persisted in model order; tool policies determine concurrency eligibility.
   */
  executeCalls(
    task: Task,
    attempt: Attempt,
    calls: ToolCall[],
    signal: AbortSignal,
    assistantMessageId?: string,
  ) {
    return this.tools.executeCalls(task, attempt, calls, signal, assistantMessageId);
  }
  /**
   * 通过同一网关路径补齐历史未配对调用，终结操作重放结果而非重新产生副作用。
   * EN: Repairs unpaired historical calls through the same gateway path, replaying terminal outcomes rather than repeating side effects.
   */
  replayPending(task: Task, attempt: Attempt, signal: AbortSignal) {
    return this.tools.replayPending(task, attempt, signal);
  }
  /**
   * 统一直接调用与调度路径的入口归属检查，拒绝发生在通道执行和内核 claim 之前。
   * EN: Applies the same surface-ownership check to direct and scheduled execution, before a channel executes or the kernel claims the task.
   */
  async step(task: Task, signal: AbortSignal) {
    if (this.scheduler.isClosing) throw new AppError('EXECUTOR_DISPOSED', '执行器已释放');
    signal.throwIfAborted();
    const run = this.kernel.store.require<Run>('runs', task.runId);
    if (!this.acceptRun(run)) throw new AppError('SURFACE_EXECUTION', '当前入口不执行此类型任务');
    return this.executionPlugins.forRun(run).step(task, signal);
  }
}
