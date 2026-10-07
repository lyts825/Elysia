import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AppError,
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
      prompt('workspace') +
      '\n\n' +
      prompt(task.spec.role) +
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
    projectDirectory: store.require<Project>('projects', run.projectId).workspaceRoot,
    baseline: task.baseline,
    accessibleArtifacts: store
      .all<Artifact>('artifacts', run.id)
      .filter((a) => a.verified || a.taskId === task.id)
      .map((a) => ({ id: a.id, name: a.name, hash: a.hash, taskId: a.taskId })),
    children: store
      .all<Task>('tasks', run.id)
      .filter((t) => t.parentTaskId === task.id)
      .filter((t) => t.contractVersion === run.contract.version)
      .map((t) => ({ id: t.id, key: t.spec.key, status: t.status, required: t.spec.required })),
  });
  let history = store.all<Message>('messages', run.id).filter((m) => m.sessionId === agent.sessionId);
  validatePairs(history);
  const originalHash = hash(stable(history));
  let summaryRef: string | null = null;
  const estimate = (items: Message[]) =>
    (provider.authMode === 'codex' ? 16384 : 0) +
    Buffer.byteLength(system + taskText + stable(tools) + stable(items), 'utf8') *
      (provider.authMode === 'codex' ? 2 : 1); // Codex 包含运行时指令与 JSON 转义，使用保守额外预留。
  const effective = provider.contextLimit - provider.outputLimit - 2048;
  if (estimate(history) > effective * 0.75 && history.length > 8) {
    let cut = history.length - 8;
    while (cut > 0 && history[cut].role === 'tool') cut--;
    const older = history.slice(0, cut);
    if (older.length) {
      const summary = older.map((m) => ({
        role: m.role,
        text: m.text.slice(0, 900),
        calls: m.calls?.map((c) => ({ id: c.id, name: c.name })),
        callId: m.callId,
      }));
      const originalRef = store.object(stable(older));
      const object = store.object(stable({ version: 1, originalRef, summary }));
      summaryRef = object.objectRef;
      history = [
        {
          id: 'summary',
          revision: 0,
          runId: run.id,
          sessionId: agent.sessionId,
          ordinal: 0,
          role: 'user',
          text: '已结束阶段的版本化摘要（原始资料引用 ' + originalRef.objectRef + '）：' + stable(summary),
        },
        ...history.slice(cut),
      ];
      validatePairs(history);
    }
  }
  const estimatedTokens = estimate(history);
  if (estimatedTokens > effective)
    throw new AppError('CONTEXT_LIMIT', '上下文超过有效上限，请缩小资料或显式更换模型');
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
      compilerVersion: '2',
      promptVersion: '2',
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
      cacheParameters: provider.cache.parameters,
      estimatedTokens,
      localSnapshotReuse: snapshots.length,
      sessionContinuation: history.length > 0,
    },
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
