import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pathText = z.string().min(1).max(2000);
export const TerminalMaintenanceOverview = z
  .object({
    revision: digest,
    checkedAt: z.string().datetime(),
    totalBytes: z.number().int().nonnegative(),
    groups: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        bytes: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
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
      }),
    ),
    preserved: z.array(z.object({ path: pathText, reason: z.string() })),
  })
  .strict();
export type TerminalMaintenanceOverview = z.infer<typeof TerminalMaintenanceOverview>;
export const TerminalMaintenancePlan = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['cleanup', 'backup', 'restore']),
    revision: digest,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    bytes: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        kind: z.enum(['session-metadata', 'owned-residue', 'session-rollout', 'workspace']),
        ref: pathText,
        bytes: z.number().int().nonnegative(),
      }),
    ),
    warnings: z.array(z.string()),
    runId: z.string().uuid().optional(),
    runRevision: z.number().int().nonnegative().optional(),
    backupId: z.string().uuid().optional(),
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
