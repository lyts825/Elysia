// 终端资源占用与清理操作的数据约束。
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pathText = z.string().min(1).max(2000);
// 占用统计需要区分完整、部分和未知，避免把缺失数据当成零。
export const TerminalMaintenanceCoverage = z.enum(['complete', 'partial', 'unknown']);
const occupancy = {
  coverage: TerminalMaintenanceCoverage.default('complete'),
  measurementReason: z.string().optional(),
};
export const TerminalPendingCleanup = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    bytes: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
    message: z.string(),
  })
  .strict();
export const TerminalMaintenanceOverview = z
  .object({
    revision: digest,
    checkedAt: z.string().datetime(),
    totalBytes: z.number().int().nonnegative(),
    coverage: TerminalMaintenanceCoverage.default('complete'),
    groups: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        bytes: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
        ...occupancy,
      }),
    ),
    sessions: z.array(
      z.object({
        taskId: z.string(),
        runId: z.string().nullable(),
        homeOperationId: z.string().nullable(),
        bytes: z.number().int().nonnegative(),
        protected: z.boolean(),
        reason: z.string(),
        backupEligible: z.boolean(),
        ...occupancy,
      }),
    ),
    preserved: z.array(z.object({ path: pathText, reason: z.string() })),
    pendingCleanup: z.array(TerminalPendingCleanup).default([]),
  })
  .strict();
export type TerminalMaintenanceOverview = z.infer<typeof TerminalMaintenanceOverview>;
export const TerminalMaintenancePlan = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['cleanup', 'backup', 'restore', 'delete']),
    revision: digest,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    bytes: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        kind: z.enum([
          'session-metadata',
          'owned-residue',
          'session-rollout',
          'workspace',
          'backup-snapshot',
        ]),
        ref: pathText,
        bytes: z.number().int().nonnegative(),
      }),
    ),
    warnings: z.array(z.string()),
    runId: z.string().uuid().optional(),
    runRevision: z.number().int().nonnegative().optional(),
    backupId: z.string().uuid().optional(),
    retryId: z.string().uuid().optional(),
  })
  .strict();
export type TerminalMaintenancePlan = z.infer<typeof TerminalMaintenancePlan>;
export const TerminalMaintenanceApply = z
  .object({ commandId: z.string().uuid(), planId: z.string().uuid(), expectedRevision: digest })
  .strict();
export const TerminalSessionBackupView = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    runRevision: z.number().int().nonnegative(),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    excluded: z.array(z.string()),
    checkpoint: digest,
    consistent: z.boolean(),
  })
  .strict();
export type TerminalSessionBackupView = z.infer<typeof TerminalSessionBackupView>;
export const TerminalBackupHistoryItem = TerminalSessionBackupView.omit({ excluded: true })
  .extend({
    title: z.string().max(240),
    excludedCount: z.number().int().nonnegative(),
  })
  .strict();
export type TerminalBackupHistoryItem = z.infer<typeof TerminalBackupHistoryItem>;
export const TerminalBackupPage = z
  .object({
    items: z.array(TerminalBackupHistoryItem).max(100),
    total: z.number().int().nonnegative(),
    revision: digest,
    page: z
      .object({
        limit: z.number().int().min(1).max(100),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type TerminalBackupPage = z.infer<typeof TerminalBackupPage>;
export const TerminalBackupEligibility = z
  .object({
    backupId: z.string().uuid(),
    runId: z.string().uuid(),
    checkedAt: z.string().datetime(),
    canRestore: z.boolean(),
    canDelete: z.boolean(),
    runRevision: z.number().int().nonnegative().nullable(),
    code: z.string().max(100),
    message: z.string().max(1000),
    deleteReason: z.string().max(1000),
  })
  .strict();
export type TerminalBackupEligibility = z.infer<typeof TerminalBackupEligibility>;
export const TerminalMaintenanceScanInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('overview') }).strict(),
  z.object({ kind: z.literal('cleanup') }).strict(),
  z.object({ kind: z.literal('delete'), backupId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('backup'),
      runId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('restore'),
      backupId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('retry'),
      retryId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export const TerminalMaintenanceScan = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['overview', 'cleanup', 'backup', 'restore', 'retry', 'delete']),
    status: z.enum(['running', 'completed', 'cancelled', 'failed']),
    phase: z.enum(['references', 'sessions', 'storage', 'ownership', 'hashing', 'verification', 'complete']),
    filesVisited: z.number().int().nonnegative(),
    bytesProcessed: z.number().int().nonnegative(),
    groupsCompleted: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    overview: TerminalMaintenanceOverview.optional(),
    plan: TerminalMaintenancePlan.optional(),
    message: z.string().optional(),
  })
  .strict();
export type TerminalMaintenanceScan = z.infer<typeof TerminalMaintenanceScan>;
