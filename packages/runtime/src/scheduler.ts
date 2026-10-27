/**
 * 调度运行任务并协调执行限制。
 * 按 hold、并发和准备状态领取任务并登记真实宿主工作；提交状态与停止进程分开，显式继续才解除本地停止，WAITING 不证明进程退出。
 * EN: Schedules run tasks and coordinates execution limits. Admits tasks by holds/concurrency/readiness and tracks real host work; state commits differ from process shutdown, explicit continuation clears stops and WAITING does not prove process exit.
 */
import type { Store } from '../../storage/src/index.js';
import type { Kernel } from '../../kernel/src/index.js';
import {
  AppError,
  type Agent,
  type Task,
  type Run,
  type Attempt,
  type RequestRecord,
  type Operation,
  type Project,
} from '../../contracts/src/index.js';
import { id, stable } from '../../contracts/src/identity.js';
import type {
  ExecutorRuntimeSnapshot,
  RuntimeQueueEntry,
  RuntimeQueueReason,
} from '../../contracts/src/terminal-runtime.js';
import type { RunStopCurrentResult } from '../../contracts/src/run-reads.js';
import { ExecutionPlugins, type ExecutionAdmission } from './execution-plugins.js';
import { ExecutionAdmissions } from './execution-admission.js';

export interface SchedulerServices {
  /**
   * 当前入口的运行归属检查，必须在驱动解析前生效。
   * EN: Checks whether the current surface owns the run before resolving a driver.
   */
  acceptRun(run: Run): boolean;
  /**
   * 执行一轮步骤；Promise 收束前该任务持续占用活动名额。
   * EN: Executes one step; the task occupies an active slot until its promise settles.
   */
  step(task: Task, signal: AbortSignal): Promise<void>;
  cancelProcesses(taskIds?: Set<string>): Promise<void>;
  disposeTools(): Promise<void>;
}
export interface RunControl {
  rateLimitResumeAt(task: Task): number | undefined;
  waitAtRateLimit(task: Task, rateLimit: NonNullable<Task['rateLimit']>): void;
  waitAtLimit(task: Task, code: string, message: string): void;
}
export class ExecutionScheduler implements RunControl {
  /**
   * active 是当前进程的在途执行事实，持久任务状态不能替代它判断是否还会产生副作用。
   * EN: active records actual in-flight work in this process; persistent task status alone cannot prove that side effects have stopped.
   */
  readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; account: string; runId: string }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private locallyStopped = new Set<string>();
  private stoppingRuns = new Map<string, number>();
  private ticking?: Promise<void>;
  private runtimeRevision = 0;
  private runtimeLast = '';
  private readonly dispatchOrder = new Map<string, number>();
  private dispatchSequence = 0;
  private capacityController = new AbortController();
  private readonly admissions = new ExecutionAdmissions();
  private closing?: Promise<void>;
  /**
   * 只读报告关闭Promise是否已建立，供直接步骤入口拒绝新的执行。
   * EN: Reports whether shutdown has begun so direct-step entry points can reject new execution.
   */
  get isClosing() {
    return !!this.closing;
  }
  /**
   * 绑定内核、固定通道和宿主回调，并设置统一准入协调器；资源和执行事实保持独立。
   * EN: Binds kernel, fixed channels, and host callbacks and establishes admission coordination while keeping resource ownership and execution facts separate.
   */
  constructor(
    readonly kernel: Kernel<Store>,
    readonly executionPlugins: ExecutionPlugins,
    private readonly services: SchedulerServices,
  ) {}
  /**
   * 启动定时调度；重复启动不创建第二个计时器。
   * EN: Starts periodic scheduling; repeated starts do not create another timer.
   */
  start() {
    if (this.closing) throw new AppError('EXECUTOR_DISPOSED', '执行器已释放');
    if (this.timer && !this.stopped) return;
    this.stopped = false;
    if (this.capacityController.signal.aborted) this.capacityController = new AbortController();
    this.timer = setInterval(() => void this.tick(), 300);
    void this.tick();
  }
  /**
   * 仅请求新一轮调度，不直接将指定运行改为 READY；状态变更由调用方先完成。
   * EN: Requests a new scheduling round without changing a run to READY; callers must commit state transitions first.
   */
  resume(_runId: string) {
    void this.tick();
  }
  /**
   * 同时检查进程内停止集合和持久暂停记录，使重启后停止意图仍有效。
   * EN: Checks both local stop state and durable holds so a stop remains effective after restart.
   */
  isLocallyStopped(runId: string) {
    return this.locallyStopped.has(runId) || !!this.kernel.store.getExecutionHold(runId);
  }
  /**
   * 只有显式授权且记录可读的启动或恢复才能解除此暂停。
   * EN: Only an explicitly authorized, readable start/resume may release this hold.
   */
  releaseLocalStop(runId: string) {
    if (this.stoppingRuns.has(runId))
      throw new AppError('STOP_IN_PROGRESS', '停止尚未完成，请稍后再显式恢复', true, null, 409);
    this.kernel.store.recovery.release(runId);
    this.locallyStopped.delete(runId);
  }
  /**
   * 先保存持久停止标记，再取消当前执行与相关进程。 interrupted 仅在所有停止动作成功时为真；部分失败仍保留调度暂停。
   * EN: Persists the durable stop before cancelling execution and related processes. interrupted is true only when every stop succeeds; partial failure still retains the scheduling hold.
   */
  async stopCurrent(runId: string): Promise<RunStopCurrentResult> {
    /**
     * 先持久化：写入失败不能确认已停止，也不能先中止现有工作。
     * EN: Persist first: a failed write must never acknowledge a durable stop or abort work.
     */
    this.kernel.store.recovery.hold(runId, 'user_stop');
    this.locallyStopped.add(runId);
    this.stoppingRuns.set(runId, (this.stoppingRuns.get(runId) ?? 0) + 1);
    try {
      const active = [...this.active.entries()].filter(([, value]) => value.runId === runId);
      for (const [, value] of active) value.controller.abort();
      const stopped = await Promise.allSettled([
        Promise.resolve().then(() => this.executionPlugins.interrupt(runId)),
        Promise.resolve().then(() => {
          const rows = this.kernel.store.db.prepare('SELECT id FROM tasks WHERE run_id=?').all(runId) as {
            id: string;
          }[];
          return this.services.cancelProcesses(
            new Set([...rows.map((row) => row.id), ...active.map(([key]) => key)]),
          );
        }),
        ...active.map(([, value]) => value.promise),
      ]);
      const interrupted = stopped.every((result) => result.status === 'fulfilled');
      return {
        runId,
        interrupted,
        schedulingPaused: true,
        persistentPauseRecorded: true,
        localExecutionStopped: true,
        replayed: false,
        message: interrupted
          ? '本机当前执行已停止，持久停止已保存，重启后仍禁止后续调度。检查结果并修复记录后需显式恢复。'
          : '持久停止已保存，重启后仍禁止后续调度；部分当前执行未能确认停止，请核验结果或再次尝试停止。',
      };
    } finally {
      const remaining = this.stoppingRuns.get(runId)! - 1;
      if (remaining) this.stoppingRuns.set(runId, remaining);
      else this.stoppingRuns.delete(runId);
    }
  }
  /**
   * 按全局、运行、依赖、通道和账号限制顺序给出第一个排队原因。
   * EN: Returns the first queue reason in global, run, dependency, channel, and account-limit order.
   */
  private queueReason(task: Task, run: Run): RuntimeQueueReason {
    if (this.active.size >= 4) return 'global-concurrency';
    if ([...this.active.values()].filter((entry) => entry.runId === run.id).length >= run.limits.concurrency)
      return 'run-concurrency';
    if (
      !this.kernel
        .dependencies(task)
        .every((key) => this.kernel.store.require<Task>('tasks', key).status === 'DONE')
    )
      return 'dependencies';
    const admission = this.executionPlugins.forRun(run).admission;
    const preparation = this.admissions.reason(admission);
    if (preparation) return preparation;
    const unavailable = admission?.unavailable(run);
    if (unavailable) return unavailable;
    const agent = this.kernel.store.require<Agent>('agents', task.agentId);
    if (
      [...this.active.values()].filter((entry) => entry.account === agent.providerBinding.account).length >=
      agent.providerBinding.concurrency
    )
      return 'account-concurrency';
    return admission?.reason(task, run) ?? 'ready';
  }
  /**
   * 入口、持久停止和归档检查先于通道选择，旧入口不能因加载了某驱动就调度其历史任务。
   * EN: Checks surface ownership, durable stops, and archival before selecting channels; loading a driver cannot authorize scheduling historical work from another surface.
   */
  private schedulableRun(run: Run) {
    return (
      this.services.acceptRun(run) &&
      !this.isLocallyStopped(run.id) &&
      !run.archived &&
      ['READY', 'RUNNING'].includes(run.status) &&
      (!run.projectId || !this.kernel.store.require<Project>('projects', run.projectId).archived)
    );
  }
  /**
   * 以最近派发次序做轮转，避免每步回到 READY 的任务长期挤占一直等待的同级任务。
   * EN: Rotates by recent dispatch order so a task returning to READY does not repeatedly displace waiting peers.
   */
  private orderedCandidates(tasks: readonly Task[]) {
    /**
     * 原生步骤可能返回READY，重新执行前应先给等待的同级任务机会。
     * EN: A native step may return to READY. Give waiting peers their turn before it runs again.
     */
    return [...tasks].sort(
      (left, right) => (this.dispatchOrder.get(left.id) ?? 0) - (this.dispatchOrder.get(right.id) ?? 0),
    );
  }
  /**
   * 返回队列和活动任务快照；可按运行过滤，revision 随整体状态变化递增。
   * EN: Returns queue and active-task snapshots, optionally scoped to a run; revision advances when snapshot content changes.
   */
  runtimeSnapshot(runId?: string): ExecutorRuntimeSnapshot {
    const queue: RuntimeQueueEntry[] = [];
    for (const task of this.orderedCandidates(
      this.kernel.store.stateCandidates<Task>('tasks', ['READY'], {
        excludeRunIds: [...this.locallyStopped],
        excludeExecutionHolds: true,
      }),
    )) {
      if (task.status !== 'READY' || this.active.has(task.id)) continue;
      const run = this.kernel.store.require<Run>('runs', task.runId);
      if (this.schedulableRun(run))
        queue.push({
          runId: run.id,
          taskId: task.id,
          position: queue.length + 1,
          reason: this.queueReason(task, run),
          ...this.executionPlugins.forRun(run).queueMetadata?.(run),
        });
    }
    const activeTaskIds = [...this.active.keys()];
    const serialized = stable({ queue, activeTaskIds });
    if (serialized !== this.runtimeLast) {
      this.runtimeLast = serialized;
      this.runtimeRevision++;
    }
    return {
      revision: this.runtimeRevision,
      queue: queue.filter((entry) => !runId || entry.runId === runId),
      activeTaskIds: activeTaskIds.filter((key) => !runId || this.active.get(key)?.runId === runId),
    };
  }
  /**
   * 中断运行，或只中断指定任务及其后代，并等待进程取消完成。
   * EN: Interrupts a run or a selected task and its descendants, waiting for process cancellation to finish.
   */
  async interrupt(runId: string, taskId?: string) {
    const tasks = taskId
      ? new Set(this.kernel.descendants(this.kernel.store.require<Task>('tasks', taskId)).map((t) => t.id))
      : undefined;
    const active = [...this.active.entries()].filter(
      ([key, value]) => value.runId === runId && (!tasks || tasks.has(key)),
    );
    for (const [, value] of active) value.controller.abort();
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => this.executionPlugins.interrupt(runId, taskId)),
      Promise.resolve().then(() =>
        this.services.cancelProcesses(
          tasks ?? new Set(this.kernel.store.all<Task>('tasks', runId).map((t) => t.id)),
        ),
      ),
      Promise.allSettled(active.map(([, value]) => value.promise)),
    ]);
    const error = stopped.find((result) => result.status === 'rejected');
    if (error?.status === 'rejected') throw error.reason;
  }
  /**
   * 停止新调度并共享关闭过程，重复调用返回同一 Promise。
   * EN: Stops new scheduling and shares one shutdown process; repeated calls return the same promise.
   */
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.capacityController.abort();
    if (this.timer) clearInterval(this.timer);
    return (this.closing = Promise.resolve().then(() => this.close()));
  }
  /**
   * 先保存可调度运行的暂停，再取消在途工作、等待准备阶段收束，最后释放驱动和工具。 每个阶段收集异常而非遇首错退出，确保某条损坏记录不会跳过其他进程的停止。
   * EN: Persists pauses for schedulable runs, cancels active work, drains preparation, then releases drivers and tools. Each stage collects errors instead of exiting on the first failure, so one corrupt record cannot skip stopping other processes.
   */
  private async close() {
    const errors: unknown[] = [];
    /**
     * 等待一组关闭动作全部结束，把各失败加入错误集合而不提前跳过其他资源清理。
     * EN: Waits for every shutdown action in a group and records each failure without skipping other cleanup.
     */
    const settle = async (work: Promise<unknown>[]) => {
      for (const result of await Promise.allSettled(work))
        if (result.status === 'rejected') errors.push(result.reason);
    };
    try {
      for (const run of this.kernel.store.stateCandidates<Run>('runs', ['READY', 'RUNNING'], {
        excludeRunIds: [...this.locallyStopped],
        excludeExecutionHolds: true,
      })) {
        try {
          if (this.services.acceptRun(run) && ['READY', 'RUNNING'].includes(run.status))
            this.kernel.action(run.id, 'pause');
        } catch (error) {
          errors.push(error);
        }
      }
    } catch (error) {
      errors.push(error);
    }
    const active = [...this.active.values()];
    /**
     * 即使较慢准入检查仍在收束，也要立即观察任务失败。
     * EN: Observe task failures immediately, even while a slower admission check is still draining.
     */
    const draining = settle(active.map((value) => value.promise));
    for (const value of active) value.controller.abort();
    /**
     * 关闭开始时准入过程可能仍在使用驱动，须先等待调度器收束。
     * EN: Admission can still be using a driver while shutdown begins. Drain the scheduler first.
     */
    await settle([
      this.ticking ?? Promise.resolve(),
      Promise.resolve().then(() => this.services.cancelProcesses()),
    ]);
    await settle([Promise.resolve().then(() => this.executionPlugins.dispose()), draining]);
    await settle([Promise.resolve().then(() => this.services.disposeTools())]);
    if (errors.length) throw new AggregateError(errors, '执行器退出未完全成功');
  }
  /**
   * 合并重叠的调度请求；一轮完成后允许下一轮重新读取状态。
   * EN: Coalesces overlapping scheduling requests; a completed round allows the next round to reread state.
   */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.ticking ??= Promise.resolve()
      .then(() => this.schedule())
      .finally(() => {
        this.ticking = undefined;
      }));
  }
  /**
   * 处理待应用消息、限流恢复及时间预算，再并发准备本轮通道。 不需要准备资源的候选可立即派发；每个资源域就绪后再次检查候选。
   * EN: Applies pending messages, rate-limit recovery, and time budgets, then prepares channels concurrently. Resource-free candidates may dispatch immediately; each prepared domain triggers another candidate check.
   */
  private async schedule() {
    if (this.stopped) return;
    try {
      for (let run of this.kernel.store
        .schedulerRunCandidates(Date.now(), [...this.locallyStopped])
        .filter(
          (r) => this.services.acceptRun(r) && !r.archived && !['DONE', 'CANCELLED'].includes(r.status),
        )) {
        if (this.isLocallyStopped(run.id)) continue;
        if (run.projectId && this.kernel.store.require<Project>('projects', run.projectId).archived) continue;
        if (
          this.kernel.store.hasPendingInbox(run.id) &&
          ![...this.active.values()].some((a) => a.runId === run.id) &&
          (run.kind === 'chat' ||
            (!this.kernel.store
              .stateCandidates<Task>('tasks', ['VERIFYING', 'WAITING'], { runId: run.id })
              .some(
                (t) =>
                  t.status === 'VERIFYING' || (t.status === 'WAITING' && t.waitReason === 'verification'),
              ) &&
              !this.kernel.store
                .stateCandidates<RequestRecord>('requests', ['RESERVED', 'UNKNOWN'], { runId: run.id })
                .some((r) => ['RESERVED', 'UNKNOWN'].includes(r.status)) &&
              !this.kernel.store
                .stateCandidates<Operation>('tool_operations', ['INTENT', 'UNCERTAIN'], { runId: run.id })
                .some((o) => ['INTENT', 'UNCERTAIN'].includes(o.status))))
        ) {
          /**
           * 先应用安全的项目反馈，再检查保持累计的时间预算。
           * EN: Apply safe project feedback before checking its unchanged cumulative time budget.
           */
          this.kernel.applyInbox(run.id);
          run = this.kernel.store.require<Run>('runs', run.id);
        }
        this.resumeRateLimited(run.id);
        run = this.kernel.store.require<Run>('runs', run.id);
        if (
          run.startedAt &&
          Date.now() - run.startedAt >= run.limits.maxMinutes * 60000 &&
          ['READY', 'RUNNING'].includes(run.status)
        ) {
          for (const t of this.kernel.store
            .stateCandidates<Task>('tasks', ['READY', 'RUNNING'], { runId: run.id })
            .filter((t) => ['READY', 'RUNNING'].includes(t.status)))
            this.waitAtLimit(t, 'TIME_BUDGET', '运行时间达到上限');
          await this.interrupt(run.id);
          continue;
        }
      }
      const tasks = this.kernel.store.stateCandidates<Task>('tasks', ['READY'], {
        excludeRunIds: [...this.locallyStopped],
        excludeExecutionHolds: true,
      });
      const candidates = new Set(tasks.map((task) => task.id));
      for (const taskId of this.dispatchOrder.keys())
        if (!candidates.has(taskId) && !this.active.has(taskId)) this.dispatchOrder.delete(taskId);
      const admissions = new Set<ExecutionAdmission>();
      /**
       * 多种贡献键可指向同一资源域；按实例去重，使每轮容量检查只执行一次。
       * EN: Multiple contribution keys may share one resource domain; deduplicate by instance to run one capacity check per round.
       */
      for (const task of tasks) {
        const run = this.kernel.store.require<Run>('runs', task.runId);
        if (this.active.has(task.id) || !this.schedulableRun(run)) continue;
        const admission = this.executionPlugins.forRun(run).admission;
        if (admission) admissions.add(admission);
      }
      const dispatched = new Set<string>();
      /**
       * 所有准备完成回调共用本轮 dispatched；同一候选不能被多个就绪回调重复启动。
       * EN: All preparation callbacks share dispatched for this round, so multiple ready callbacks cannot launch the same candidate twice.
       */
      const dispatch = () => this.dispatchReady(tasks, dispatched);
      const preparing = this.admissions.prepare(
        admissions,
        this.capacityController.signal,
        dispatch,
        (error) => console.error('执行环境检查失败：', error instanceof Error ? error.message : error),
      );
      /**
       * 无需资源的任务立即启动；每个就绪通道按原候选顺序再检查一次。
       * EN: Resource-free tasks start now; each prepared channel gets another pass in candidate order.
       */
      const results = await Promise.allSettled([preparing, Promise.resolve().then(dispatch)]);
      const errors = results.filter((result) => result.status === 'rejected');
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          '执行通道派发失败',
        );
    } catch (error) {
      console.error('调度错误：', error instanceof Error ? error.message : error);
    }
  }
  /**
   * 派发前重新读取任务与运行状态，预约通道资源，并在步骤结束后释放。
   * EN: Rereads task and run state before dispatch, reserves channel resources, and releases them after the step.
   */
  private dispatchReady(tasks: readonly Task[], dispatched: Set<string>) {
    for (const candidate of this.orderedCandidates(tasks)) {
      if (this.stopped || this.active.size >= 4) break;
      /**
       * 每次准备完成都重新核对宿主当前状态，不使用早先快照直接派发。
       * EN: Every preparation completion rechecks current host state, never its earlier snapshot.
       */
      if (dispatched.has(candidate.id) || this.isLocallyStopped(candidate.runId)) continue;
      const task = this.kernel.store.get<Task>('tasks', candidate.id);
      if (!task || task.status !== 'READY' || this.active.has(task.id)) continue;
      const run = this.kernel.store.get<Run>('runs', task.runId);
      if (!run || !this.schedulableRun(run) || this.queueReason(task, run) !== 'ready') continue;
      const agent = this.kernel.store.require<Agent>('agents', task.agentId);
      const controller = new AbortController();
      const admission = this.executionPlugins.forRun(run).admission;
      if (admission && !admission.acquire(task, run)) continue;
      dispatched.add(task.id);
      this.dispatchOrder.set(task.id, ++this.dispatchSequence);
      const promise = this.services
        .step(task, controller.signal)
        .catch((error) => this.fail(task, error))
        .finally(() => {
          this.active.delete(task.id);
          admission?.release(task.id);
        });
      this.active.set(task.id, {
        controller,
        promise,
        account: agent.providerBinding.account,
        runId: task.runId,
      });
    }
  }
  /**
   * 优先读取结构化限流信息；旧记录仅在没有新字段时使用 result.resumeAt。
   * EN: Prefers structured rate-limit state; legacy result.resumeAt is used only when the new field is absent.
   */
  rateLimitResumeAt(task: Task) {
    const legacy =
      task.result && typeof task.result === 'object'
        ? (task.result as { resumeAt?: unknown }).resumeAt
        : undefined;
    const value = task.rateLimit === undefined ? legacy : task.rateLimit?.resumeAt;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  }
  /**
   * 先将已到期的限流等待任务转为 READY，再协调依赖并决定是否恢复运行；真正派发仍核对依赖。
   * 本地停止或归档运行不在这里恢复，未到期任务保留冷却状态。
   * EN: Release expired rate-limit task waits into READY, then reconcile dependencies and decide
   * whether the run can resume; actual dispatch still checks dependencies. Locally stopped or
   * archived runs are not resumed here, and future task cooldowns remain intact.
   */
  private resumeRateLimited(runId: string) {
    if (this.isLocallyStopped(runId)) return;
    this.kernel.store.tx(() => {
      const store = this.kernel.store;
      let run = store.require<Run>('runs', runId);
      if (run.archived || (run.projectId && store.require<Project>('projects', run.projectId).archived))
        return;
      if (
        ['READY', 'RUNNING'].includes(run.status) ||
        (run.status === 'WAITING' && run.reason === 'rate_limit')
      )
        for (const task of store.stateCandidates<Task>('tasks', ['WAITING'], {
          runId: run.id,
          waitReasons: ['rate_limit'],
          resumeBefore: Date.now(),
        })) {
          const resumeAt = this.rateLimitResumeAt(task);
          if (resumeAt === undefined || resumeAt > Date.now() || this.active.has(task.id)) continue;
          if (task.status === 'WAITING' && task.waitReason === 'rate_limit')
            this.kernel.updateTask(task, 'READY', { waitReason: undefined });
        }
      /**
       * 选择到期可执行分支前先协调依赖，使本轮恢复的依赖能够及时生效， 同时不唤醒仍处于未来冷却期的无关任务。
       * EN: Reconcile dependencies before selecting an expired runnable branch, so a recovered dependency resumes it in this tick without reviving an unrelated future cooldown.
       */
      this.kernel.wakeChildren(run.id);
      run = store.require<Run>('runs', runId);
      if (
        run.status === 'WAITING' &&
        run.reason === 'rate_limit' &&
        store
          .stateCandidates<Task>('tasks', ['READY'], { runId: run.id, resumeBefore: Date.now() })
          .some((task) => {
            const resumeAt = this.rateLimitResumeAt(task);
            return (
              task.status === 'READY' &&
              resumeAt !== undefined &&
              resumeAt <= Date.now() &&
              !this.active.has(task.id) &&
              this.kernel
                .dependencies(task)
                .every((key) => store.require<Task>('tasks', key).status === 'DONE')
            );
          })
      )
        this.kernel.updateRun(run, { status: 'READY', reason: undefined });
    });
  }
  /**
   * 仅对仍在 RUNNING 的任务写限流等待，避免迟到请求覆盖用户暂停或取消。
   * EN: Writes rate-limit waiting only for tasks still RUNNING, preventing late responses from overwriting user pauses or cancellations.
   */
  waitAtRateLimit(task: Task, rateLimit: NonNullable<Task['rateLimit']>) {
    this.kernel.store.tx(() => {
      const current = this.kernel.store.require<Task>('tasks', task.id);
      if (current.status !== 'RUNNING') return;
      const updated = this.kernel.updateTask(current, 'RUNNING', { rateLimit });
      this.kernel.wait(updated, 'rate_limit');
    });
  }
  /**
   * 累计预算等硬限制转为 limit 等待并记录事件；重复的同类等待不反复推进版本。
   * EN: Converts cumulative hard limits into a limit wait and records events; repeated identical waits do not keep advancing revisions.
   */
  waitAtLimit(task: Task, code: string, message: string) {
    this.kernel.store.tx(() => {
      const current = this.kernel.store.require<Task>('tasks', task.id);
      if (current.status === 'WAITING' && current.waitReason === 'limit') return;
      this.kernel.wait(current, 'limit');
      this.kernel.event(current.runId, 'limit.reached', { taskId: current.id, code, message }, current.id);
    });
  }
  /**
   * 步骤异常按语义分类：订阅额度/预算进入可解释等待，其余标记任务与活动尝试失败。 已等待、完成或取消的任务不再覆盖，避免异常回调破坏用户刚提交的状态。
   * EN: Classifies step failures: subscription and budget limits become explanatory waits; other failures mark the task and active attempt failed. Tasks already waiting, completed, or cancelled are not overwritten, protecting concurrent user changes.
   */
  fail(task: Task, error: unknown) {
    const store = this.kernel.store;
    const current = store.require<Task>('tasks', task.id);
    if (['WAITING', 'CANCELLED', 'DONE'].includes(current.status)) return;
    const e = error instanceof Error ? error : new Error(String(error));
    store.tx(() => {
      if (e instanceof AppError && e.code === 'CHATGPT_USAGE_LIMIT')
        this.kernel.wait(current, 'subscription_limit');
      else if (
        e instanceof AppError &&
        (/BUDGET|CONTEXT_LIMIT|TIME_BUDGET/.test(e.code) || e.code === 'ACCOUNT_TOKEN_LIMIT')
      )
        this.waitAtLimit(current, e.code, e.message);
      else {
        this.kernel.updateTask(current, 'FAILED', {
          result: { error: e.message, code: e instanceof AppError ? e.code : 'EXECUTOR_ERROR' },
        });
        const a = store
          .all<Attempt>('attempts', task.runId)
          .find((a) => a.taskId === task.id && a.status === 'ACTIVE');
        if (a) store.put('attempts', { ...a, status: 'FAILED', lease: null, error: e.message });
        const run = store.require<Run>('runs', task.runId);
        if (task.id === run.rootTaskId) this.kernel.updateRun(run, { status: 'FAILED', reason: e.message });
      }
      this.kernel.event(
        task.runId,
        'error',
        { code: e instanceof AppError ? e.code : 'EXECUTOR_ERROR', message: e.message },
        task.id,
      );
    });
  }
}
