// 收集编译模型上下文所需的运行、任务和资源快照。
import { readFileSync } from 'node:fs';
import { builtinResourcePath } from './resources.js';
import {
  AppError,
  effectiveContextWindowTokens,
  type Task,
  type Run,
  type Agent,
  type Snapshot,
  type Artifact,
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

/** Capture external state once. The compiler receives no database or filesystem handles. */
// 汇集本次编译所需的任务、代理、历史与资源，让后续纯编译不访问存储或文件系统。
export function collectContextSnapshot(store: Store, task: Task, definitions: ToolDefinition[]) {
  const run = store.require<Run>('runs', task.runId),
    agent = store.require<Agent>('agents', task.agentId);
  const snapshots = store
    .all<Snapshot>('snapshots', run.id)
    .filter((s) => run.plan?.snapshotIds.includes(s.id) || s.taskId === task.id)
    .sort((a, b) => a.source.localeCompare(b.source, 'en') || a.version - b.version);
  const skillCatalog = listSkills(store, run);
  const localMemories = listLocalMemories(store, run);
  const localMcp = scopedLocalItems(store, run).filter((item) => item.kind === 'mcp' && item.enabled);
  const projectMemories =
    run.projectId && run.contract.permissionProfile.read
      ? listProjectMemories(store, run.projectId, { activeOnly: true })
      : [];
  const loadedById = new Map<string, LoadedSkill>();
  const withdrawnSkillIds = new Set<string>();
  for (const op of store.all<Operation>('tool_operations', run.id)) {
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
    // Preserve the actual loaded revision through compaction and subsequent file changes.
    // A later successful explicit reload replaces it; legacy operations without a result fall back.
    loadedById.set(id, captured ? (result as LoadedSkill) : loadSkill(id, store, run));
  }
  const loadedSkills = [...loadedById.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
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
    accessibleArtifacts: store
      .all<Artifact>('artifacts', run.id)
      .filter(
        (a) =>
          a.verified ||
          peerReviewCandidate(run, task)?.evidence.some((e) => e.type === 'artifact' && e.ref === a.id) ||
          a.taskId === task.id ||
          a.id === run.source?.bundleArtifactId ||
          run.source?.artifacts.some((source) => source.importedId === a.id),
      )
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
    history: store.sessionMessages(run.id, agent.sessionId),
    capturedAt: new Date().toISOString(),
  });
}
export type ContextSourceSnapshot = ReturnType<typeof collectContextSnapshot>;
