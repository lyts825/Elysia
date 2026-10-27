/** 执行工具调用并重放待处理调用。 */
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
  /**
   * 在执行器共享工具槽中调用网关，assistantMessageId 绑定产生调用的持久助手消息。
   * 普通校验错误转成模型可读的恢复提示；预算、取消及副作用待核验则抛出中断当前步骤，
   * 不能作为普通工具失败让模型立即再试。
   */
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
      if (e instanceof AppError && e.code === 'TOOL_REVIEW_CAPACITY' && !signal.aborted) {
        this.kernel.store.tx(() => {
          const current = this.kernel.store.require<Task>('tasks', task.id);
          if (current.status !== 'RUNNING') return;
          const updated = this.kernel.updateTask(current, 'RUNNING', {
            rateLimit: { source: 'account', resumeAt: Date.now() + 1000 },
          });
          this.kernel.wait(updated, 'rate_limit');
        });
        throw e;
      }
      if (
        (e instanceof AppError && /BUDGET|CONTEXT_LIMIT|ACCOUNT_TOKEN_LIMIT/.test(e.code)) ||
        signal.aborted ||
        this.kernel.store.require<Task>('tasks', task.id).waitReason === 'verification'
      )
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
  /**
   * 执行同一轮工具调用并按原始顺序保存结果，随后记录无进展失败和检查点。
   * 仅当每个工具策略都显式允许并行时才并发执行；未知工具保守串行。
   * 并行分支等待全部执行收束，再按模型顺序写结果，保证上下文中的调用/结果配对稳定。
   */
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
    // 只有所有调用都明确允许并行时才并发；否则保留原顺序及其副作用。
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
      // 即使并发完成顺序不同，也按模型给出的顺序写入结果。
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
  /**
   * 根据工具、规范化参数和错误码识别重复的确定性失败。
   * 进展指纹改变会重置计数；重复失败先通知模型，再在仍无进展时暂停分支。
   */
  private observeToolFailures(
    task: Task,
    outcomes: { call: ToolCall; result: unknown }[],
    assistantMessageId?: string,
  ) {
    // Only known, non-transient validation/authorization failures count. Polls, provider
    // limits, unknown side effects and generic I/O errors must keep their own recovery rules.
    const deterministic = new Set([
      'TOOL_REVIEW_DENIED',
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
        // 将实际领域状态和有进展的成功操作纳入指纹；单纯 READY/RUNNING 轮转不能重置失败计数。
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
          `Runtime notice: ${repeated.tool} has repeatedly returned the deterministic error ${repeated.code} without relevant state progress. Follow the latest recovery guidance to address the cause or use another available capability. Further calls under the same conditions will pause this branch. The tasks below are provided only to check ownership; wait using direct-child task IDs only: ` +
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
  /**
   * 从持久消息找出尚未配对结果的调用，并交回同一网关路径核验/重放。
   * 重放不是无条件重跑；网关会复用 DONE/FAILED 操作，对 UNCERTAIN 保持人工核验。
   */
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
