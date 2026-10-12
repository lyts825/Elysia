import { z } from 'zod';
import type { Status, Evidence } from './index.js';
import type { DeliveryReviewStatus, SourceArtifact, SourceNoteResolutions } from './workflow.js';
import type { ExecutionHold, RecordPage } from './run-reads.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const line = z.string().trim().min(1).max(2000);
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
export const ProjectDeliveryBinding = z
  .object({ itemId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
  .strict();
export type ProjectDeliveryBinding = z.infer<typeof ProjectDeliveryBinding>;
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
export interface ProjectDeliveryAttempts {
  projectId: string;
  itemId: string;
  boardRevision: number;
  items: (ProjectDeliveryRunSummary & { linkedAt: string; current: boolean })[];
  page: RecordPage;
}
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
    kind: z.enum(['check', 'download']),
  })
  .strict();
export interface ProjectDeliveryBundleJob {
  id: string;
  clientId: string | null;
  projectId: string;
  manifestId: string;
  manifestHash: string;
  kind: 'check' | 'download';
  stage: 'verifying' | 'preparing' | 'ready' | 'sending' | 'completed' | 'cancelled' | 'failed';
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  /** Unknown until the selected sizes have been read; exact ZIP size during preparation/send. */
  bytesTotal: number | null;
  currentFile: string | null;
  expiresAt: string;
  plan?: ProjectDeliveryBundlePlan;
  error?: { code: string; message: string };
}
