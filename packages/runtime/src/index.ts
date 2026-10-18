import {
  AppError,
  ContextRuntimeMetrics,
  inspectToolCalls,
  type Agent,
  type Task,
  type Run,
  type Attempt,
  type RequestRecord,
  type ToolCall,
  type Operation,
  type Project,
  type Artifact,
  type Snapshot,
} from '../../contracts/src/index.js';
import { hash, id, stable } from '../../storage/src/index.js';
import { Kernel } from '../../kernel/src/index.js';
import { ToolGateway } from '../../tools/src/index.js';
import { compileContext, requestDifference } from '../../context/src/index.js';
import {
  NativeProvider,
  ProviderError,
  type ProviderAdapter,
  type ProviderEvent,
} from '../../providers/src/index.js';
import type {
  ExecutorRuntimeSnapshot,
  RuntimeQueueEntry,
  RuntimeQueueReason,
} from '../../contracts/src/terminal-runtime.js';
import type { TerminalResourcePool } from './terminal-resources.js';
import type { RunStopCurrentResult } from '../../contracts/src/run-reads.js';
import type { ReasoningDelta } from '../../contracts/src/reasoning.js';
import { toolRecovery } from './tool-recovery.js';
export interface ExecutorAdapter {
  capabilities: { recursive: boolean; recoverable: boolean };
  start(): void;
  interrupt(runId: string, taskId?: string): Promise<void>;
  resume(runId: string): void;
  dispose(): Promise<void>;
}
export class NativeExecutor implements ExecutorAdapter {
  capabilities = { recursive: true, recoverable: true };
  gateway: ToolGateway;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; account: string; runId: string }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private locallyStopped = new Set<string>();
  private stoppingRuns = new Map<string, number>();
  private ticking = false;
  private toolActive = 0;
  private runtimeRevision = 0;
  private runtimeLast = '';
  private capacityController = new AbortController();
  onDelta: (runId: string, taskId: string, text: string, requestId: string, offset: number) => void =
    () => {};
  onReasoningDelta: (value: ReasoningDelta) => void = () => {};
  adapterFactory: (agent: Agent) => ProviderAdapter = (agent) => new NativeProvider(agent.providerBinding);
  terminalRunner?: (task: Task, signal: AbortSignal) => Promise<void>;
  terminalInterrupt?: (runId: string, taskId?: string) => Promise<void>;
  terminalDispose?: () => Promise<void>;
  terminalResources?: TerminalResourcePool;
  terminalCapacityRefresh?: (signal?: AbortSignal) => Promise<void>;
  /** A workbench surface owns only its selected execution kind. */
  acceptRun: (run: Run) => boolean = () => true;
  constructor(public kernel: Kernel) {
    this.gateway = new ToolGateway(kernel);
  }
  start() {
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
  async stopCurrent(runId: string): Promise<RunStopCurrentResult> {
    // Persist first: a failed write must never acknowledge a durable stop or abort work.
    this.kernel.store.recovery.hold(runId, 'user_stop');
    this.locallyStopped.add(runId);
    this.stoppingRuns.set(runId, (this.stoppingRuns.get(runId) ?? 0) + 1);
    try {
      const active = [...this.active.entries()].filter(([, value]) => value.runId === runId);
      for (const [, value] of active) value.controller.abort();
      const stopped = await Promise.allSettled([
        Promise.resolve().then(() => this.terminalInterrupt?.(runId)),
        Promise.resolve().then(() => {
          const rows = this.kernel.store.db.prepare('SELECT id FROM tasks WHERE run_id=?').all(runId) as {
            id: string;
          }[];
          return this.gateway.processes.cancel(
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
    if (run.execution?.kind === 'docker-agent' && this.terminalResources) {
      const reason = this.terminalResources.reason(run.execution.profile.resourcePreset);
      if (reason !== 'terminal-resources') return reason;
    }
    const agent = this.kernel.store.require<Agent>('agents', task.agentId);
    if (
      [...this.active.values()].filter((entry) => entry.account === agent.providerBinding.account).length >=
      agent.providerBinding.concurrency
    )
      return 'account-concurrency';
    if (
      run.execution?.kind === 'docker-agent' &&
      this.terminalResources &&
      !this.terminalResources.canAcquireTask(task.id, run.execution.profile.resourcePreset)
    )
      return this.terminalResources.reason(run.execution.profile.resourcePreset);
    return 'ready';
  }
  private schedulableRun(run: Run) {
    return (
      this.acceptRun(run) &&
      !this.isLocallyStopped(run.id) &&
      !run.archived &&
      ['READY', 'RUNNING'].includes(run.status) &&
      (!run.projectId || !this.kernel.store.require<Project>('projects', run.projectId).archived)
    );
  }
  runtimeSnapshot(runId?: string): ExecutorRuntimeSnapshot {
    const queue: RuntimeQueueEntry[] = [];
    for (const task of this.kernel.store.stateCandidates<Task>('tasks', ['READY'], {
      excludeRunIds: [...this.locallyStopped],
      excludeExecutionHolds: true,
    })) {
      if (task.status !== 'READY' || this.active.has(task.id)) continue;
      const run = this.kernel.store.require<Run>('runs', task.runId);
      if (this.schedulableRun(run))
        queue.push({
          runId: run.id,
          taskId: task.id,
          position: queue.length + 1,
          reason: this.queueReason(task, run),
          ...(run.execution?.kind === 'docker-agent'
            ? { resourcePreset: run.execution.profile.resourcePreset ?? 'standard' }
            : {}),
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
  async interrupt(runId: string, taskId?: string) {
    const tasks = taskId
      ? new Set(this.kernel.descendants(this.kernel.store.require<Task>('tasks', taskId)).map((t) => t.id))
      : undefined;
    const active = [...this.active.entries()].filter(
      ([key, value]) => value.runId === runId && (!tasks || tasks.has(key)),
    );
    for (const [, value] of active) value.controller.abort();
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => this.terminalInterrupt?.(runId, taskId)),
      Promise.resolve().then(() =>
        this.gateway.processes.cancel(
          tasks ?? new Set(this.kernel.store.all<Task>('tasks', runId).map((t) => t.id)),
        ),
      ),
      Promise.allSettled(active.map(([, value]) => value.promise)),
    ]);
    const error = stopped.find((result) => result.status === 'rejected');
    if (error?.status === 'rejected') throw error.reason;
  }
  async dispose() {
    this.stopped = true;
    this.capacityController.abort();
    if (this.timer) clearInterval(this.timer);
    for (const run of this.kernel.store
      .stateCandidates<Run>('runs', ['READY', 'RUNNING'], {
        excludeRunIds: [...this.locallyStopped],
        excludeExecutionHolds: true,
      })
      .filter((r) => this.acceptRun(r) && ['READY', 'RUNNING'].includes(r.status)))
      this.kernel.action(run.id, 'pause');
    for (const value of this.active.values()) value.controller.abort();
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => this.terminalDispose?.()),
      Promise.resolve().then(() => this.gateway.processes.cancel()),
      Promise.allSettled([...this.active.values()].map((v) => v.promise)),
    ]);
    const disposed = await Promise.allSettled([Promise.resolve().then(() => this.gateway.dispose())]);
    const error = [...stopped, ...disposed].find((result) => result.status === 'rejected');
    if (error?.status === 'rejected') throw error.reason;
  }
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (let run of this.kernel.store
        .schedulerRunCandidates(Date.now(), [...this.locallyStopped])
        .filter((r) => this.acceptRun(r) && !r.archived && !['DONE', 'CANCELLED'].includes(r.status))) {
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
      if (
        this.terminalResources &&
        tasks.some((task) => {
          const run = this.kernel.store.require<Run>('runs', task.runId);
          return run.execution?.kind === 'docker-agent' && this.schedulableRun(run);
        })
      )
        await this.terminalCapacityRefresh?.(this.capacityController.signal);
      if (this.stopped) return;
      for (const candidate of tasks) {
        if (this.active.size >= 4) break;
        // A stop may arrive while terminal capacity is being refreshed above.
        if (this.isLocallyStopped(candidate.runId)) continue;
        const task = this.kernel.store.get<Task>('tasks', candidate.id);
        if (!task || task.status !== 'READY') continue;
        if (this.active.has(task.id)) continue;
        const run = this.kernel.store.get<Run>('runs', task.runId);
        if (!run) continue;
        if (this.isLocallyStopped(run.id)) continue;
        if (!this.acceptRun(run)) continue;
        if (run.archived || !['READY', 'RUNNING'].includes(run.status)) continue;
        if (run.projectId && this.kernel.store.require<Project>('projects', run.projectId).archived) continue;
        if ([...this.active.values()].filter((a) => a.runId === run.id).length >= run.limits.concurrency)
          continue;
        if (
          !this.kernel
            .dependencies(task)
            .every((dep) => this.kernel.store.require<Task>('tasks', dep).status === 'DONE')
        )
          continue;
        const agent = this.kernel.store.require<Agent>('agents', task.agentId);
        if (
          [...this.active.values()].filter((a) => a.account === agent.providerBinding.account).length >=
          agent.providerBinding.concurrency
        )
          continue;
        const controller = new AbortController();
        const terminalReservation = run.execution?.kind === 'docker-agent' && !!this.terminalResources;
        if (
          terminalReservation &&
          !this.terminalResources!.tryAcquire(
            task.id,
            'task',
            run.execution?.kind === 'docker-agent' ? run.execution.profile.resourcePreset : undefined,
          )
        )
          continue;
        const promise = this.step(task, controller.signal)
          .catch((error) => this.fail(task, error))
          .finally(() => {
            this.active.delete(task.id);
            if (terminalReservation) this.terminalResources!.release(task.id);
          });
        this.active.set(task.id, {
          controller,
          promise,
          account: agent.providerBinding.account,
          runId: task.runId,
        });
      }
    } catch (error) {
      console.error('调度错误：', error instanceof Error ? error.message : error);
    } finally {
      this.ticking = false;
    }
  }
  async tool(task: Task, attempt: Attempt, call: ToolCall, signal: AbortSignal, assistantMessageId?: string) {
    const limit = this.kernel.store.require<Run>('runs', task.runId).limits.toolConcurrency;
    while (this.toolActive >= limit) {
      await delay(20, signal);
    }
    this.toolActive++;
    try {
      return await this.gateway.call(
        this.kernel.store.require('tasks', task.id),
        attempt,
        call,
        signal,
        assistantMessageId,
      );
    } catch (e) {
      if (signal.aborted || this.kernel.store.require<Task>('tasks', task.id).waitReason === 'verification')
        throw e;
      let toolNames: string[] = [];
      try {
        toolNames = this.gateway
          .definitions(this.kernel.store.require<Task>('tasks', task.id))
          .map((definition) => definition.name);
      } catch {
        // A revoked authorization must not be treated as a stale list of usable tools.
      }
      const code = e instanceof AppError ? e.code : 'TOOL_ERROR';
      return {
        error: e instanceof Error ? e.message : String(e),
        code,
        retryable: e instanceof AppError ? e.retryable : false,
        recovery: toolRecovery(code, call.name, toolNames),
      };
    } finally {
      this.toolActive--;
    }
  }
  async executeCalls(
    task: Task,
    attempt: Attempt,
    calls: ToolCall[],
    signal: AbortSignal,
    assistantMessageId?: string,
  ) {
    const sequence = inspectToolCalls(this.kernel.history(task));
    if (sequence.error) throw new AppError(sequence.error.code, sequence.error.message);
    if (!assistantMessageId) {
      const owners = new Set(
        sequence.pending
          .filter((item) => calls.some((call) => call.id === item.call.id))
          .map((item) => item.message.id),
      );
      if (owners.size === 1) assistantMessageId = [...owners][0];
    }
    const outcomes: { call: ToolCall; result: unknown }[] = [];
    const orchestration = new Set([
      'write',
      'apply_patch',
      'materialize_artifact',
      'exec',
      'artifact',
      'mcp_call',
      'clarify',
      'propose_plan',
      'spawn_task',
      'allocate_context',
      'join_tasks',
      'submit_result',
      'integrate_worktrees',
    ]);
    if (calls.some((c) => orchestration.has(c.name))) {
      for (const call of calls) {
        const result = await this.tool(task, attempt, call, signal, assistantMessageId);
        this.kernel.store.tx(() =>
          this.kernel.appendMessage(task, 'tool', stable(result), { callId: call.id }),
        );
        outcomes.push({ call, result });
      }
    } else {
      const results = await Promise.allSettled(
        calls.map((call) => this.tool(task, attempt, call, signal, assistantMessageId)),
      );
      for (let i = 0; i < calls.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          this.kernel.store.tx(() =>
            this.kernel.appendMessage(task, 'tool', stable(r.value), { callId: calls[i].id }),
          );
          outcomes.push({ call: calls[i], result: r.value });
        } else throw r.reason;
      }
    }
    this.observeToolFailures(task, outcomes, assistantMessageId);
    this.kernel.checkpoint(attempt.id);
  }
  private observeToolFailures(
    task: Task,
    outcomes: { call: ToolCall; result: unknown }[],
    assistantMessageId?: string,
  ) {
    // Only known, non-transient validation/authorization failures count. Polls, provider
    // limits, unknown side effects and generic I/O errors must keep their own recovery rules.
    const deterministic = new Set([
      'TOOL_ARGUMENTS',
      'TOOL_DENIED',
      'TOOL_UNKNOWN',
      'TASK_KEY_EXISTS',
      'TASK_SCOPE',
      'SPAWN_DENIED',
      'DEPENDENCY_MISSING',
      'WAIT_SCOPE',
      'CYCLE',
      'MODEL_BINDING',
      'PERMISSION_DENIED',
      'EXEC_DENIED',
      'PATH_ESCAPE',
      'ARTIFACT_SCOPE',
      'CRITERION_SCOPE',
      'ACCEPTANCE_INCOMPLETE',
    ]);
    const failures = outcomes.flatMap(({ call, result }) => {
      if (call.name === 'join_tasks') {
        const joined = (result as { result?: any } | null)?.result;
        const children = Array.isArray(joined)
          ? joined
          : joined?.waiting === false
            ? joined.children
            : undefined;
        if (
          Array.isArray(children) &&
          children.some(
            (child) =>
              ['FAILED', 'CANCELLED'].includes(child.status) ||
              (child.status === 'WAITING' &&
                (child.waitReason === 'no_progress' ||
                  (child.waitReason === 'dependency_failed' && child.dependencyBlock?.causes.length !== 0))),
          )
        )
          return [{ call, code: 'CHILDREN_BLOCKED' }];
      }
      const failure = result as { error?: unknown; code?: string; retryable?: boolean } | null;
      return failure?.error && failure.code && !failure.retryable && deterministic.has(failure.code)
        ? [{ call, code: failure.code }]
        : [];
    });
    if (!failures.length) return;
    const store = this.kernel.store;
    store.tx(() => {
      task = store.require<Task>('tasks', task.id);
      if (task.status !== 'RUNNING') return;
      const run = store.require<Run>('runs', task.runId);
      const mutating = new Set([
        'write',
        'apply_patch',
        'materialize_artifact',
        'exec',
        'artifact',
        'integrate_worktrees',
        'mcp_call',
      ]);
      const progressKey = hash(
        stable({
          contract: run.contract,
          authorized: run.authorized,
          acceptedPlanVersion: run.acceptedPlanVersion,
          tasks: store.all<Task>('tasks', task.runId).map((t) => ({
            id: t.id,
            spec: t.spec,
            phase: t.phase,
            workspace: t.workspace,
            result: t.result,
            status: ['READY', 'RUNNING'].includes(t.status) ? 'ACTIVE' : t.status,
            waitReason: t.status === 'WAITING' ? t.waitReason : undefined,
          })),
          artifacts: store.all<Artifact>('artifacts', task.runId).map((a) => [a.id, a.revision]),
          snapshots: store.all<Snapshot>('snapshots', task.runId).map((s) => [s.id, s.revision]),
          operations: store
            .all<Operation>('tool_operations', task.runId)
            .filter((o) => o.status === 'DONE' && mutating.has(o.name))
            .map((o) => [o.id, o.revision]),
        }),
      );
      const state: NonNullable<Task['noProgress']> =
        task.noProgress?.progressKey === progressKey
          ? structuredClone(task.noProgress)
          : { progressKey, failures: [], warned: false };
      const warnedBefore = state.warned;
      for (const { call, code } of failures) {
        let args: unknown = call.arguments.trim();
        try {
          args = JSON.parse(call.arguments);
          if (call.name === 'join_tasks' && Array.isArray((args as any)?.taskIds))
            args = { ...(args as object), taskIds: [...(args as any).taskIds].sort() };
        } catch {
          /* Invalid JSON is fingerprinted as raw text. */
        }
        const fingerprint = hash(stable({ tool: call.name, args, code }));
        const prior = state.failures.find((failure) => failure.fingerprint === fingerprint);
        const invocation = assistantMessageId ? assistantMessageId + ':' + call.id : call.id;
        if (prior?.lastCallId === invocation) continue;
        state.failures = state.failures.filter((failure) => failure.fingerprint !== fingerprint);
        state.failures.push({
          fingerprint,
          tool: call.name,
          code,
          count: (prior?.count ?? 0) + 1,
          lastCallId: invocation,
        });
        state.failures = state.failures.slice(-8);
      }
      const repeated = state.failures.find((failure) => failure.count >= 2);
      const stopped = state.failures.find((failure) => failure.count >= 3);
      if (repeated && !state.warned) {
        state.warned = true;
        this.kernel.appendMessage(
          task,
          'user',
          `运行提醒：${repeated.tool} 已连续产生相同确定性错误 ${repeated.code}，相关状态没有进展。请按工具结果的 recovery 修正参数或改用已授权能力；不要重复同一调用，继续相同错误将暂停该分支。已有任务：` +
            stable(
              store
                .all<Task>('tasks', task.runId)
                .map((t) => ({ taskId: t.id, key: t.spec.key, status: t.status })),
            ),
          { purpose: 'runtime_notice' },
        );
      }
      this.kernel.updateTask(task, task.status, { noProgress: state });
      // Give the model one correction turn even when a single response repeated many invalid calls.
      if (stopped && warnedBefore) this.kernel.wait(store.require<Task>('tasks', task.id), 'no_progress');
    });
  }
  async replayPending(task: Task, attempt: Attempt, signal: AbortSignal) {
    const sequence = inspectToolCalls(this.kernel.history(task));
    if (sequence.error) throw new AppError(sequence.error.code, sequence.error.message);
    if (sequence.pending.length)
      await this.executeCalls(
        task,
        attempt,
        sequence.pending.map((item) => item.call),
        signal,
        sequence.pending[0].message.id,
      );
  }
  private publishContext(task: Task, attempt: Attempt, metrics: ContextRuntimeMetrics, recordId?: string) {
    const current = { ...metrics, updatedAt: new Date().toISOString() };
    this.kernel.store.tx(() => {
      if (recordId) {
        const record = this.kernel.store.requestMetadata(recordId);
        this.kernel.store.put('requests', {
          ...record,
          manifest: { ...record.manifest, contextWindow: current },
        });
      }
      this.kernel.event(task.runId, 'context.updated', current, task.id, attempt.id);
    });
    return current;
  }
  async step(task: Task, signal: AbortSignal) {
    if (this.kernel.store.require<Run>('runs', task.runId).execution?.kind === 'docker-agent') {
      if (!this.terminalRunner) throw new AppError('TERMINAL_UNAVAILABLE', 'Agent 终端执行服务尚未连接');
      return this.terminalRunner(task, signal);
    }
    const cooldown = task.rateLimit;
    const store = this.kernel.store;
    const resumeAt = this.rateLimitResumeAt(task);
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
    await this.replayPending(task, attempt, signal);
    task = store.require('tasks', task.id);
    if (task.status !== 'RUNNING') return;
    let run = store.require<Run>('runs', task.runId);
    if (attempt.steps >= run.limits.maxSteps) {
      this.waitAtLimit(task, 'STEP_LIMIT', '运行步骤达到上限');
      return;
    }
    const definitions = await this.gateway.prepareDefinitions(task, signal);
    task = store.require<Task>('tasks', task.id);
    if (task.status !== 'RUNNING') return;
    run = store.require<Run>('runs', task.runId);
    const agent = store.require<Agent>('agents', task.agentId),
      config = agent.providerBinding;
    let context: ReturnType<typeof compileContext>;
    try {
      context = compileContext(store, task, definitions);
    } catch (error) {
      const metrics =
        error instanceof AppError
          ? ContextRuntimeMetrics.safeParse(
              (error.details as { contextMetrics?: unknown } | undefined)?.contextMetrics,
            )
          : null;
      if (metrics?.success) this.publishContext(task, attempt, metrics.data);
      throw error;
    }
    let metrics = this.publishContext(
      task,
      attempt,
      ContextRuntimeMetrics.parse(context.manifest.contextWindow),
    );
    const adapter = this.adapterFactory(agent),
      request = adapter.compile(context);
    const previous = store.latestTaskRequest(run.id, task.id);
    context.manifest.difference = requestDifference(previous?.manifest, context.manifest);
    const retryHistory = cooldown?.logicalId
      ? store.requestLedger({ runId: run.id, logicalId: cooldown.logicalId, attemptId: attempt.id })
      : [];
    const continuation =
      cooldown?.logicalId &&
      Number.isInteger(cooldown.retry) &&
      cooldown.retry! >= 0 &&
      cooldown.retry! <= 2 &&
      (cooldown.retry === 0 || retryHistory.length > 0);
    const logicalId = continuation ? cooldown!.logicalId! : id();
    const firstRetry = continuation ? Math.max(cooldown!.retry!, retryHistory.length) : 0;
    if (firstRetry >= 3)
      throw new ProviderError(
        'REQUEST_RETRY_LIMIT',
        '该次模型请求已达到 3 次尝试上限，请检查用量和已有响应后再重试。',
        400,
      );
    let complete: Extract<ProviderEvent, { type: 'completed' }> | null = null;
    let successfulRequestId: string | null = null;
    for (let retry = firstRetry; retry <= 2; retry++) {
      signal.throwIfAborted();
      const accountRequests = store.requestLedger({ account: config.account, since: Date.now() - 60000 });
      const requestTokens = context.estimatedTokens + config.outputLimit;
      if (requestTokens > config.tpm) {
        this.waitAtLimit(
          task,
          'ACCOUNT_TOKEN_LIMIT',
          '单次请求所需 Token 超过账号每分钟上限，请减少资料，或在模型设置中调整额度后新建任务。',
        );
        return;
      }
      const usedTokens = accountRequests.reduce(
        (sum, r) => sum + (r.usage?.inputTotal ?? r.reservedTokens) + (r.usage?.outputTotal ?? 0),
        0,
      );
      if (accountRequests.length >= config.rpm || usedTokens + requestTokens > config.tpm) {
        let remainingRequests = accountRequests.length;
        let remainingTokens = usedTokens;
        let resumeAt = Date.now() + 60000;
        for (const record of [...accountRequests].sort((a, b) => a.startedAt - b.startedAt)) {
          remainingRequests--;
          remainingTokens -=
            (record.usage?.inputTotal ?? record.reservedTokens) + (record.usage?.outputTotal ?? 0);
          if (remainingRequests < config.rpm && remainingTokens + requestTokens <= config.tpm) {
            resumeAt = Math.max(Date.now() + 1, record.startedAt + 60000);
            break;
          }
        }
        this.waitAtRateLimit(task, { resumeAt, source: 'account', logicalId, retry });
        return;
      }
      const record = this.kernel.reserve(
        task,
        attempt,
        config,
        context.manifest,
        context.estimatedTokens,
        logicalId,
      );
      store.startRequestStream(record.id);
      let partial = '';
      let reasoningOffset = 0,
        reasoningCacheFailed = false;
      let lastContextUpdate = 0;
      metrics = {
        ...metrics,
        phase: 'compiled',
        streamingOutputTokens: 0,
        observedInputTokens: null,
        observedOutputTokens: null,
      };
      if (retry > firstRetry) metrics = this.publishContext(task, attempt, metrics, record.id);
      try {
        for await (const event of adapter.stream(request, signal)) {
          if (event.type === 'delta') {
            store.appendRequestText(record.id, event.text, partial.length);
            partial += event.text;
            this.onDelta(run.id, task.id, event.text, record.id, partial.length - event.text.length);
            // Throttle persisted snapshots; text bytes are estimates, not tokenizer receipts.
            if (Date.now() - lastContextUpdate >= 500) {
              metrics = this.publishContext(
                task,
                attempt,
                {
                  ...metrics,
                  phase: 'streaming',
                  streamingOutputTokens:
                    Buffer.byteLength(partial, 'utf8') * (config.authMode === 'codex' ? 2 : 1),
                },
                record.id,
              );
              lastContextUpdate = Date.now();
            }
          } else if (event.type === 'reasoning_delta') {
            if (!reasoningCacheFailed) {
              try {
                const saved = store.appendRequestReasoning(
                  record.id,
                  event.text,
                  reasoningOffset,
                  event.kind,
                );
                if (saved.text)
                  this.onReasoningDelta({
                    runId: run.id,
                    taskId: task.id,
                    requestId: record.id,
                    kind: event.kind,
                    ...saved,
                  });
              } catch {
                // Optional display caching cannot change model output, usage or tool execution.
                reasoningCacheFailed = true;
              }
            }
            reasoningOffset += event.text.length;
          } else complete = event;
        }
        if (!complete) throw new ProviderError('STREAM_INTERRUPTED', '模型未产生完成响应', 0);
        successfulRequestId = record.id;
        break;
      } catch (error) {
        const rejected =
          error instanceof ProviderError &&
          !error.responseStarted &&
          error.status >= 400 &&
          error.status < 500;
        if (partial) {
          const object = store.object(
            stable({ requestId: record.id, partialText: partial, completed: false }),
          );
          store.put('requests', {
            ...store.require<RequestRecord>('requests', record.id),
            manifest: {
              ...store.require<RequestRecord>('requests', record.id).manifest,
              partialText: null,
              interruptedRef: object.objectRef,
            },
          });
        } else {
          const current = store.requestMetadata(record.id);
          store.put('requests', { ...current, manifest: { ...current.manifest, partialText: null } });
        }
        if (error instanceof ProviderError && error.details) {
          const current = store.require<RequestRecord>('requests', record.id);
          store.put('requests', {
            ...current,
            manifest: { ...current.manifest, providerError: error.details },
          });
        }
        // A failed response can still include a complete, validated provider usage receipt.
        this.kernel.settle(
          record.id,
          error instanceof ProviderError ? (error.usage ?? null) : null,
          error instanceof Error ? error.message : String(error),
          rejected,
        );
        const usage = error instanceof ProviderError ? error.usage : null;
        metrics = this.publishContext(
          task,
          attempt,
          {
            ...metrics,
            phase: 'settled',
            streamingOutputTokens: Buffer.byteLength(partial, 'utf8') * (config.authMode === 'codex' ? 2 : 1),
            observedInputTokens: usage?.inputTotal ?? null,
            observedOutputTokens: usage?.outputTotal ?? null,
          },
          record.id,
        );
        if (signal.aborted) throw error;
        if (!(error instanceof ProviderError) || !error.retryable || retry === 2) throw error;
        const wait = Math.max(error.retryAfterMs, 1000 * 2 ** retry);
        if (wait > 60000) {
          this.waitAtRateLimit(task, {
            resumeAt: Date.now() + wait,
            source: 'provider',
            logicalId,
            retry: retry + 1,
          });
          return;
        }
        await delay(wait, signal);
      }
    }
    if (!complete) return;
    const completed = complete;
    const assistantMessage = store.tx(() => {
      this.kernel.settle(successfulRequestId!, completed.usage);
      metrics = this.publishContext(
        task,
        attempt,
        {
          ...metrics,
          phase: 'settled',
          streamingOutputTokens:
            Buffer.byteLength(completed.text, 'utf8') * (config.authMode === 'codex' ? 2 : 1),
          observedInputTokens: completed.usage?.inputTotal ?? null,
          observedOutputTokens: completed.usage?.outputTotal ?? null,
        },
        successfulRequestId!,
      );
      const message = this.kernel.appendMessage(task, 'assistant', completed.text, {
        requestId: successfulRequestId!,
        calls: completed.calls,
        native: completed.native,
        reasoningContent: completed.reasoningContent,
        providerKind: config.kind,
      });
      const current = store.require<Task>('tasks', task.id);
      if (current.rateLimit) store.put('tasks', { ...current, rateLimit: undefined });
      attempt = store.put('attempts', {
        ...store.require<Attempt>('attempts', attempt.id),
        steps: attempt.steps + 1,
      });
      this.kernel.checkpoint(attempt.id);
      const record = store.require<RequestRecord>('requests', successfulRequestId!);
      store.put('requests', {
        ...record,
        manifest: { ...record.manifest, partialStreamRef: null, partialText: null },
      });
      return message;
    });
    if (typeof completed.reasoningContent === 'string') {
      try {
        store.completeRequestReasoning(successfulRequestId!, completed.reasoningContent);
      } catch {
        /* The canonical Message still supports explicit historical reads. */
      }
    }
    signal.throwIfAborted();
    if (completed.calls.length)
      await this.executeCalls(task, attempt, completed.calls, signal, assistantMessage.id);
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
        store.require<Task>('tasks', task.id).phase === 'planning'
          ? '请使用 planning 阶段的工具：关键需求缺口用 clarify，需求明确后用 propose_plan。普通文本不改变完成状态。'
          : '当前已授权任务应继续执行：自行选择下一项可用工具，常规实现、修复和验证无需再确认；只有影响目标、授权或验收且无法自行查明的缺口才用 clarify。完成后提供真实产物证据并 submit_result；普通文本不改变完成状态。',
        { purpose: 'runtime_notice' },
      );
    }
    task = store.require('tasks', task.id);
    if (task.status === 'RUNNING') this.kernel.updateTask(task, 'READY');
    this.kernel.checkpoint(attempt.id);
  }
  private rateLimitResumeAt(task: Task) {
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
  private waitAtRateLimit(task: Task, rateLimit: NonNullable<Task['rateLimit']>) {
    this.kernel.store.tx(() => {
      const current = this.kernel.store.require<Task>('tasks', task.id);
      if (current.status !== 'RUNNING') return;
      const updated = this.kernel.updateTask(current, 'RUNNING', { rateLimit });
      this.kernel.wait(updated, 'rate_limit');
    });
  }
  private waitAtLimit(task: Task, code: string, message: string) {
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
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
