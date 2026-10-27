/**
 * 项目记忆、能力选择和快照的约束与数据契约。
 * 选择、不可变快照与可修订记忆分层，运行不得因全局配置修改静默获得新能力。
 *
 * EN: Defines validation and contracts for project memories, capability selections, and snapshots.
 * Separates selections, immutable snapshots, and revisioned memories so global edits cannot silently grant new run capabilities.
 */
import { z } from 'zod';
import type { LocalAgentItem } from './local-integrations.js';

/**
 * 限制记忆和冻结快照的大小，避免能力配置无限增长。
 *
 * EN: Caps memories and frozen snapshots so capability configuration cannot grow without bound.
 */
export const PROJECT_INTELLIGENCE_LIMITS = {
  memoryBytes: 16 * 1024,
  memoryCount: 100,
  historyCount: 20,
  memoryRecordBytes: 128 * 1024,
  snapshotBytes: 2 * 1024 * 1024,
  projectMemoryBytes: 16 * 1024 * 1024,
} as const;
const identifier = z.string().min(1).max(160);
const uniqueIds = z
  .array(identifier)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, '不能重复选择能力');
/**
 * 用户选择的内置技能与本地资源 ID；去重后保存，执行前还要核对资源是否存在及启用。
 *
 * EN: User-selected built-in skill and local-resource IDs are deduplicated; existence and enablement must still be checked before execution.
 */
export const ProjectCapabilitySelection = z
  .object({
    builtinSkillIds: uniqueIds,
    localItemIds: uniqueIds,
  })
  .strict();
export type ProjectCapabilitySelection = z.infer<typeof ProjectCapabilitySelection>;
/**
 * legacy 表示未显式保存的兼容选择，explicit 表示有修订可核对的用户配置。
 *
 * EN: legacy denotes an unsaved compatibility selection; explicit denotes a revisioned user configuration.
 */
export interface ProjectIntelligenceConfig extends ProjectCapabilitySelection {
  version: 1;
  projectId: string;
  revision: number;
  mode: 'legacy' | 'explicit';
  updatedAt: string | null;
}
/**
 * 与入口一起冻结的完整指导和显式参考资源，hash/bytes 核对准确内容而非仅路径。
 *
 * EN: Full instructions and explicit reference resources frozen with an entry point; hash/bytes verify exact contents rather than paths alone.
 */
export interface CapturedSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  instructions: string;
  hash: string;
  source?: string;
  resourcePaths?: string[];
  resources?: { path: string; text: string; hash: string; bytes: number }[];
}
export interface CapturedLocalItem extends LocalAgentItem {
  content?: string;
  resources?: { path: string; text: string; hash: string; bytes: number }[];
}
/**
 * 能力快照记录任务创建时选中的项目资源，后续配置修改不能静默改变旧任务。
 *
 * EN: A capability snapshot records resources selected at task creation; later configuration edits cannot silently change old tasks.
 */
export interface ProjectCapabilitySnapshot {
  version: 1;
  projectId: string;
  configRevision: number;
  mode: 'legacy' | 'explicit';
  createdAt: string;
  builtinSkills: CapturedSkill[];
  localItems: CapturedLocalItem[];
  hash: string;
}
/**
 * 缺少快照时保留旧版行为；存在的快照必须属于该运行的项目。
 *
 * EN: Absence of a snapshot retains legacy behavior; a present snapshot must match the run project.
 */
export interface CapabilityScope {
  projectId?: string | null;
  capabilities?: ProjectCapabilitySnapshot | null;
}
export interface ProjectIntelligenceView {
  config: ProjectIntelligenceConfig;
  catalog: {
    builtinSkills: Pick<CapturedSkill, 'id' | 'name' | 'description'>[];
    localItems: LocalAgentItem[];
  };
  limits: typeof PROJECT_INTELLIGENCE_LIMITS;
}
/**
 * 项目记忆内容通过 schema 限制字段和长度，版本元数据另行维护。
 *
 * EN: Memory schemas restrict fields and lengths; revision metadata is maintained separately.
 */
export const ProjectMemoryContent = z
  .object({
    title: z.string().trim().min(1).max(160),
    text: z
      .string()
      .min(1)
      .refine(
        (text) => new TextEncoder().encode(text).length <= PROJECT_INTELLIGENCE_LIMITS.memoryBytes,
        '记忆正文不能超过 16 KiB',
      ),
    source: z.string().trim().max(2000),
    status: z.enum(['draft', 'active', 'revoked']),
  })
  .strict();
export type ProjectMemoryContent = z.infer<typeof ProjectMemoryContent>;
/**
 * 不可变旧版本的正文及摘要；恢复旧正文时仍创建更高的当前修订。
 *
 * EN: Immutable historical bodies and digests; restoring an old body still creates a higher current revision.
 */
export interface ProjectMemoryVersion extends ProjectMemoryContent {
  revision: number;
  hash: string;
  updatedAt: string;
}
export interface ProjectMemory extends ProjectMemoryVersion {
  id: string;
  projectId: string;
  createdAt: string;
  history: ProjectMemoryVersion[];
}
export interface ProjectMemoryList {
  projectId: string;
  memories: ProjectMemory[];
  limits: typeof PROJECT_INTELLIGENCE_LIMITS;
}
/**
 * 编辑与恢复历史互斥；禁止空更新，避免无意生成无内容变化的编辑请求。
 *
 * EN: Editing and history restoration are mutually exclusive; empty updates are rejected to avoid unintended no-op edit requests.
 */
export const ProjectMemoryUpdate = ProjectMemoryContent.partial()
  .extend({
    restoreRevision: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '请提供修改内容')
  .refine(
    (value) => value.restoreRevision === undefined || Object.keys(value).length === 1,
    '恢复历史版本不能同时编辑其他字段',
  );
export type ProjectMemoryUpdate = z.infer<typeof ProjectMemoryUpdate>;
