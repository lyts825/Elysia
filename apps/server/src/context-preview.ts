/**
 * 提供任务上下文预览的读取服务和接口。
 * 复用实际上下文编译规则解释将发送的资料；预览不发模型请求、不消耗执行预算或批准历史替换。
 * EN: Provides task-context preview reads and endpoints. Reuses actual context compilation to explain prospective input without model requests, execution-budget use or history-replacement approval.
 */
import { contextWindowBudget } from '../../../packages/contracts/src/context-window.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  ContextRuntimeMetrics,
  CONTEXT_SAFETY_TOKENS,
  minimumContextWindowTokens,
  type Run,
  type Agent,
  type ContextSnapshot,
} from '../../../packages/contracts/src/index.js';
import { stable, type Store } from '../../../packages/storage/src/index.js';

const previewReason = '实时预览仅供查看，打开上下文设置后检查是否可修改';
const legacyBytes = 65536;
type Candidate = { seq: number; payload: string; compressed_bytes: number | null; footer: Uint8Array | null };

/**
 * 仅含数量和冻结绑定；配置权限仍需要显式完整读取。 从运行和代理记录构造上下文快照，限制代理必须属于指定运行。
 * EN: Counts and frozen bindings only. Configuration permission remains an explicit full read. Builds context snapshots from run and agent records, requiring the agent to belong to the selected run.
 */
export class ContextPreviewReads {
  /**
   * 绑定只读上下文预览使用的存储；具体会话和编译资料由各次预览读取。
   * EN: Binds storage for context previews; each preview resolves its own session and compilation data.
   */
  constructor(private store: Store) {}
  /**
   * 获取单代理的轻量展示快照：只接受与当前会话、窗口策略、冻结模型及版本一致的最近指标。 旧事件正文仅在压缩/原始长度可证明有界时回读；找不到有效指标时返回未知量而非估造数据。 预览永远 safeToConfigure=false，完整上下文配置仍须走独立读取和执行边界检查。
   * EN: Returns a lightweight agent view using only metrics matching the current session, window policy, frozen model, and versions. Legacy bodies are read only when compressed/raw lengths are provably bounded. Missing metrics remain unknown. Previews always set safeToConfigure=false; configuration requires an independent full read and execution checks.
   */
  snapshot(runId: string, agentId?: string): ContextSnapshot {
    const run = this.store.require<Run>('runs', runId);
    const agent = this.store.require<Agent>('agents', agentId ?? run.coordinatorAgentId);
    if (agent.runId !== run.id) throw new AppError('NOT_FOUND', '代理不属于当前会话', false, null, 404);
    if (run.execution?.kind === 'docker-agent') return { runId, runRevision: run.revision, agents: [] };
    const provider = agent.providerBinding;
    const policy = agent.contextPolicy ?? { mode: 'managed' as const };
    const { windowTokens, inputBudgetTokens, runtimeReserveTokens } = contextWindowBudget(agent);
    const candidates = this.store.db
      .prepare(
        `SELECT seq,substr(payload,1,65537) payload,length(content) compressed_bytes,
      substr(content,-4) footer FROM events WHERE run_id=? AND task_id=? AND type='context.updated'
      ORDER BY seq DESC LIMIT 64`,
      )
      .all(runId, agent.taskId) as Candidate[];
    let metrics: ContextRuntimeMetrics | null = null;
    for (const row of candidates) {
      /**
       * 优先使用专门的轻量投影；历史正文不可控时跳过该候选，继续查更早的可核验指标。
       * EN: Prefers dedicated lightweight projections. Unbounded historical bodies are skipped while searching older verifiable metrics.
       */
      let payload: any;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        /**
         * 在下方读取有界旧版正文。
         * EN: Read the bounded legacy body below.
         */
      }
      let value = payload?.contextPreviewVersion === 1 ? payload.metrics : payload;
      if (payload?.contextPreviewVersion !== 1 && row.compressed_bytes !== null) {
        if (
          row.compressed_bytes > legacyBytes ||
          !row.footer ||
          row.footer.length !== 4 ||
          Buffer.from(row.footer).readUInt32LE() > legacyBytes
        )
          continue;
        try {
          value = this.store.events(runId, row.seq - 1, {
            taskId: agent.taskId,
            type: 'context.updated',
            limit: 1,
          })[0]?.payload;
        } catch {
          continue;
        }
      } else if (payload?.contextPreviewVersion !== 1 && payload?.externalPayloadRef) {
        const object = this.store.db
          .prepare('SELECT raw_size FROM compressed_objects WHERE ref=?')
          .get(payload.externalPayloadRef) as { raw_size: number } | undefined;
        if (!object || object.raw_size > legacyBytes) continue;
        try {
          value = this.store.events(runId, row.seq - 1, {
            taskId: agent.taskId,
            type: 'context.updated',
            limit: 1,
          })[0]?.payload;
        } catch {
          continue;
        }
      }
      const parsed = ContextRuntimeMetrics.safeParse(value);
      if (!parsed.success) continue;
      const current = parsed.data;
      if (
        current.agentId !== agent.id ||
        current.taskId !== agent.taskId ||
        current.sessionId !== agent.sessionId ||
        current.agentRevision < (agent.contextPolicyRevision ?? 0) ||
        current.agentRevision > agent.revision ||
        stable(current.policy) !== stable(policy) ||
        current.windowTokens !== windowTokens ||
        current.providerLimit !== provider.contextLimit ||
        current.outputReserveTokens !== provider.outputLimit ||
        current.runtimeReserveTokens !== runtimeReserveTokens ||
        current.inputBudgetTokens !== inputBudgetTokens
      )
        continue;
      metrics = current;
      break;
    }
    const estimatedInputTokens = metrics?.estimatedInputTokens ?? null;
    return {
      runId,
      runRevision: run.revision,
      agents: [
        {
          agentId: agent.id,
          taskId: agent.taskId,
          agentRevision: agent.revision,
          parentAgentId: agent.parentAgentId,
          policy,
          windowTokens,
          providerLimit: provider.contextLimit,
          outputReserveTokens: provider.outputLimit,
          safetyReserveTokens: CONTEXT_SAFETY_TOKENS,
          runtimeReserveTokens,
          inputBudgetTokens,
          minimumWindowTokens: Math.max(
            minimumContextWindowTokens(provider),
            metrics?.minimumWindowTokens ?? 0,
          ),
          estimatedInputTokens,
          streamingOutputTokens: metrics?.streamingOutputTokens ?? 0,
          observedInputTokens: metrics?.observedInputTokens ?? null,
          observedOutputTokens: metrics?.observedOutputTokens ?? null,
          remainingInputTokens:
            estimatedInputTokens === null ? null : Math.max(0, inputBudgetTokens - estimatedInputTokens),
          usageRatio:
            estimatedInputTokens === null || inputBudgetTokens <= 0
              ? null
              : estimatedInputTokens / inputBudgetTokens,
          compression: metrics?.compression ?? null,
          metrics,
          updatedAt: metrics?.updatedAt ?? null,
          safeToConfigure: false,
          configureReason: previewReason,
          assignedByAgentId: agent.contextAssignedByAgentId ?? null,
        },
      ],
    };
  }
}
/**
 * 注册上下文预览路由，并校验运行和可选代理 ID。
 * EN: Registers context-preview routes and validates run and optional agent IDs.
 */
export function registerContextPreview(app: FastifyInstance, store: Store) {
  const reads = new ContextPreviewReads(store);
  app.get('/api/runs/:id/context-preview', (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { agentId } = z.object({ agentId: z.string().uuid().optional() }).strict().parse(request.query);
    return reads.snapshot(id, agentId);
  });
}
