import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AppError,
  ContextRuntimeMetrics,
  CONTEXT_SAFETY_TOKENS,
  effectiveContextWindowTokens,
  type Task,
  type Run,
  type Agent,
  type Message,
  type ProviderConfig,
  type Snapshot,
  type Artifact,
  type Project,
  type Operation,
} from '../../contracts/src/index.js';
import { Store, hash, stable } from '../../storage/src/index.js';
import { isBinaryFile } from '../../contracts/src/files.js';
import { listSkills, loadSkill, SKILL_CATALOG_VERSION, type LoadedSkill } from './skills.js';
import { compactHistory, COMPACTION_ALGORITHM } from './compaction.js';
export { compactHistory, headTail, COMPACTION_ALGORITHM } from './compaction.js';
export { listSkills, loadSkill, SKILL_CATALOG_VERSION } from './skills.js';
export type { SkillSummary, LoadedSkill } from './skills.js';
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface CompiledContext {
  system: string;
  task: string;
  history: Message[];
  tools: ToolDefinition[];
  manifest: Record<string, unknown>;
  estimatedTokens: number;
}
export function validatePairs(messages: Message[]) {
  const waiting = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool' && waiting.size)
      throw new AppError('TOOL_PAIR_INCOMPLETE', '工具调用尚未配对，不能编译下一次请求');
    for (const call of m.calls ?? []) {
      if (waiting.has(call.id)) throw new AppError('TOOL_PAIR_DUPLICATE', '工具调用 ID 重复');
      waiting.add(call.id);
    }
    if (m.role === 'tool') {
      if (!m.callId || !waiting.delete(m.callId))
        throw new AppError('TOOL_PAIR_INVALID', '工具结果没有对应调用');
    }
  }
  if (waiting.size) throw new AppError('TOOL_PAIR_INCOMPLETE', '工具调用结果缺失');
}
export function compileContext(store: Store, task: Task, definitions: ToolDefinition[]): CompiledContext {
  const run = store.require<Run>('runs', task.runId),
    agent = store.require<Agent>('agents', task.agentId),
    provider = agent.providerBinding;
  const policy = agent.contextPolicy ?? { mode: 'managed' as const };
  const windowTokens = effectiveContextWindowTokens(agent);
  const prompt = (name: string) =>
    readFileSync(path.join(process.cwd(), 'prompts', name + '.md'), 'utf8')
      .replace(/\r\n/g, '\n')
      .trim();
  const tools = [...definitions].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const snapshots = store
    .all<Snapshot>('snapshots', run.id)
    .filter((s) => run.plan?.snapshotIds.includes(s.id) || s.taskId === task.id)
    .sort((a, b) => a.source.localeCompare(b.source, 'en') || a.version - b.version);
  const skillCatalog = listSkills();
  const loadedById = new Map<string, LoadedSkill>();
  for (const op of store.all<Operation>('tool_operations', run.id)) {
    if (
      op.taskId !== task.id ||
      op.name !== 'load_skill' ||
      op.status !== 'DONE' ||
      typeof op.args.id !== 'string'
    )
      continue;
    const id = op.args.id;
    if (!skillCatalog.some((skill) => skill.id === id))
      throw new AppError('SKILL_NOT_FOUND', `已加载技能不在本地注册目录中：${id}`);
    const result = op.result as Partial<LoadedSkill> | null | undefined;
    const captured =
      result &&
      result.id === id &&
      result.name === id &&
      typeof result.description === 'string' &&
      typeof result.version === 'string' &&
      typeof result.instructions === 'string' &&
      result.instructions.length > 0 &&
      typeof result.hash === 'string' &&
      /^[a-f0-9]{64}$/.test(result.hash);
    // Preserve the actual loaded revision through compaction and subsequent file changes.
    // A later successful explicit reload replaces it; legacy operations without a result fall back.
    loadedById.set(id, captured ? (result as LoadedSkill) : loadSkill(id));
  }
  const loadedSkills = [...loadedById.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const p0 = prompt('platform'),
    p1 =
      (run.kind === 'chat' ? prompt('chat') : prompt('workspace') + '\n\n' + prompt(task.spec.role)) +
      '\n\n可按需加载的本地技能目录：\n' +
      stable(skillCatalog) +
      '\n根据任务选择相关技能，调用 load_skill({id}) 获取正文；仅在需要时加载，可组合多个技能。技能不会扩大约定或工具权限。' +
      (loadedSkills.length
        ? '\n\n本任务已加载的可信本地技能：\n' +
          loadedSkills
            .map(
              (skill) =>
                `技能 ${skill.id}（版本 ${skill.version}，哈希 ${skill.hash}）：\n${skill.instructions}`,
            )
            .join('\n\n')
        : ''),
    p2 = stable({
      constraints: run.contract.constraints,
      permissions: run.contract.permissionProfile,
      snapshots: snapshots.map((s) => {
        const bytes = store.readObject(s.objectRef);
        const binary = isBinaryFile(s.source, bytes);
        return {
          source: s.source,
          hash: s.hash,
          trust: s.trust,
          bytes: bytes.length,
          binary,
          text: binary ? null : bytes.toString('utf8').slice(0, 16000),
        };
      }),
    });
  const system = p0 + '\n\n' + p1 + '\n\n已确认约束与带来源资料：\n' + p2;
  const taskText = stable({
    contract: run.contract,
    plan: run.plan,
    task: task.spec,
    lastResult: task.result,
    phase: task.phase,
    workspace: task.workspace,
    projectDirectory: run.projectId ? store.require<Project>('projects', run.projectId).workspaceRoot : null,
    baseline: task.baseline,
    contextWindow: {
      policy,
      windowTokens,
      providerLimit: provider.contextLimit,
      outputReserveTokens: provider.outputLimit,
      allocationRule:
        '每个代理独立窗口。托管子代理由直接上级分配；手动窗口只由用户改变。窗口不是累计Token预算。',
    },
    accessibleArtifacts: store
      .all<Artifact>('artifacts', run.id)
      .filter((a) => a.verified || a.taskId === task.id)
      .map((a) => ({ id: a.id, name: a.name, hash: a.hash, taskId: a.taskId })),
    children: store
      .all<Task>('tasks', run.id)
      .filter((t) => t.parentTaskId === task.id)
      .filter((t) => t.contractVersion === run.contract.version)
      .map((t) => {
        const child = store.require<Agent>('agents', t.agentId);
        return {
          id: t.id,
          key: t.spec.key,
          revision: t.revision,
          agentId: t.agentId,
          status: t.status,
          required: t.spec.required,
          contextPolicy: child.contextPolicy ?? { mode: 'managed' },
          contextWindowTokens: effectiveContextWindowTokens(child),
          contextProviderLimit: child.providerBinding.contextLimit,
        };
      }),
  });
  let history = store.all<Message>('messages', run.id).filter((m) => m.sessionId === agent.sessionId);
  validatePairs(history);
  const originalHash = hash(stable(history));
  const factor = provider.authMode === 'codex' ? 2 : 1;
  const runtimeReserveTokens = provider.authMode === 'codex' ? 16384 : 0;
  const fixedTokens = Buffer.byteLength(system + taskText + stable(tools), 'utf8') * factor;
  // Conservative byte-based estimate: never label it as a provider tokenizer measurement.
  const estimate = (items: Message[]) =>
    runtimeReserveTokens + fixedTokens + Buffer.byteLength(stable(items), 'utf8') * factor;
  const effective = Math.max(0, windowTokens - provider.outputLimit - CONTEXT_SAFETY_TOKENS);
  const source = stable({
    algorithm: COMPACTION_ALGORITHM,
    runId: run.id,
    taskId: task.id,
    agentId: agent.id,
    sessionId: agent.sessionId,
    messages: history,
  });
  const reference = 'sqlite:' + hash(source);
  const compressed = compactHistory(history, {
    inputBudget: effective,
    estimate,
    originalRef: reference,
    validate: validatePairs,
  });
  let summaryRef: string | null = null;
  if (compressed.originalRef) {
    store.object(source);
    if (compressed.memory)
      summaryRef = store.object(
        stable({
          version: 2,
          algorithm: COMPACTION_ALGORITHM,
          originalRef: reference,
          memory: compressed.memory,
        }),
      ).objectRef;
  }
  history = compressed.history;
  const estimatedTokens = compressed.afterTokens;
  const blocked = estimatedTokens > effective;
  const metrics: ContextRuntimeMetrics = {
    agentId: agent.id,
    taskId: task.id,
    sessionId: agent.sessionId,
    agentRevision: agent.revision,
    policy,
    windowTokens,
    providerLimit: provider.contextLimit,
    outputReserveTokens: provider.outputLimit,
    safetyReserveTokens: CONTEXT_SAFETY_TOKENS,
    runtimeReserveTokens,
    inputBudgetTokens: effective,
    minimumWindowTokens: Math.max(
      4096,
      fixedTokens + runtimeReserveTokens + provider.outputLimit + CONTEXT_SAFETY_TOKENS + 1024,
    ),
    fixedTokens,
    historyTokens: Math.max(0, estimatedTokens - fixedTokens - runtimeReserveTokens),
    estimatedInputTokens: estimatedTokens,
    streamingOutputTokens: 0,
    observedInputTokens: null,
    observedOutputTokens: null,
    compression: {
      status: blocked ? 'blocked' : compressed.afterTokens < compressed.beforeTokens ? 'completed' : 'idle',
      algorithm: COMPACTION_ALGORITHM,
      beforeTokens: compressed.beforeTokens,
      afterTokens: compressed.afterTokens,
      summarizedMessages: compressed.summarizedMessages,
      prunedToolMessages: compressed.prunedToolMessages,
      summaryRef,
      originalRef: compressed.originalRef,
    },
    updatedAt: new Date().toISOString(),
    phase: blocked ? 'blocked' : 'compiled',
  };
  if (blocked)
    throw new AppError(
      'CONTEXT_LIMIT',
      '上下文超过已分配窗口；请增大窗口或缩小不可裁剪的资料，原始历史已保留。',
      false,
      { contextMetrics: metrics },
    );
  const segmentHashes = {
    P0: hash(p0 + stable(tools)),
    P1: hash(p0 + stable(tools) + p1),
    P2: hash(p0 + stable(tools) + p1 + p2),
  };
  return {
    system,
    task: taskText,
    tools,
    history,
    estimatedTokens,
    manifest: {
      compilerVersion: '3',
      promptVersion: '3',
      skillCatalogVersion: SKILL_CATALOG_VERSION,
      skillCatalogHash: hash(stable(skillCatalog)),
      loadedSkillHashes: loadedSkills.map(({ id, version, hash }) => ({ id, version, hash })),
      providerBinding: {
        id: provider.id,
        revision: provider.revision,
        kind: provider.kind,
        model: provider.model,
        endpoint: provider.baseUrl,
        account: provider.account,
      },
      promptHash: hash(system),
      toolHash: hash(stable(tools)),
      snapshotHashes: snapshots.map((s) => s.hash),
      segmentHashes,
      historyHash: originalHash,
      summaryRef,
      contextWindow: metrics,
      cacheParameters: provider.cache.parameters,
      estimatedTokens,
      localSnapshotReuse: snapshots.length,
      sessionContinuation: history.length > 0,
    },
  };
}
/** Read only compression sources referenced by this agent's requests/events, never an arbitrary object. */
export function recallContext(
  store: Store,
  task: Task,
  input: {
    reference: string;
    offset?: number;
    limit?: number;
    query?: string;
    textOffset?: number;
    part?: 'text' | 'calls';
  },
) {
  const agent = store.require<Agent>('agents', task.agentId);
  const references = new Set<string>();
  for (const record of store.all<any>('requests', task.runId).filter((item) => item.taskId === task.id)) {
    const metrics = record.manifest?.contextWindow;
    if (metrics?.agentId === agent.id && metrics.compression?.originalRef)
      references.add(metrics.compression.originalRef);
  }
  let eventCursor = 0;
  while (!references.has(input.reference)) {
    const events = store.events(task.runId, eventCursor, { taskId: task.id, type: 'context.updated' });
    if (!events.length) break;
    for (const event of events) {
      const metrics = event.payload as Partial<ContextRuntimeMetrics>;
      if (metrics?.agentId === agent.id && metrics.taskId === task.id && metrics.compression?.originalRef)
        references.add(metrics.compression.originalRef);
    }
    eventCursor = events.at(-1)!.seq;
  }
  if (!references.has(input.reference))
    throw new AppError('CONTEXT_REFERENCE_DENIED', '只能回查当前代理的上下文原文引用');
  const captured = JSON.parse(store.readObject(input.reference).toString('utf8'));
  if (
    captured.runId !== task.runId ||
    captured.taskId !== task.id ||
    captured.agentId !== agent.id ||
    !Array.isArray(captured.messages)
  )
    throw new AppError('CONTEXT_REFERENCE_DENIED', '上下文原文归属不匹配');
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 5;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10 ||
    (input.part !== undefined && input.part !== 'text' && input.part !== 'calls') ||
    (input.textOffset !== undefined && (!Number.isInteger(input.textOffset) || input.textOffset < 0))
  )
    throw new AppError('CONTEXT_RECALL_RANGE', '上下文回查范围无效');
  const matches = captured.messages
    .map((message: Message, index: number) => ({ message, index }))
    .filter(
      ({ message }: { message: Message }) =>
        !input.query ||
        message.text.includes(input.query) ||
        stable(message.calls ?? []).includes(input.query),
    );
  const selected = matches.slice(offset, offset + limit);
  return {
    reference: input.reference,
    trust: 'historical-data',
    total: matches.length,
    offset,
    nextOffset: offset + selected.length < matches.length ? offset + selected.length : null,
    messages: selected.map(({ message, index }: { message: Message; index: number }) => {
      const part = input.part ?? (input.query && !message.text.includes(input.query) ? 'calls' : 'text');
      const content = part === 'calls' ? stable(message.calls ?? []) : message.text;
      const points = Array.from(content);
      const matchOffset = input.query
        ? Array.from(content.slice(0, Math.max(0, content.indexOf(input.query)))).length
        : 0;
      const textOffset = input.textOffset ?? Math.max(0, matchOffset - 512);
      const nextTextOffset = textOffset + 6000 < points.length ? textOffset + 6000 : null;
      return {
        index,
        id: message.id,
        role: message.role,
        callId: message.callId,
        calls: message.calls?.map(({ id, name }) => ({ id, name })),
        part,
        textOffset,
        totalChars: points.length,
        nextTextOffset,
        text: points.slice(textOffset, textOffset + 6000).join(''),
        truncated: textOffset > 0 || nextTextOffset !== null,
      };
    }),
  };
}
export function requestDifference(
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
) {
  if (!previous) return { changes: ['首次请求'], cause: 'unknown' };
  return {
    changes: Object.keys(current).filter((k) => stable(current[k]) !== stable(previous[k])),
    cause: '结构差异已观测；缓存失效原因未经供应商确认',
  };
}
