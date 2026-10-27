/* 提供 useContextPreview React Hook 使用的状态与处理逻辑。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ContextRuntimeMetrics,
  effectiveContextWindowTokens,
  minimumContextWindowTokens,
  type Agent,
  type ContextProjection,
  type ContextSnapshot,
} from '../../../packages/contracts/src/index';
import type { SurfaceClient } from './api';

function validatedMetrics(agent: Agent, value: unknown) {
  const parsed = ContextRuntimeMetrics.safeParse(value);
  if (!parsed.success) return;
  const metrics = parsed.data,
    policy = agent.contextPolicy || { mode: 'managed' as const };
  const window = effectiveContextWindowTokens(agent),
    runtimeReserve = agent.providerBinding.authMode === 'codex' ? 16384 : 0;
  if (
    metrics.agentId !== agent.id ||
    metrics.taskId !== agent.taskId ||
    metrics.sessionId !== agent.sessionId ||
    metrics.agentRevision < (agent.contextPolicyRevision || 0) ||
    metrics.providerLimit !== agent.providerBinding.contextLimit ||
    metrics.windowTokens !== window ||
    metrics.outputReserveTokens !== agent.providerBinding.outputLimit ||
    metrics.runtimeReserveTokens !== runtimeReserve ||
    metrics.inputBudgetTokens !== Math.max(0, window - agent.providerBinding.outputLimit - 2048) ||
    metrics.policy.mode !== policy.mode ||
    metrics.policy.windowTokens !== policy.windowTokens ||
    !Number.isFinite(Date.parse(metrics.updatedAt))
  )
    return;
  return metrics;
}
export function contextFromMetrics(agent: Agent, value: unknown): ContextProjection | undefined {
  const metrics = validatedMetrics(agent, value);
  if (!metrics) return;
  return {
    agentId: agent.id,
    taskId: agent.taskId,
    agentRevision: agent.revision,
    parentAgentId: agent.parentAgentId,
    policy: agent.contextPolicy || { mode: 'managed' },
    windowTokens: metrics.windowTokens,
    providerLimit: metrics.providerLimit,
    outputReserveTokens: metrics.outputReserveTokens,
    safetyReserveTokens: metrics.safetyReserveTokens,
    runtimeReserveTokens: metrics.runtimeReserveTokens,
    inputBudgetTokens: metrics.inputBudgetTokens,
    minimumWindowTokens: Math.max(
      minimumContextWindowTokens(agent.providerBinding),
      metrics.minimumWindowTokens,
    ),
    estimatedInputTokens: metrics.estimatedInputTokens,
    streamingOutputTokens: metrics.streamingOutputTokens,
    observedInputTokens: metrics.observedInputTokens,
    observedOutputTokens: metrics.observedOutputTokens,
    remainingInputTokens: Math.max(0, metrics.inputBudgetTokens - metrics.estimatedInputTokens),
    usageRatio: metrics.inputBudgetTokens ? metrics.estimatedInputTokens / metrics.inputBudgetTokens : null,
    compression: metrics.compression,
    metrics,
    updatedAt: metrics.updatedAt,
    safeToConfigure: false,
    configureReason: '打开上下文设置后核验可调整状态。',
    assignedByAgentId: agent.contextAssignedByAgentId || null,
  };
}

/** One agent, frozen binding, and live metrics; full settings are a separate explicit read. */
export function useContextPreview(
  client: SurfaceClient,
  runId: string,
  agent: Agent | undefined,
  enabled: boolean,
) {
  const [projection, setProjection] = useState<ContextProjection>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const selected = useRef({ runId, agent, enabled });
  selected.current = { runId, agent, enabled };
  const controller = useRef<AbortController | undefined>(undefined);
  const epoch = useRef(0);
  const liveRevision = useRef(0);
  const previousIdentity = useRef('');
  const identity = JSON.stringify([
    runId,
    agent?.id,
    agent?.sessionId,
    agent?.contextPolicyRevision,
    agent?.contextPolicy,
    agent?.providerBinding,
  ]);
  const request = useCallback(async () => {
    const target = selected.current;
    if (!target.enabled || !target.agent) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++epoch.current;
    const liveAtRequest = liveRevision.current;
    setLoading(true);
    setError('');
    try {
      const result = await client.api<ContextSnapshot>(
        '/runs/' + target.runId + '/context-preview?agentId=' + target.agent.id,
        undefined,
        undefined,
        abort.signal,
      );
      if (
        abort.signal.aborted ||
        current !== epoch.current ||
        selected.current.runId !== target.runId ||
        selected.current.agent?.id !== target.agent.id
      )
        return;
      const incoming =
        result.runId === target.runId ? result.agents.find((p) => p.agentId === target.agent!.id) : undefined;
      if (!incoming) throw Error('此执行通道尚未提供上下文用量。');
      setProjection((old) =>
        old?.updatedAt &&
        ((incoming.updatedAt && Date.parse(old.updatedAt) > Date.parse(incoming.updatedAt)) ||
          (liveRevision.current !== liveAtRequest &&
            (!incoming.updatedAt || Date.parse(old.updatedAt) === Date.parse(incoming.updatedAt))))
          ? old
          : incoming,
      );
    } catch (issue) {
      if (!abort.signal.aborted && current === epoch.current)
        setError(issue instanceof Error ? issue.message : '上下文读取失败，请重试。');
    } finally {
      if (!abort.signal.aborted && current === epoch.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    if (previousIdentity.current !== identity) setProjection(undefined);
    previousIdentity.current = identity;
    setError('');
    setLoading(false);
    void request();
    return () => {
      epoch.current++;
      controller.current?.abort();
    };
  }, [identity, enabled, request]);
  const update = useCallback((value: unknown) => {
    const { agent, enabled } = selected.current;
    if (!enabled || !agent) return;
    const incoming = contextFromMetrics(agent, value);
    if (!incoming) return;
    liveRevision.current++;
    setProjection((old) =>
      old?.updatedAt && incoming.updatedAt && Date.parse(old.updatedAt) > Date.parse(incoming.updatedAt)
        ? old
        : incoming,
    );
    setError('');
  }, []);
  return { projection, loading, error, request, update };
}
