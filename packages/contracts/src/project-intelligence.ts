// 项目记忆、能力选择和快照的约束与数据契约。
import { z } from 'zod';
import type { LocalAgentItem } from './local-integrations.js';

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
export const ProjectCapabilitySelection = z
  .object({
    builtinSkillIds: uniqueIds,
    localItemIds: uniqueIds,
  })
  .strict();
export type ProjectCapabilitySelection = z.infer<typeof ProjectCapabilitySelection>;
export interface ProjectIntelligenceConfig extends ProjectCapabilitySelection {
  version: 1;
  projectId: string;
  revision: number;
  mode: 'legacy' | 'explicit';
  updatedAt: string | null;
}
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
/** Absence of a snapshot retains legacy behavior; a present snapshot must match the run project. */
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
