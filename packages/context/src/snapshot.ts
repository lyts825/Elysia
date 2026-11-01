/**
 * 收集编译模型上下文所需的运行、任务和资源快照。
 * 一次采集可变外部状态后深复制给纯编译器，保留实际加载版本和撤销事实。
 *
 * EN: Captures run, task, and resource state needed for model-context compilation.
 * Captures mutable external state once, then copies it into pure compilation while retaining loaded revisions and withdrawals.
 */
import { readFileSync } from 'node:fs';
import { builtinResourcePath } from './resources.js';
import {
  AppError,
  effectiveContextWindowTokens,
  type Task,
  type Run,
  type Agent,
  type Snapshot,
  type Project,
  type Operation,
} from '../../contracts/src/index.js';
import type { Store } from '../../storage/src/index.js';
import { isBinaryFile } from '../../contracts/src/files.js';
import { listSkills, loadSkill, SKILL_CATALOG_VERSION, type LoadedSkill } from './skills.js';

import { scopedLocalItems, listLocalMemories } from './local-library.js';
import { listProjectMemories } from './project-intelligence.js';
import { readTaskWorkingState } from './working-state.js';
import { peerReviewCandidate } from './peer-review.js';

import type { ToolDefinition } from '../../contracts/src/model.js';

/** 目录只返回一页；完整产物正文仍通过受权限约束的读取工具获取。 */
export function contextArtifactPage(store: Store, task: Task, after?: string, limit = 32) {
  const run = store.require<Run>('runs', task.runId);
  const extraIds = [
    ...(peerReviewCandidate(run, task)
      ?.evidence.filter((e) => e.type === 'artifact')
      .map((e) => e.ref) ?? []),
    ...(run.source?.bundleArtifactId ? [run.source.bundleArtifactId] : []),
    ...(run.source?.artifacts.map((a) => a.importedId) ?? []),
  ];
  return store.scheduling.artifactPage(run.id, task.id, extraIds, after, limit);
}

/**
 * 一次捕获外部状态，编译器不接收数据库或文件系统句柄。
 * 汇集本次编译所需的任务、代理、历史与资源，让后续纯编译不访问存储或文件系统。
 *
 * EN: Capture external state once. The compiler receives no database or filesystem handles.
 * Collects tasks, agents, history, and resources so subsequent pure compilation needs no storage or filesystem access.
 */
export function collectContextSnapshot(store: Store, task: Task, definitions: ToolDefinition[]) {
  const run = store.require<Run>('runs', task.runId),
    agent = store.require<Agent>('agents', task.agentId);
  const snapshots = store.scheduling
    .snapshotIds(run.id, { taskId: task.id, extraIds: run.plan?.snapshotIds })
    .map((key) => store.require<Snapshot>('snapshots', key))
    .sort((a, b) => a.source.localeCompare(b.source, 'en') || a.version - b.version);
  const skillCatalog = listSkills(store, run);
  const localMemories = listLocalMemories(store, run);
  const localMcp = scopedLocalItems(store, run).filter((item) => item.kind === 'mcp' && item.enabled);
  const projectMemories =
    run.projectId && run.contract.permissionProfile.read
      ? listProjectMemories(store, run.projectId, { activeOnly: true })
      : [];
  /**
   * 已成功加载的技能以当时工具结果为准；撤销/禁用后从内联集合移除并留下撤销标识。
   *
   * EN: Successfully loaded skills use the original tool result; revoked/disabled ones leave the inline set with a withdrawal marker.
   */
  const loadedById = new Map<string, LoadedSkill>();
  const withdrawnSkillIds = new Set<string>();
  for (const op of store.scheduling
    .operationIds(task.id, { name: 'load_skill' })
    .map((key) => store.require<Operation>('tool_operations', key))) {
    if (
      op.taskId !== task.id ||
      op.name !== 'load_skill' ||
      op.status !== 'DONE' ||
      typeof op.args.id !== 'string'
    )
      continue;
    const id = op.args.id;
    if (!skillCatalog.some((skill) => skill.id === id)) {
      withdrawnSkillIds.add(id);
      continue;
    }
    const result = op.result as Partial<LoadedSkill> | null | undefined;
    const captured =
      result &&
      result.id === id &&
      typeof result.name === 'string' &&
      result.name.length > 0 &&
      typeof result.description === 'string' &&
      typeof result.version === 'string' &&
      typeof result.instructions === 'string' &&
      result.instructions.length > 0 &&
      typeof result.hash === 'string' &&
      /^[a-f0-9]{64}$/.test(result.hash);
    /**
     * 压缩及后续文件变化期间保留实际加载的修订。
     * 后续成功的显式重载才替换它；缺少结果的旧操作使用兼容回退。
     *
     * EN: Preserve the actual loaded revision through compaction and subsequent file changes.
     * A later successful explicit reload replaces it; legacy operations without a result fall back.
     */
    loadedById.set(id, captured ? (result as LoadedSkill) : loadSkill(id, store, run));
  }
  const loadedSkills = [...loadedById.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  /**
   * 工作状态损坏时显式记录回退原因，让压缩保留原始要求；其他读取错误仍向上传递。
   *
   * EN: Corrupt working state records an explicit fallback reason so compaction retains original requirements; other read errors still propagate.
   */
  let workingState: ReturnType<typeof readTaskWorkingState> | undefined;
  let workingStateFallback: string | null = null;
  try {
    workingState = readTaskWorkingState(store, run.id, task.id);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'WORKING_STATE_UNREADABLE') throw error;
    workingStateFallback = error.code;
  }

  const prompts = Object.fromEntries(
    ['platform', 'chat', 'workspace', task.peerReview ? 'peer-reviewer' : task.spec.role].map((name) => [
      name,
      readFileSync(builtinResourcePath('prompts', name + '.md'), 'utf8')
        .replace(/\r\n/g, '\n')
        .trim(),
    ]),
  );
  const artifacts = contextArtifactPage(store, task);
  /**
   * 复制后交给纯编译器，避免后续持久对象变更影响本次上下文的确定性。
   *
   * EN: Passes copies to the pure compiler so later durable-object mutation cannot alter this context deterministically.
   */
  return structuredClone({
    run,
    task,
    agent,
    definitions,
    prompts,
    environment: { hostPlatform: process.platform },
    snapshots,
    snapshotContents: snapshots.map((s) => {
      const bytes = store.readObject(s.objectRef),
        binary = isBinaryFile(s.source, bytes);
      return {
        source: s.source,
        hash: s.hash,
        trust: s.trust,
        bytes: bytes.length,
        binary,
        text: binary ? null : bytes.toString('utf8').slice(0, 16000),
      };
    }),
    skillCatalog,
    skillCatalogVersion: SKILL_CATALOG_VERSION,
    localMemories,
    localMcp,
    projectMemories,
    loadedSkills,
    withdrawnSkillIds: [...withdrawnSkillIds],
    workingState,
    workingStateFallback,
    projectDirectory: run.projectId ? store.require<Project>('projects', run.projectId).workspaceRoot : null,
    accessibleArtifacts: artifacts.items,
    accessibleArtifactsPage: {
      total: artifacts.total,
      nextCursor: artifacts.nextCursor,
      tool: 'list_artifacts',
    },
    childrenPage: { total: store.scheduling.countChildren(task.id), limit: 32, tool: 'list_children' },
    children: store.scheduling
      .taskIds(run.id, { parentId: task.id, limit: 32 })
      .map((key) => store.require<Task>('tasks', key))
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
    history: store.sessionMessages(run.id, agent.sessionId),
    capturedAt: new Date().toISOString(),
  });
}
export type ContextSourceSnapshot = ReturnType<typeof collectContextSnapshot>;
