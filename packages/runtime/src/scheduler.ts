/** 调度运行任务并协调执行限制。 */
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
  acceptRun(run: Run): boolean;
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
  get isClosing() {
    return !!this.closing;
  }
  constructor(
    readonly kernel: Kernel<Store>,
    readonly executionPlugins: ExecutionPlugins,
    private readonly services: SchedulerServices,
  ) {}
  /** 启动定时调度；重复启动不创建第二个计时器。 */
  start() {
    if (this.closing) throw new AppError('EXECUTOR_DISPOSED', '执行器已释放');
    if (this.timer && !this.stopped) return;
    this.stopped = false;
    if (this.capacityController.signal.aborted) this.capacityController = new AbortController();
    this.timer = setInterval(() => void this.tick(), 300);
    void this.tick();
  }
  resume(_runId: string) {
    void this.tick();
  }
  isLocallyStopped(runId: string) {
    return this.locallyStopped.has(runId) || !!this.kernel.store.getExecutionHold(runId);
  }
  /** Only an explicitly authorized, readable start/resume may release this hold. */
  releaseLocalStop(runId: string) {
    if (this.stoppingRuns.has(runId))
      throw new AppError('STOP_IN_PROGRESS', '停止尚未完成，请稍后再显式恢复', true, null, 409);
    this.kernel.store.recovery.release(runId);
    this.locallyStopped.delete(runId);
  }
  /**
   * 先保存持久停止标记，再取消当前执行与相关进程。
   * interrupted 仅在所有停止动作成功时为真；部分失败仍保留调度暂停。
   */
  async stopCurrent(runId: string): Promise<RunStopCurrentResult> {
    // Persist first: a failed write must never acknowledge a durable stop or abort work.
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
  /** 按全局、运行、依赖、通道和账号限制顺序给出第一个排队原因。 */
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
  private schedulableRun(run: Run) {
    return (
      this.services.acceptRun(run) &&
      !this.isLocallyStopped(run.id) &&
      !run.archived &&
      ['READY', 'RUNNING'].includes(run.status) &&
      (!run.projectId || !this.kernel.store.require<Project>('projects', run.projectId).archived)
    );
  }
  private orderedCandidates(tasks: readonly Task[]) {
    // A native step may return to READY. Give waiting peers their turn before it runs again.
    return [...tasks].sort(
      (left, right) => (this.dispatchOrder.get(left.id) ?? 0) - (this.dispatchOrder.get(right.id) ?? 0),
    );
  }
  /** 返回队列和活动任务快照；可按运行过滤，revision 随整体状态变化递增。 */
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
  /** 中断运行，或只中断指定任务及其后代，并等待进程取消完成。 */
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
  /** 停止新调度并共享关闭过程，重复调用返回同一 Promise。 */
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.capacityController.abort();
    if (this.timer) clearInterval(this.timer);
    return (this.closing = Promise.resolve().then(() => this.close()));
  }
  private async close() {
    const errors: unknown[] = [];
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
    // Observe task failures immediately, even while a slower admission check is still draining.
    const draining = settle(active.map((value) => value.promise));
    for (const value of active) value.controller.abort();
    // Admission can still be using a driver while shutdown begins. Drain the scheduler first.
    await settle([
      this.ticking ?? Promise.resolve(),
      Promise.resolve().then(() => this.services.cancelProcesses()),
    ]);
    await settle([Promise.resolve().then(() => this.executionPlugins.dispose()), draining]);
    await settle([Promise.resolve().then(() => this.services.disposeTools())]);
    if (errors.length) throw new AggregateError(errors, '执行器退出未完全成功');
  }
  /** 合并重叠的调度请求；一轮完成后允许下一轮重新读取状态。 */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.ticking ??= Promise.resolve()
      .then(() => this.schedule())
      .finally(() => {
        this.ticking = undefined;
      }));
  }
  /**
   * 处理待应用消息、限流恢复及时间预算，再并发准备本轮通道。
   * 不需要准备资源的候选可立即派发；每个资源域就绪后再次检查候选。
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
          // Apply safe project feedback before checking its unchanged cumulative time budget.
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
      for (const task of tasks) {
        const run = this.kernel.store.require<Run>('runs', task.runId);
        if (this.active.has(task.id) || !this.schedulableRun(run)) continue;
        const admission = this.executionPlugins.forRun(run).admission;
        if (admission) admissions.add(admission);
      }
      const dispatched = new Set<string>();
      const dispatch = () => this.dispatchReady(tasks, dispatched);
      const preparing = this.admissions.prepare(
        admissions,
        this.capacityController.signal,
        dispatch,
        (error) => console.error('执行环境检查失败：', error instanceof Error ? error.message : error),
      );
      // Resource-free tasks start now; each prepared channel gets another pass in candidate order.
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
  /** 派发前重新读取任务与运行状态，预约通道资源，并在步骤结束后释放。 */
  private dispatchReady(tasks: readonly Task[], dispatched: Set<string>) {
    for (const candidate of this.orderedCandidates(tasks)) {
      if (this.stopped || this.active.size >= 4) break;
      // Every preparation completion rechecks current host state, never its earlier snapshot.
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
  rateLimitResumeAt(task: Task) {
    const legacy =
      task.result && typeof task.result === 'object'
        ? (task.result as { resumeAt?: unknown }).resumeAt
        : undefined;
    const value = task.rateLimit === undefined ? legacy : task.rateLimit?.resumeAt;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  }
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
      // Reconcile dependencies before selecting an expired runnable branch, so a recovered
      // dependency resumes it in this tick without reviving an unrelated future cooldown.
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
  waitAtRateLimit(task: Task, rateLimit: NonNullable<Task['rateLimit']>) {
    this.kernel.store.tx(() => {
      const current = this.kernel.store.require<Task>('tasks', task.id);
      if (current.status !== 'RUNNING') return;
      const updated = this.kernel.updateTask(current, 'RUNNING', { rateLimit });
      this.kernel.wait(updated, 'rate_limit');
    });
  }
  waitAtLimit(task: Task, code: string, message: string) {
    this.kernel.store.tx(() => {
      const current = this.kernel.store.require<Task>('tasks', task.id);
      if (current.status === 'WAITING' && current.waitReason === 'limit') return;
      this.kernel.wait(current, 'limit');
      this.kernel.event(current.runId, 'limit.reached', { taskId: current.id, code, message }, current.id);
    });
  }
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
