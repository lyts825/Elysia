// 项目定时运行的限制、配置及记录契约。
import { z } from 'zod';
import type { ContextPolicy, Contract, Limits, ProviderConfig, Status } from './index.js';

export const PROJECT_SCHEDULE_LIMITS = {
  perProject: 20,
  total: 100,
  minimumIntervalMinutes: 5,
  maximumRuns: 100,
  maximumDays: 31,
  templateBytes: 128 * 1024,
  projectBytes: 3 * 1024 * 1024,
  maximumTokensPerRun: 1_000_000,
  sourcePage: 50,
} as const;

// 任务模板限定运行方式、间隔、次数与截止时间；默认先走评审模式。
export const ProjectScheduleSettings = z
  .object({
    name: z.string().trim().min(1).max(160),
    mode: z.enum(['review', 'execute']).default('review'),
    intervalMinutes: z
      .number()
      .int()
      .min(PROJECT_SCHEDULE_LIMITS.minimumIntervalMinutes)
      .max(31 * 24 * 60),
    maxRuns: z.number().int().min(1).max(PROJECT_SCHEDULE_LIMITS.maximumRuns).default(3),
    until: z.string().datetime(),
  })
  .strict();
export type ProjectScheduleSettings = z.infer<typeof ProjectScheduleSettings>;

/** All task text is inline. A schedule never borrows run-scoped object references. */
export interface ProjectScheduleTemplate {
  sourceRunId: string;
  sourceRevision: number;
  sourceTitle: string;
  objective: string;
  contract: Contract;
  limits: Limits;
  contextPolicy: ContextPolicy;
  provider: ProviderConfig;
  environment: {
    workspaceRoot: string;
    configVersion: number;
    baseline: string | null;
    capabilityHash: string;
    memoryHash: string;
    routingHash: string;
    providerHash: string;
    toolReviewProviderHash?: string;
  };
}
/** 保存前的模板捕获及摘要，提交时必须核对相同来源修订和 captureHash。 */
export interface ProjectSchedulePreview {
  projectId: string;
  template: ProjectScheduleTemplate;
  captureHash: string;
}
/** 定时计划持久状态；创建次数和跳过次数累计，暂停或刷新不会自动清零。 */
export interface ProjectSchedule extends ProjectSchedulePreview {
  version: 1;
  id: string;
  revision: number;
  settings: ProjectScheduleSettings;
  status: 'draft' | 'enabled' | 'paused' | 'completed';
  createdCount: number;
  skippedCount: number;
  nextDueAt: string | null;
  lastRunId: string | null;
  lastDueAt: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectScheduleList {
  projectId: string;
  schedules: ProjectSchedule[];
  /** Latest native tasks; preview explains any source that cannot be reused. */
  sources: { id: string; title: string; revision: number; status: Status }[];
  sourcesLimited: boolean;
  limits: typeof PROJECT_SCHEDULE_LIMITS;
}
export interface ProjectScheduleHistoryItem {
  /** Exact dispatch key, or a bounded opaque identity when the stored key is corrupt. */
  dispatchId: string;
  dueAt: string | null;
  /** Current lightweight run state; missing or unverified associations never expose a run identifier. */
  run: {
    id: string;
    revision: number;
    title: string;
    status: Status;
    reason?: string;
    archived: boolean;
    createdAt: string;
  } | null;
  issue: {
    code:
      | 'invalid_dispatch'
      | 'invalid_references'
      | 'missing_run'
      | 'project_mismatch'
      | 'unavailable_run'
      | 'duplicate_run';
    message: string;
  } | null;
}
/** 历史读取同时报告关联覆盖情况；无法追踪的分发记录不能计作已核验任务。 */
export interface ProjectScheduleHistory {
  projectId: string;
  scheduleId: string;
  scheduleRevision: number;
  createdCount: number;
  items: ProjectScheduleHistoryItem[];
  page: { limit: 20; before: string | null; nextBefore: string | null; hasMore: boolean };
  coverage: {
    complete: boolean;
    /** More than the supported 100 dispatch records exist; counts cover only the bounded read. */
    scanLimited: boolean;
    retainedDispatches: number;
    traceableRuns: number;
    missingDispatches: number;
    unavailableEntries: number;
    message: string;
  };
}
const captureHash = z.string().regex(/^[a-f0-9]{64}$/);
export const ProjectScheduleCreate = z
  .object({
    commandId: z.string().uuid(),
    sourceRunId: z.string().uuid(),
    expectedSourceRevision: z.number().int().nonnegative(),
    captureHash,
    settings: ProjectScheduleSettings,
  })
  .strict();
/** enable/refresh 可要求重新核对捕获摘要；自动执行必须有显式确认字段。 */
export const ProjectScheduleUpdate = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    action: z.enum(['enable', 'pause', 'refresh', 'delete']),
    captureHash: captureHash.optional(),
    expectedSourceRevision: z.number().int().nonnegative().optional(),
    confirmAutomaticExecution: z.literal(true).optional(),
    settings: ProjectScheduleSettings.optional(),
  })
  .strict();
export type ProjectScheduleCreate = z.infer<typeof ProjectScheduleCreate>;
export type ProjectScheduleUpdate = z.infer<typeof ProjectScheduleUpdate>;
