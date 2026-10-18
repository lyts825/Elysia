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
  };
}
export interface ProjectSchedulePreview {
  projectId: string;
  template: ProjectScheduleTemplate;
  captureHash: string;
}
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
