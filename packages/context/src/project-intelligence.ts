import { z } from 'zod';
import { AppError, invariant, type Project } from '../../contracts/src/index.js';
import {
  PROJECT_INTELLIGENCE_LIMITS,
  ProjectCapabilitySelection,
  ProjectMemoryContent,
  ProjectMemoryUpdate,
  type ProjectCapabilitySnapshot,
  type ProjectIntelligenceConfig,
  type ProjectIntelligenceView,
  type ProjectMemory,
  type ProjectMemoryVersion,
} from '../../contracts/src/project-intelligence.js';
import { hash, id, now, stable, type Store } from '../../storage/src/index.js';
import { importedLibrary, localItemText, pageLocalText, publicLocalItem } from './local-library.js';
import { listSkills, captureBuiltinSkill } from './skills.js';

export const projectIntelligenceKey = (projectId: string) => `project-intelligence:v1:${projectId}`;
export const projectMemoriesKey = (projectId: string) => `project-memories:v1:${projectId}`;
const versionSchema = ProjectMemoryContent.extend({
  revision: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime(),
}).strict();
const memorySchema = versionSchema
  .extend({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    createdAt: z.string().datetime(),
    history: z.array(versionSchema).max(PROJECT_INTELLIGENCE_LIMITS.historyCount),
  })
  .strict();
const configSchema = ProjectCapabilitySelection.extend({
  version: z.literal(1),
  projectId: z.string().uuid(),
  revision: z.number().int().positive(),
  mode: z.literal('explicit'),
  updatedAt: z.string().datetime(),
}).strict();
function readMeta(store: Store, key: string, limit: number): unknown | undefined {
  const row = store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    if (Buffer.byteLength(row.value) > limit) throw new Error('limit');
    return JSON.parse(row.value);
  } catch {
    throw new AppError(
      'PROJECT_INTELLIGENCE_INVALID',
      '项目能力或记忆记录损坏，原文已保留，请恢复备份',
      false,
      null,
      409,
    );
  }
}
function saveMeta(store: Store, key: string, value: unknown, limit: number) {
  const text = stable(value);
  invariant(Buffer.byteLength(text) <= limit, 'PROJECT_MEMORY_LIMIT', '项目能力或记忆记录超过存储容量上限');
  store.db.prepare('INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)').run(key, text);
}
function invalid(): never {
  throw new AppError(
    'PROJECT_INTELLIGENCE_INVALID',
    '项目能力或记忆记录无效，原文已保留，请恢复备份',
    false,
    null,
    409,
  );
}
export function requireIntelligenceProject(store: Store, projectId: string) {
  const project = store.require<Project>('projects', projectId);
  invariant(!project.archived, 'PROJECT_ARCHIVED', '请先恢复归档项目再使用项目能力和记忆');
  return project;
}
export function assertIntelligenceRevision(expected: number, actual: number) {
  if (expected !== actual)
    throw new AppError(
      'REVISION_CONFLICT',
      '记录已更新，请重新读取并核对修改',
      false,
      { currentRevision: actual },
      409,
    );
}
export function readProjectIntelligence(store: Store, projectId: string): ProjectIntelligenceConfig {
  requireIntelligenceProject(store, projectId);
  const raw = readMeta(store, projectIntelligenceKey(projectId), 256 * 1024);
  if (raw === undefined)
    return {
      version: 1,
      projectId,
      revision: 0,
      mode: 'legacy',
      updatedAt: null,
      builtinSkillIds: listSkills().map((item) => item.id),
      localItemIds: importedLibrary(store)
        .items.filter((item) => item.enabled)
        .map((item) => item.id),
    };
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success || parsed.data.projectId !== projectId) return invalid();
  return parsed.data;
}
export function projectIntelligenceView(store: Store, projectId: string): ProjectIntelligenceView {
  return {
    config: readProjectIntelligence(store, projectId),
    catalog: { builtinSkills: listSkills(), localItems: importedLibrary(store).items.map(publicLocalItem) },
    limits: PROJECT_INTELLIGENCE_LIMITS,
  };
}
export function updateProjectIntelligence(
  store: Store,
  projectId: string,
  expectedRevision: number,
  input: ProjectCapabilitySelection,
) {
  return store.tx(() => {
    const current = readProjectIntelligence(store, projectId);
    assertIntelligenceRevision(expectedRevision, current.revision);
    const selection = ProjectCapabilitySelection.parse(input);
    const builtinIds = new Set(listSkills().map((item) => item.id));
    const localIds = new Set(importedLibrary(store).items.map((item) => item.id));
    invariant(
      selection.builtinSkillIds.every((key) => builtinIds.has(key)),
      'SKILL_NOT_FOUND',
      '所选内置技能已失效，请重新读取目录',
    );
    invariant(
      selection.localItemIds.every((key) => localIds.has(key)),
      'LOCAL_ITEM_NOT_FOUND',
      '所选本机能力已失效，请重新读取目录',
    );
    const next: ProjectIntelligenceConfig = {
      version: 1,
      projectId,
      revision: current.revision + 1,
      mode: 'explicit',
      updatedAt: now(),
      ...selection,
    };
    saveMeta(store, projectIntelligenceKey(projectId), next, 256 * 1024);
    return next;
  });
}
/** Capture executable/readable content inline so object maintenance cannot invalidate a run's capability snapshot. */
export function freezeProjectCapabilities(store: Store, projectId: string): ProjectCapabilitySnapshot {
  return store.tx(() => {
    const config = readProjectIntelligence(store, projectId);
    const snapshot: Omit<ProjectCapabilitySnapshot, 'hash'> = {
      version: 1,
      projectId,
      configRevision: config.revision,
      mode: config.mode,
      createdAt: now(),
      builtinSkills: [],
      localItems: [],
    };
    const checkSize = () =>
      invariant(
        Buffer.byteLength(stable({ ...snapshot, hash: '0'.repeat(64) })) <=
          PROJECT_INTELLIGENCE_LIMITS.snapshotBytes,
        'CAPABILITY_SNAPSHOT_LIMIT',
        '任务能力快照超过 2 MiB，请减少项目选择的记忆、技能或资源；内容未截断',
      );
    for (const skillId of config.builtinSkillIds) {
      snapshot.builtinSkills.push(captureBuiltinSkill(skillId));
      checkSize();
    }
    const allowed = new Set(config.localItemIds);
    for (const item of importedLibrary(store).items.filter(
      (entry) => entry.enabled && allowed.has(entry.id),
    )) {
      const captured = {
        ...publicLocalItem(item),
        ...(item.kind === 'memory' || item.kind === 'skill' ? { content: localItemText(store, item) } : {}),
        resources: [] as { path: string; text: string; hash: string; bytes: number }[],
      };
      snapshot.localItems.push(captured);
      checkSize();
      for (const resource of item.resourceRefs ?? []) {
        invariant(
          resource.bytes <= 512 * 1024,
          'CAPABILITY_RESOURCE_LIMIT',
          '技能资源超过 512 KiB，无法冻结',
        );
        const bytes = store.readObject(resource.objectRef);
        invariant(
          bytes.length === resource.bytes && hash(bytes) === resource.hash,
          'LOCAL_CONTENT_CHANGED',
          '技能资源哈希不一致，请重新同步',
        );
        const text = bytes.toString('utf8');
        invariant(
          Buffer.from(text).equals(bytes),
          'LOCAL_CONTENT_CHANGED',
          '技能资源不是有效 UTF-8，无法冻结',
        );
        captured.resources.push({ path: resource.path, text, hash: resource.hash, bytes: resource.bytes });
        checkSize();
      }
    }
    return { ...snapshot, hash: hash(stable(snapshot)) };
  });
}
const memoryHash = (memory: ProjectMemoryContent) =>
  hash(stable({ title: memory.title, text: memory.text, source: memory.source, status: memory.status }));
export function listProjectMemories(
  store: Store,
  projectId: string,
  options: { activeOnly?: boolean } = {},
): ProjectMemory[] {
  requireIntelligenceProject(store, projectId);
  const raw = readMeta(store, projectMemoriesKey(projectId), PROJECT_INTELLIGENCE_LIMITS.projectMemoryBytes);
  if (raw === undefined) return [];
  const parsed = z
    .object({
      version: z.literal(1),
      projectId: z.string().uuid(),
      memories: z.array(memorySchema).max(PROJECT_INTELLIGENCE_LIMITS.memoryCount),
    })
    .strict()
    .safeParse(raw);
  if (!parsed.success || parsed.data.projectId !== projectId) return invalid();
  const memories = parsed.data.memories;
  if (new Set(memories.map((item) => item.id)).size !== memories.length) return invalid();
  for (const memory of memories) {
    if (
      memory.projectId !== projectId ||
      Buffer.byteLength(stable(memory)) > PROJECT_INTELLIGENCE_LIMITS.memoryRecordBytes ||
      memoryHash(memory) !== memory.hash ||
      memory.history.some(
        (old, index) =>
          old.revision >= memory.revision ||
          memoryHash(old) !== old.hash ||
          (index > 0 && old.revision <= memory.history[index - 1].revision),
      )
    )
      return invalid();
  }
  return options.activeOnly ? memories.filter((memory) => memory.status === 'active') : memories;
}
function saveMemories(store: Store, projectId: string, memories: ProjectMemory[]) {
  saveMeta(
    store,
    projectMemoriesKey(projectId),
    { version: 1, projectId, memories },
    PROJECT_INTELLIGENCE_LIMITS.projectMemoryBytes,
  );
}
export function createProjectMemory(
  store: Store,
  projectId: string,
  input: ProjectMemoryContent,
): ProjectMemory {
  return store.tx(() => {
    const content = ProjectMemoryContent.parse(input);
    invariant(content.status !== 'revoked', 'MEMORY_STATUS', '新记忆应保存为草稿或启用');
    const memories = listProjectMemories(store, projectId);
    invariant(
      memories.length < PROJECT_INTELLIGENCE_LIMITS.memoryCount,
      'PROJECT_MEMORY_LIMIT',
      '每个项目最多保存 100 条记忆（包括已撤销记录）',
    );
    const timestamp = now();
    const memory: ProjectMemory = {
      ...content,
      id: id(),
      projectId,
      revision: 1,
      hash: memoryHash(content),
      createdAt: timestamp,
      updatedAt: timestamp,
      history: [],
    };
    saveMemories(store, projectId, [...memories, memory]);
    return memory;
  });
}
export function updateProjectMemory(
  store: Store,
  projectId: string,
  memoryId: string,
  expectedRevision: number,
  input: ProjectMemoryUpdate,
): ProjectMemory {
  return store.tx(() => {
    const changes = ProjectMemoryUpdate.parse(input);
    const memories = listProjectMemories(store, projectId);
    const current = memories.find((item) => item.id === memoryId);
    if (!current) throw new AppError('PROJECT_MEMORY_NOT_FOUND', '当前项目中不存在此记忆', false, null, 404);
    assertIntelligenceRevision(expectedRevision, current.revision);
    let content: ProjectMemoryContent;
    if (changes.restoreRevision !== undefined) {
      const previous = current.history.find((item) => item.revision === changes.restoreRevision);
      if (!previous)
        throw new AppError(
          'PROJECT_MEMORY_VERSION',
          '所选历史版本已超出保留范围：最多 20 个旧版本，单条记忆含历史最多 128 KiB',
          false,
          null,
          409,
        );
      content = {
        title: previous.title,
        text: previous.text,
        source: previous.source,
        status: previous.status,
      };
    } else
      content = ProjectMemoryContent.parse({
        title: changes.title ?? current.title,
        text: changes.text ?? current.text,
        source: changes.source ?? current.source,
        status: changes.status ?? current.status,
      });
    const previous: ProjectMemoryVersion = {
      title: current.title,
      text: current.text,
      source: current.source,
      status: current.status,
      revision: current.revision,
      hash: current.hash,
      updatedAt: current.updatedAt,
    };
    const next: ProjectMemory = {
      ...current,
      ...content,
      revision: current.revision + 1,
      hash: memoryHash(content),
      updatedAt: now(),
      history: [...current.history, previous].slice(-PROJECT_INTELLIGENCE_LIMITS.historyCount),
    };
    // Retention is bounded per record. Evict only complete oldest versions; the current
    // version always fits, so reaching the project limit cannot lock out edits or revocation.
    while (
      next.history.length &&
      Buffer.byteLength(stable(next)) > PROJECT_INTELLIGENCE_LIMITS.memoryRecordBytes
    )
      next.history.shift();
    invariant(
      Buffer.byteLength(stable(next)) <= PROJECT_INTELLIGENCE_LIMITS.memoryRecordBytes,
      'PROJECT_MEMORY_LIMIT',
      '单条记忆超过 128 KiB 存储上限',
    );
    saveMemories(
      store,
      projectId,
      memories.map((item) => (item.id === memoryId ? next : item)),
    );
    return next;
  });
}
export function readProjectMemory(
  store: Store,
  projectId: string,
  memoryId: string,
  options: { offset?: number; limit?: number; query?: string } = {},
) {
  const memory = listProjectMemories(store, projectId, { activeOnly: true }).find(
    (item) => item.id === memoryId,
  );
  if (!memory)
    throw new AppError('PROJECT_MEMORY_NOT_FOUND', '此记忆不属于当前项目或尚未启用', false, null, 404);
  return {
    ...pageLocalText({ id: memory.id, contentHash: memory.hash }, memory.text, options),
    projectId,
    title: memory.title,
    source: memory.source,
    revision: memory.revision,
  };
}
