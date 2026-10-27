/**
 * 终端资源占用与清理操作的数据约束。
 * 扫描、预览和应用分开，并绑定修订与有效期，避免把读取占用变成自动删除授权。
 *
 * EN: Defines terminal storage usage and maintenance constraints.
 * Separates scans, previews, and apply with revisions/expiry so usage reads cannot authorize automatic deletion.
 */
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pathText = z.string().min(1).max(2000);
/**
 * 占用统计需要区分完整、部分和未知，避免把缺失数据当成零。
 *
 * EN: Usage distinguishes complete, partial, and unknown data; missing information must not become zero.
 */
export const TerminalMaintenanceCoverage = z.enum(['complete', 'partial', 'unknown']);
const occupancy = {
  coverage: TerminalMaintenanceCoverage.default('complete'),
  measurementReason: z.string().optional(),
};
/**
 * 已开始但尚未确认完成的清理记录，保留身份和修订以便定向重试。
 *
 * EN: Cleanup started but not confirmed complete retains identity and revision for targeted retry.
 */
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
/**
 * 占用汇总绑定扫描摘要；coverage 表达未能完整测量的部分，protected/preserved 说明保留原因。
 *
 * EN: Usage totals bind a scan digest; coverage describes unmeasured parts and protected/preserved explain retention.
 */
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
/**
 * 可审阅的维护预览，列出精确对象、扫描摘要及有效期。
 * 预览本身不执行动作；应用时必须仍匹配 expectedRevision，过期或内容变化应重新扫描。
 *
 * EN: A reviewable maintenance preview with exact objects, scan digest, and expiry. It performs no action; apply must still match expectedRevision, and stale or changed contents require a new scan.
 */
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
/**
 * 幂等应用某份预览的命令，不接受客户端自行扩展待操作路径列表。
 *
 * EN: An idempotent command applying a preview; clients cannot expand the target path list themselves.
 */
export const TerminalMaintenanceApply = z
  .object({ commandId: z.string().uuid(), planId: z.string().uuid(), expectedRevision: digest })
  .strict();
/**
 * 会话检查点备份元数据；consistent 表达捕获一致性，不表示备份已在当前环境恢复验证。
 *
 * EN: Session-checkpoint backup metadata; consistent describes capture consistency, not a successful restore test in the present environment.
 */
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
/**
 * 针对当前运行状态重新计算恢复/删除资格，历史列表中的旧资格不能替代本次检查。
 *
 * EN: Recomputes restore/delete eligibility from current run state; old eligibility in history cannot substitute for this check.
 */
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
/**
 * 不同扫描种类携带各自的身份与修订，拒绝将恢复请求伪装为普通占用读取。
 *
 * EN: Each scan kind carries its own identity and revision; restoration cannot impersonate an ordinary usage read.
 */
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
/**
 * 后台扫描进度；completed 后可能携带 overview 或 plan，取消/失败不等于动作已经执行。
 *
 * EN: Background scan progress; completed may carry overview or plan, while cancellation/failure does not mean an action was applied.
 */
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
