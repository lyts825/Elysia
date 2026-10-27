/** 执行模型请求并发布上下文运行指标。 */
import type { Store } from '../../storage/src/index.js';
import type { Kernel } from '../../kernel/src/index.js';
import {
  ContextRuntimeMetrics,
  type Agent,
  type Task,
  type Run,
  type Attempt,
  type RequestRecord,
} from '../../contracts/src/index.js';
import { id, stable } from '../../contracts/src/identity.js';
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderEvent,
  type CompiledContext,
} from '../../contracts/src/model.js';
import type { ReasoningDelta } from '../../contracts/src/reasoning.js';
import { requestDifference } from '../../context/src/request-difference.js';
import type { RunControl } from './scheduler.js';
import { delay } from './async.js';

export interface ModelRequestServices {
  adapterFactory(agent: Agent): ProviderAdapter;
  onDelta(runId: string, taskId: string, text: string, requestId: string, offset: number): void;
  onReasoningDelta(value: ReasoningDelta): void;
}
export class ModelRequestRunner {
  constructor(
    readonly kernel: Kernel<Store>,
    private readonly control: RunControl,
    private readonly services: ModelRequestServices,
  ) {}
  /** 更新上下文指标；提供请求 ID 时，同时保存到该请求清单并发布事件。 */
  publishContext(task: Task, attempt: Attempt, metrics: ContextRuntimeMetrics, recordId?: string) {
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
  /**
   * 执行一次逻辑模型请求，检查账号并发和分钟额度并最多尝试三次。
   * 流式正文先持久化再通知界面；成功后在事务中结算用量并追加助手消息。
   * 限流需要延后调度时返回 undefined，调用方不得将其视为完成响应。
   */
  async run(
    task: Task,
    attempt: Attempt,
    agent: Agent,
    context: CompiledContext,
    metrics: ContextRuntimeMetrics,
    signal: AbortSignal,
  ) {
    const store = this.kernel.store;
    const run = store.require<Run>('runs', task.runId);
    const config = agent.providerBinding,
      cooldown = task.rateLimit;
    const adapter = this.services.adapterFactory(agent),
      request = adapter.compile(context);
    const previous = store.latestTaskRequest(run.id, task.id);
    context.manifest.difference = requestDifference(previous?.manifest, context.manifest);
    // 恢复限流等待时沿用逻辑请求 ID，并以账本记录防止重启后重置重试次数。
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
      if (store.requestLedger({ account: config.account, status: 'RESERVED' }).length >= config.concurrency) {
        this.control.waitAtRateLimit(task, {
          resumeAt: Date.now() + 1000,
          source: 'account',
          logicalId,
          retry,
        });
        return;
      }
      // 用最近一分钟的已结算或预留用量计算 RPM/TPM，缺失用量按预留值计入。
      const accountRequests = store.requestLedger({ account: config.account, since: Date.now() - 60000 });
      const requestTokens = context.estimatedTokens + config.outputLimit;
      if (requestTokens > config.tpm) {
        this.control.waitAtLimit(
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
        this.control.waitAtRateLimit(task, { resumeAt, source: 'account', logicalId, retry });
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
            this.services.onDelta(run.id, task.id, event.text, record.id, partial.length - event.text.length);
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
                  this.services.onReasoningDelta({
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
        // 中断后保留已有正文引用；不把部分文本误认作完整助手回复。
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
        // 短等待在本步内退避；超过一分钟交还调度器，避免长期占用执行槽。
        const wait = Math.max(error.retryAfterMs, 1000 * 2 ** retry);
        if (wait > 60000) {
          this.control.waitAtRateLimit(task, {
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
    return { message: assistantMessage, attempt, completed };
  }
}
