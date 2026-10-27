/** 提供任务上下文预览的读取服务和接口。 */
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

/** Counts and frozen bindings only. Configuration permission remains an explicit full read. */
/** 从运行和代理记录构造上下文快照，限制代理必须属于指定运行。 */
export class ContextPreviewReads {
  constructor(private store: Store) {}
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
      let payload: any;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        /* Read the bounded legacy body below. */
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
/** 注册上下文预览路由，并校验运行和可选代理 ID。 */
export function registerContextPreview(app: FastifyInstance, store: Store) {
  const reads = new ContextPreviewReads(store);
  app.get('/api/runs/:id/context-preview', (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { agentId } = z.object({ agentId: z.string().uuid().optional() }).strict().parse(request.query);
    return reads.snapshot(id, agentId);
  });
}
