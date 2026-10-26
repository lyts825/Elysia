import { readFileSync } from 'node:fs';
import { AppError, invariant, type Agent, type RequestRecord, type Run } from '../../contracts/src/index.js';
import { ToolReviewDecision, type ToolReviewReceipt } from '../../contracts/src/execution-policy.js';
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderEvent,
  type CompiledContext,
} from '../../contracts/src/model.js';
import { id, stable, now, hash } from '../../contracts/src/identity.js';
import { builtinResourcePath } from '../../context/src/resources.js';
import { PROMPT_VERSION } from '../../context/src/harness.js';
import type { Kernel } from '../../kernel/src/index.js';
import type { Store } from '../../storage/src/index.js';
import type { ToolReviewInput } from '../../tools/src/tool-review.js';

/** A bounded, tool-free request. Usage belongs to the same task and ancestor budgets. */
export class ToolCallReviewer {
  constructor(
    private kernel: Kernel<Store>,
    private adapterFactory: (agent: Agent) => ProviderAdapter,
  ) {}
  async review(input: ToolReviewInput, signal: AbortSignal): Promise<ToolReviewReceipt> {
    const store = this.kernel.store,
      run = store.require<Run>('runs', input.task.runId),
      binding = run.toolReviewBinding;
    invariant(binding, 'TOOL_REVIEW_BINDING', '缺少冻结的审核模型配置');
    signal.throwIfAborted();
    const system = readFileSync(builtinResourcePath('prompts', 'tool-reviewer.md'), 'utf8')
      .replace(/\r\n/g, '\n')
      .trim();
    const task = stable({ context: input.context, tool: input.call.name, args: input.args });
    const tokens =
      Buffer.byteLength(system + task, 'utf8') * (binding.authMode === 'codex' ? 2 : 1) +
      (binding.authMode === 'codex' ? 16384 : 0);
    invariant(
      tokens + binding.outputLimit + 2048 <= binding.contextLimit,
      'CONTEXT_LIMIT',
      '工具审核输入超过审核模型窗口，请缩小本次调用',
    );
    invariant(
      tokens + binding.outputLimit <= binding.tpm,
      'ACCOUNT_TOKEN_LIMIT',
      '单次审核超过审核连接每分钟 Token 上限，请调整配置后新建任务',
    );
    const ledger = store.requestLedger({ account: binding.account, since: Date.now() - 60000 });
    const active = store.requestLedger({ account: binding.account, status: 'RESERVED' });
    if (
      active.length >= binding.concurrency ||
      ledger.length >= binding.rpm ||
      ledger.reduce(
        (sum, r) =>
          sum +
          (r.status === 'RELEASED'
            ? 0
            : (r.usage?.inputTotal ?? r.reservedTokens) + (r.usage?.outputTotal ?? 0)),
        0,
      ) +
        tokens +
        binding.outputLimit >
        binding.tpm
    )
      throw new AppError('TOOL_REVIEW_CAPACITY', '审核模型并发或每分钟额度已满，请稍后重试', true, {
        resumeAt: Date.now() + 1000,
      });
    const context: CompiledContext = {
      system,
      task,
      history: [],
      tools: [],
      estimatedTokens: tokens,
      manifest: {
        purpose: 'tool-review',
        fingerprint: input.fingerprint,
        promptVersion: PROMPT_VERSION,
        reviewerPromptHash: hash(system),
      },
    };
    const agent = store.require<Agent>('agents', input.task.agentId);
    const adapter = this.adapterFactory({ ...agent, providerId: binding.id, providerBinding: binding });
    const request = adapter.compile(context);
    const record = this.kernel.reserve(
      input.task,
      input.attempt,
      binding,
      context.manifest,
      tokens,
      id(),
      'tool-review',
    );
    store.startRequestStream(record.id);
    let completed: Extract<ProviderEvent, { type: 'completed' }> | undefined,
      partial = '';
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    try {
      for await (const event of adapter.stream(request, bounded)) {
        bounded.throwIfAborted();
        if (event.type === 'delta') {
          invariant(
            Buffer.byteLength(partial + event.text, 'utf8') <= 12000,
            'TOOL_REVIEW_RESPONSE',
            '审核响应过长',
          );
          store.appendRequestText(record.id, event.text, partial.length);
          partial += event.text;
        } else if (event.type === 'completed') {
          completed = event;
          break;
        }
      }
      bounded.throwIfAborted();
      if (completed) {
        const response = store.object(
          stable({
            text: completed.text.slice(0, 12000),
            truncated: completed.text.length > 12000,
            toolCallCount: completed.calls.length,
          }),
        );
        const current = store.require<RequestRecord>('requests', record.id);
        store.put('requests', {
          ...current,
          manifest: { ...current.manifest, reviewResponseRef: response.objectRef },
        });
      }
      invariant(
        completed && completed.calls.length === 0 && Buffer.byteLength(completed.text, 'utf8') <= 12000,
        'TOOL_REVIEW_RESPONSE',
        '审核响应缺失、过长或尝试调用工具',
      );
      // Settle even a malformed decision: the provider has already consumed this request.
      this.kernel.settle(record.id, completed.usage);
      const decision = ToolReviewDecision.parse(JSON.parse(completed.text));
      const receipt: ToolReviewReceipt = {
        ...decision,
        fingerprint: input.fingerprint,
        mode: 'model',
        reviewedAt: now(),
        requestId: record.id,
      };
      const current = store.require<RequestRecord>('requests', record.id);
      store.put('requests', {
        ...current,
        manifest: { ...current.manifest, decision: receipt, partialText: null },
      });
      return receipt;
    } catch (error) {
      this.kernel.settle(
        record.id,
        completed?.usage ?? (error instanceof ProviderError ? error.usage : null),
        error instanceof Error ? error.message : String(error),
        error instanceof ProviderError && !error.responseStarted && error.status >= 400 && error.status < 500,
      );
      if (signal.aborted) throw error;
      throw new AppError(
        'TOOL_REVIEW_FAILED',
        '工具审核未完成，调用未执行：' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
