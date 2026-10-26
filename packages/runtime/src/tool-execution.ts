import type { Store } from '../../storage/src/index.js';
import type { Kernel } from '../../kernel/src/index.js';
import {
  AppError,
  inspectToolCalls,
  type Task,
  type Run,
  type Attempt,
  type ToolCall,
  type Operation,
  type Artifact,
  type Snapshot,
} from '../../contracts/src/index.js';
import { hash, id, stable } from '../../contracts/src/identity.js';
import type { ToolGateway } from '../../tools/src/index.js';
import { toolRecovery } from './tool-recovery.js';
import { delay } from './async.js';

export class ToolExecutionService {
  private toolActive = 0;
  constructor(
    readonly kernel: Kernel<Store>,
    readonly gateway: ToolGateway,
  ) {}
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
    if (calls.some((c) => this.gateway.toolPolicy(c.name)?.serial !== false)) {
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
      'PEER_REVIEW_CRITERIA',
      'PEER_REVIEW_EVIDENCE',
      'PEER_REVIEW_UNCHANGED',
      'PEER_REVIEW_TOO_LARGE',
      'PEER_REVIEW_MODEL_CONFLICT',
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
            .filter((o) => o.status === 'DONE' && this.gateway.toolPolicy(o.name)?.progress)
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
          `运行提醒：${repeated.tool} 已重复产生确定性错误 ${repeated.code}，相关状态没有进展。按最新 recovery 修正原因或改用已开放能力；相同条件下继续调用将暂停该分支。下列任务仅供核对归属，等待只能使用直属子任务 ID：` +
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
}
