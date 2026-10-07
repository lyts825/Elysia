import {
  AppError,
  type Agent,
  type Task,
  type Run,
  type Attempt,
  type RequestRecord,
  type ToolCall,
  type Operation,
  type Project,
} from '../../contracts/src/index.js';
import { id, stable } from '../../storage/src/index.js';
import { Kernel } from '../../kernel/src/index.js';
import { ToolGateway } from '../../tools/src/index.js';
import { compileContext, requestDifference } from '../../context/src/index.js';
import {
  NativeProvider,
  ProviderError,
  type ProviderAdapter,
  type ProviderEvent,
} from '../../providers/src/index.js';
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
  private ticking = false;
  private toolActive = 0;
  onDelta: (runId: string, taskId: string, text: string, requestId: string, offset: number) => void =
    () => {};
  adapterFactory: (agent: Agent) => ProviderAdapter = (agent) => new NativeProvider(agent.providerBinding);
  constructor(public kernel: Kernel) {
    this.gateway = new ToolGateway(kernel);
  }
  start() {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), 300);
    void this.tick();
  }
  resume(_runId: string) {
    void this.tick();
  }
  async interrupt(runId: string, taskId?: string) {
    const tasks = taskId
      ? new Set(this.kernel.descendants(this.kernel.store.require<Task>('tasks', taskId)).map((t) => t.id))
      : undefined;
    const active = [...this.active.entries()].filter(
      ([key, value]) => value.runId === runId && (!tasks || tasks.has(key)),
    );
    for (const [, value] of active) value.controller.abort();
    await this.gateway.processes.cancel(
      tasks ?? new Set(this.kernel.store.all<Task>('tasks', runId).map((t) => t.id)),
    );
    await Promise.allSettled(active.map(([, value]) => value.promise));
  }
  async dispose() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const run of this.kernel.store
      .all<Run>('runs')
      .filter((r) => ['READY', 'RUNNING'].includes(r.status)))
      this.kernel.action(run.id, 'pause');
    for (const value of this.active.values()) value.controller.abort();
    await this.gateway.processes.cancel();
    await Promise.allSettled([...this.active.values()].map((v) => v.promise));
  }
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (let run of this.kernel.store
        .all<Run>('runs')
        .filter((r) => !r.archived && !['DONE', 'CANCELLED'].includes(r.status))) {
        if (run.projectId && this.kernel.store.require<Project>('projects', run.projectId).archived) continue;
        if (
          ![...this.active.values()].some((a) => a.runId === run.id) &&
          (run.kind === 'chat' ||
            (!this.kernel.store
              .all<Task>('tasks', run.id)
              .some(
                (t) =>
                  t.status === 'VERIFYING' || (t.status === 'WAITING' && t.waitReason === 'verification'),
              ) &&
              !this.kernel.store
                .all<RequestRecord>('requests', run.id)
                .some((r) => ['RESERVED', 'UNKNOWN'].includes(r.status)) &&
              !this.kernel.store
                .all<Operation>('tool_operations', run.id)
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
            .all<Task>('tasks', run.id)
            .filter((t) => ['READY', 'RUNNING'].includes(t.status)))
            this.waitAtLimit(t, 'TIME_BUDGET', '运行时间达到上限');
          await this.interrupt(run.id);
          continue;
        }
        this.kernel.wakeChildren(run.id);
      }
      const tasks = this.kernel.store.all<Task>('tasks').filter((t) => t.status === 'READY');
      for (const task of tasks) {
        if (this.active.size >= 4) break;
        if (this.active.has(task.id)) continue;
        const run = this.kernel.store.require<Run>('runs', task.runId);
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
        const promise = this.step(task, controller.signal)
          .catch((error) => this.fail(task, error))
          .finally(() => this.active.delete(task.id));
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
  async tool(task: Task, attempt: Attempt, call: ToolCall, signal: AbortSignal) {
    const limit = this.kernel.store.require<Run>('runs', task.runId).limits.toolConcurrency;
    while (this.toolActive >= limit) {
      await delay(20, signal);
    }
    this.toolActive++;
    try {
      return await this.gateway.call(this.kernel.store.require('tasks', task.id), attempt, call, signal);
    } catch (e) {
      if (signal.aborted || this.kernel.store.require<Task>('tasks', task.id).waitReason === 'verification')
        throw e;
      return {
        error: e instanceof Error ? e.message : String(e),
        code: e instanceof AppError ? e.code : 'TOOL_ERROR',
      };
    } finally {
      this.toolActive--;
    }
  }
  async executeCalls(task: Task, attempt: Attempt, calls: ToolCall[], signal: AbortSignal) {
    const orchestration = new Set([
      'write',
      'apply_patch',
      'clarify',
      'propose_plan',
      'spawn_task',
      'join_tasks',
      'submit_result',
      'integrate_worktrees',
    ]);
    if (calls.some((c) => orchestration.has(c.name))) {
      for (const call of calls) {
        const result = await this.tool(task, attempt, call, signal);
        this.kernel.store.tx(() =>
          this.kernel.appendMessage(task, 'tool', stable(result), { callId: call.id }),
        );
      }
    } else {
      const results = await Promise.allSettled(calls.map((call) => this.tool(task, attempt, call, signal)));
      for (let i = 0; i < calls.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled')
          this.kernel.store.tx(() =>
            this.kernel.appendMessage(task, 'tool', stable(r.value), { callId: calls[i].id }),
          );
        else throw r.reason;
      }
    }
    this.kernel.checkpoint(attempt.id);
  }
  async replayPending(task: Task, attempt: Attempt, signal: AbortSignal) {
    const history = this.kernel.history(task),
      resolved = new Set(history.filter((m) => m.role === 'tool').map((m) => m.callId));
    const calls = history.flatMap((m) => m.calls ?? []).filter((c) => !resolved.has(c.id));
    if (calls.length) await this.executeCalls(task, attempt, calls, signal);
  }
  async step(task: Task, signal: AbortSignal) {
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
    const run = store.require<Run>('runs', task.runId);
    if (attempt.steps >= run.limits.maxSteps) {
      this.waitAtLimit(task, 'STEP_LIMIT', '运行步骤达到上限');
      return;
    }
    const agent = store.require<Agent>('agents', task.agentId),
      config = agent.providerBinding;
    const context = compileContext(store, task, this.gateway.definitions(task)),
      adapter = this.adapterFactory(agent),
      request = adapter.compile(context);
    const previous = store
      .all<RequestRecord>('requests', run.id)
      .filter((r) => r.taskId === task.id)
      .at(-1);
    context.manifest.difference = requestDifference(previous?.manifest, context.manifest);
    const continuation =
      cooldown?.logicalId &&
      Number.isInteger(cooldown.retry) &&
      cooldown.retry! >= 0 &&
      cooldown.retry! <= 2 &&
      (cooldown.retry === 0 ||
        store
          .all<RequestRecord>('requests', run.id)
          .some((r) => r.logicalId === cooldown.logicalId && r.attemptId === attempt.id));
    const logicalId = continuation ? cooldown!.logicalId! : id();
    const firstRetry = continuation
      ? Math.max(
          cooldown!.retry!,
          store
            .all<RequestRecord>('requests', run.id)
            .filter((record) => record.logicalId === logicalId && record.attemptId === attempt.id).length,
        )
      : 0;
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
      const accountRequests = store
        .all<RequestRecord>('requests')
        .filter((r) => r.providerBinding.account === config.account && r.startedAt > Date.now() - 60000);
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
      store.put('requests', {
        ...record,
        manifest: { ...context.manifest, partialText: '', partialStreamRef: null },
      });
      let partial = '';
      try {
        for await (const event of adapter.stream(request, signal)) {
          if (event.type === 'delta') {
            partial += event.text;
            const current = store.require<RequestRecord>('requests', record.id);
            store.put('requests', { ...current, manifest: { ...current.manifest, partialText: partial } });
            this.onDelta(run.id, task.id, event.text, record.id, partial.length - event.text.length);
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
            manifest: { ...context.manifest, partialText: null, interruptedRef: object.objectRef },
          });
        }
        if (error instanceof ProviderError && error.details) {
          const current = store.require<RequestRecord>('requests', record.id);
          store.put('requests', {
            ...current,
            manifest: { ...current.manifest, providerError: error.details },
          });
        }
        this.kernel.settle(record.id, null, error instanceof Error ? error.message : String(error), rejected);
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
    store.tx(() => {
      this.kernel.settle(successfulRequestId!, completed.usage);
      this.kernel.appendMessage(task, 'assistant', completed.text, {
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
    });
    signal.throwIfAborted();
    if (completed.calls.length) await this.executeCalls(task, attempt, completed.calls, signal);
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
        '请使用本阶段的工具：planning 需 clarify 或 propose_plan；executing 需提供产物证据并 submit_result。普通文本不改变完成状态。',
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
    this.kernel.store.tx(() => {
      const store = this.kernel.store;
      const run = store.require<Run>('runs', runId);
      if (
        run.archived ||
        (!['READY', 'RUNNING'].includes(run.status) &&
          !(run.status === 'WAITING' && run.reason === 'rate_limit')) ||
        (run.projectId && store.require<Project>('projects', run.projectId).archived)
      )
        return;
      for (const task of store.all<Task>('tasks', run.id)) {
        const resumeAt = this.rateLimitResumeAt(task);
        if (resumeAt === undefined || resumeAt > Date.now() || this.active.has(task.id)) continue;
        if (task.status === 'WAITING' && task.waitReason === 'rate_limit')
          this.kernel.updateTask(task, 'READY', { waitReason: undefined });
      }
      if (
        run.status === 'WAITING' &&
        run.reason === 'rate_limit' &&
        store.all<Task>('tasks', run.id).some((task) => {
          const resumeAt = this.rateLimitResumeAt(task);
          return (
            task.status === 'READY' &&
            resumeAt !== undefined &&
            resumeAt <= Date.now() &&
            !this.active.has(task.id) &&
            this.kernel.dependencies(task).every((key) => store.require<Task>('tasks', key).status === 'DONE')
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
