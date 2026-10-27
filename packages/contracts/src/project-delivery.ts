// 项目交付项、验收与交付状态的校验和契约。
import { z } from 'zod';
import type { Status, Evidence } from './index.js';
import type { DeliveryReviewStatus, SourceArtifact, SourceNoteResolutions } from './workflow.js';
import type { ExecutionHold, RecordPage } from './run-reads.js';
import type { ProjectDeliveryArchive } from './project-delivery-archive.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const line = z.string().trim().min(1).max(2000);
// 一项交付要求至少一条交付物和验收标准，并区分是否必需。
export const ProjectDeliveryItemInput = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000),
    deliverables: z.array(line).min(1).max(20),
    acceptanceCriteria: z.array(line).min(1).max(40),
    required: z.boolean(),
  })
  .strict();
export type ProjectDeliveryItemInput = z.infer<typeof ProjectDeliveryItemInput>;
/** 看板整体编辑命令，expectedRevision 防止覆盖其他窗口对目标或条目的修改。 */
export const ProjectDeliveryBoardInput = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    goal: z.string().trim().max(4000),
    scope: z.array(line).max(40),
    nonGoals: z.array(line).max(40),
    items: z.array(ProjectDeliveryItemInput).max(40),
  })
  .strict();
/** 将一次任务绑定到某交付项，绑定前必须仍匹配看板修订。 */
export const ProjectDeliveryBinding = z
  .object({ itemId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
  .strict();
export type ProjectDeliveryBinding = z.infer<typeof ProjectDeliveryBinding>;
/** 用户确认的是特定条目修订及运行交付指纹，后续任一内容变化可使该确认过期。 */
export interface ProjectDeliveryConfirmation {
  itemRevision: number;
  runId: string;
  fingerprint: string;
  reviewId: string;
  note: string;
  confirmedAt: string;
}
export interface ProjectDeliverySourceNotes {
  total: number;
  resolved: number;
  pending: number;
  needsChanges: number;
  stale: number;
  unavailable: number;
}
/** 交付项关联任务的轻量当前视图；无法核验时用 missing/issue 表达，而非伪造已完成状态。 */
export interface ProjectDeliveryRunSummary {
  runId: string;
  title: string;
  runRevision: number | null;
  rootRevision: number | null;
  status: Status | null;
  fingerprint: string | null;
  reviewId: string | null;
  reviewStatus: DeliveryReviewStatus | null;
  sourceNotes: ProjectDeliverySourceNotes;
  missing: boolean;
  issue?: string;
  executionHold?: ExecutionHold;
}
/** ready 需任务结束、人工审核/确认和来源反馈均有效；其他值说明阻止冻结的具体阶段。 */
export type ProjectDeliveryReadiness =
  | 'unlinked'
  | 'unconfirmed'
  | 'not_done'
  | 'review_pending'
  | 'review_stale'
  | 'changes_requested'
  | 'source_feedback_pending'
  | 'unavailable'
  | 'ready';
export interface ProjectDeliveryItem extends ProjectDeliveryItemInput {
  itemRevision: number;
  attemptCount: number;
  currentRunId: string | null;
  confirmation: ProjectDeliveryConfirmation | null;
  confirmationStale: boolean;
  readiness: ProjectDeliveryReadiness;
  current: ProjectDeliveryRunSummary | null;
}
// 项目看板保存交付范围、条目及汇总计数；revision 用于识别并发变化。
export interface ProjectDeliveryBoard {
  projectId: string;
  revision: number;
  archived: boolean;
  goal: string;
  scope: string[];
  nonGoals: string[];
  items: ProjectDeliveryItem[];
  counts: { total: number; required: number; ready: number; requiredReady: number; unavailable: number };
}
/** 单项交付的历次任务关联，current 指出当前采用的尝试，其余保留供追溯。 */
export interface ProjectDeliveryAttempts {
  projectId: string;
  itemId: string;
  boardRevision: number;
  items: (ProjectDeliveryRunSummary & { linkedAt: string; current: boolean })[];
  page: RecordPage;
}
// 冻结交付时绑定条目、运行、根任务、审核及指纹的预期版本。
export const ProjectDeliveryManifestInput = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(200),
    items: z
      .array(
        z
          .object({
            itemId: z.string().uuid(),
            expectedItemRevision: z.number().int().positive(),
            runId: z.string().uuid(),
            expectedRunRevision: z.number().int().nonnegative(),
            expectedRootRevision: z.number().int().nonnegative(),
            expectedFingerprint: digest,
            expectedReviewId: z.string().uuid(),
            artifactIds: z.array(z.string().uuid()).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
// 清单记录交付创建时的项目、条目与运行快照，供后续核对。
export interface ProjectDeliveryManifest {
  version: 1;
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  createdAt: string;
  boardRevision: number;
  goal: string;
  scope: string[];
  nonGoals: string[];
  items: {
    item: ProjectDeliveryItemInput & { itemRevision: number };
    run: {
      id: string;
      title: string;
      revision: number;
      rootTaskId: string;
      rootRevision: number;
      fingerprint: string;
      objective: string;
      deliverables: string[];
      acceptanceCriteria: string[];
    };
    confirmation: ProjectDeliveryConfirmation;
    review: {
      reviewId: string;
      decision: 'accepted';
      reviewedAt: string;
      note: string;
      criteriaNotes: { index: number; note: string; criterionText?: string }[];
    };
    sourceNotes: ProjectDeliverySourceNotes;
    source: { runId: string; hash: string } | null;
    sourceFeedback: SourceNoteResolutions['items'];
    evidence: Evidence[];
    /** Selected metadata only: this snapshot never promises permanent file storage. */
    artifacts: SourceArtifact[];
  }[];
  hash: string;
}
export interface ProjectDeliveryManifestList {
  projectId: string;
  items: { id: string; title: string; createdAt: string; itemCount: number; hash: string }[];
  page: RecordPage;
}
/** 冻结内容与当前可用性分开返回，记录后来变化不改写已冻结清单。 */
export interface ProjectDeliveryManifestView {
  manifest: ProjectDeliveryManifest;
  /** Current record metadata only. No file bytes are read or verified by this view. */
  availability: {
    itemId: string;
    runId: string;
    run: 'available' | 'missing' | 'changed' | 'unavailable';
    artifacts: { id: string; state: 'available' | 'missing' | 'changed' | 'unavailable' }[];
  }[];
}

/** An explicit, byte-verified export preflight. It never changes the frozen manifest. */
export interface ProjectDeliveryBundlePlan {
  projectId: string;
  manifestId: string;
  manifestHash: string;
  format: 'zip';
  fileCount: number;
  /** Sum of known selected artifact sizes; missing sizes are null in files. */
  totalBytes: number;
  /** Exact ZIP size when every selected source was verified; otherwise null. */
  archiveBytes: number | null;
  /** Maximum complete ZIP size, including its metadata and index. */
  maxBytes: number;
  canDownload: boolean;
  files: {
    itemId: string;
    runId: string;
    artifactId: string;
    name: string;
    path: string;
    hash: string;
    size: number | null;
    state: 'ready' | 'missing' | 'changed' | 'unavailable' | 'too_large';
    reason?: string;
  }[];
  issues: { code: string; message: string }[];
}

/** Ephemeral export work, bound to one manifest and browser session. Not a delivery record. */
export const ProjectDeliveryBundleJobInput = z
  .object({
    jobId: z.string().uuid(),
    clientId: z.string().uuid().optional(),
    expectedManifestHash: digest,
    kind: z.enum(['check', 'download', 'save']),
  })
  .strict();
/** 临时导出工作进度；completed 仅表示本次工作结束，是否保存本地归档由 archive 单独证明。 */
export interface ProjectDeliveryBundleJob {
  id: string;
  clientId: string | null;
  projectId: string;
  manifestId: string;
  manifestHash: string;
  kind: 'check' | 'download' | 'save';
  stage: 'verifying' | 'preparing' | 'saving' | 'ready' | 'sending' | 'completed' | 'cancelled' | 'failed';
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  /** Unknown until the selected sizes have been read; exact ZIP size during preparation/send. */
  bytesTotal: number | null;
  currentFile: string | null;
  expiresAt: string;
  plan?: ProjectDeliveryBundlePlan;
  archive?: ProjectDeliveryArchive;
  error?: { code: string; message: string };
}
