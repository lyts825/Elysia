/**
 * 项目交付项、验收与交付状态的校验和契约。
 * 看板、验收、冻结清单与导出工作各有版本边界，防止旧确认套用到新内容。
 *
 * EN: Validates and defines project deliverables, acceptance, and delivery state.
 * Boards, acceptance, frozen manifests, and exports have distinct version boundaries so old confirmations cannot apply to new content.
 */
import { z } from 'zod';
import type { Status, Evidence } from './index.js';
import type { DeliveryReviewStatus, SourceArtifact, SourceNoteResolutions } from './workflow.js';
import type { ExecutionHold, RecordPage } from './run-reads.js';
import type { ProjectDeliveryArchive } from './project-delivery-archive.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const line = z.string().trim().min(1).max(2000);
/**
 * 一项交付要求至少一条交付物和验收标准，并区分是否必需。
 *
 * EN: Each delivery item needs at least one deliverable and criterion and explicitly records whether it is required.
 */
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
/**
 * 看板整体编辑命令，expectedRevision 防止覆盖其他窗口对目标或条目的修改。
 *
 * EN: An atomic board-edit command; expectedRevision prevents overwriting goal or item edits from another window.
 */
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
/**
 * 将一次任务绑定到某交付项，绑定前必须仍匹配看板修订。
 *
 * EN: Binds a run to a delivery item only while the board revision still matches.
 */
export const ProjectDeliveryBinding = z
  .object({ itemId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
  .strict();
export type ProjectDeliveryBinding = z.infer<typeof ProjectDeliveryBinding>;
/**
 * 用户确认的是特定条目修订及运行交付指纹，后续任一内容变化可使该确认过期。
 *
 * EN: User confirmation binds an item revision and run-delivery fingerprint; later changes to either can stale the confirmation.
 */
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
/**
 * 交付项关联任务的轻量当前视图；无法核验时用 missing/issue 表达，而非伪造已完成状态。
 *
 * EN: A lightweight current view of the run linked to an item; unverifiable state is reported as missing/issue instead of fabricated completion.
 */
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
/**
 * ready 需任务结束、人工审核/确认和来源反馈均有效；其他值说明阻止冻结的具体阶段。
 *
 * EN: ready requires valid completion, human review/confirmation, and source feedback; other values identify the stage blocking freezing.
 */
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
/**
 * 项目看板保存交付范围、条目及汇总计数；revision 用于识别并发变化。
 *
 * EN: The project board stores delivery scope, items, and summary counts; revision detects concurrent changes.
 */
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
/**
 * 单项交付的历次任务关联，current 指出当前采用的尝试，其余保留供追溯。
 *
 * EN: Historical run bindings for one delivery item; current selects the active attempt while others remain traceable.
 */
export interface ProjectDeliveryAttempts {
  projectId: string;
  itemId: string;
  boardRevision: number;
  items: (ProjectDeliveryRunSummary & { linkedAt: string; current: boolean })[];
  page: RecordPage;
}
/**
 * 冻结交付时绑定条目、运行、根任务、审核及指纹的预期版本。
 *
 * EN: Expected versions of item, run, root task, review, and fingerprints required when freezing delivery.
 */
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
/**
 * 清单记录交付创建时的项目、条目与运行快照，供后续核对。
 *
 * EN: The manifest records project, item, and run snapshots at delivery creation for later comparison.
 */
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
    /**
     * 仅包含所选元数据；此快照不承诺永久保留文件。
     *
     * EN: Selected metadata only: this snapshot never promises permanent file storage.
     */
    artifacts: SourceArtifact[];
  }[];
  hash: string;
}
export interface ProjectDeliveryManifestList {
  projectId: string;
  items: { id: string; title: string; createdAt: string; itemCount: number; hash: string }[];
  page: RecordPage;
}
/**
 * 冻结内容与当前可用性分开返回，记录后来变化不改写已冻结清单。
 *
 * EN: Frozen content and current availability are returned separately; later record changes never rewrite the frozen manifest.
 */
export interface ProjectDeliveryManifestView {
  manifest: ProjectDeliveryManifest;
  /**
   * 仅提供当前记录元数据；该视图不读取或校验文件字节。
   *
   * EN: Current record metadata only. No file bytes are read or verified by this view.
   */
  availability: {
    itemId: string;
    runId: string;
    run: 'available' | 'missing' | 'changed' | 'unavailable';
    artifacts: { id: string; state: 'available' | 'missing' | 'changed' | 'unavailable' }[];
  }[];
}

/**
 * 显式、按字节核验的导出预检，始终不修改冻结清单。
 *
 * EN: An explicit, byte-verified export preflight. It never changes the frozen manifest.
 */
export interface ProjectDeliveryBundlePlan {
  projectId: string;
  manifestId: string;
  manifestHash: string;
  format: 'zip';
  fileCount: number;
  /**
   * 所选产物已知大小之和；缺失大小在 files 中表示为 null。
   *
   * EN: Sum of known selected artifact sizes; missing sizes are null in files.
   */
  totalBytes: number;
  /**
   * 所有所选来源均已核验时的精确 ZIP 大小，否则为 null。
   *
   * EN: Exact ZIP size when every selected source was verified; otherwise null.
   */
  archiveBytes: number | null;
  /**
   * 完整 ZIP 的最大大小，包含元数据和索引。
   *
   * EN: Maximum complete ZIP size, including its metadata and index.
   */
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

/**
 * 绑定某个清单和浏览器会话的临时导出工作，不是交付记录。
 *
 * EN: Ephemeral export work, bound to one manifest and browser session. Not a delivery record.
 */
export const ProjectDeliveryBundleJobInput = z
  .object({
    jobId: z.string().uuid(),
    clientId: z.string().uuid().optional(),
    expectedManifestHash: digest,
    kind: z.enum(['check', 'download', 'save']),
  })
  .strict();
/**
 * 临时导出工作进度；completed 仅表示本次工作结束，是否保存本地归档由 archive 单独证明。
 *
 * EN: Progress of ephemeral export work; completed means only that this job ended, while archive independently proves retention of a local archive.
 */
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
  /**
   * 读取所选大小前未知；准备及发送阶段表示精确 ZIP 大小。
   *
   * EN: Unknown until the selected sizes have been read; exact ZIP size during preparation/send.
   */
  bytesTotal: number | null;
  currentFile: string | null;
  expiresAt: string;
  plan?: ProjectDeliveryBundlePlan;
  archive?: ProjectDeliveryArchive;
  error?: { code: string; message: string };
}
