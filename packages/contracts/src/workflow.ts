import { z } from 'zod';
import { Budget, ContextPolicy, ModelChoice } from './index.js';
import type { RecordPage } from './run-reads.js';

export const NativeProjectDefaults = z
  .object({
    modelChoice: ModelChoice.optional(),
    contextPolicy: ContextPolicy.optional(),
    planMode: z.boolean(),
    budget: Budget,
    concurrency: z.number().int().min(1).max(4),
  })
  .strict();
export type NativeProjectDefaults = z.infer<typeof NativeProjectDefaults>;
export interface NativeProjectDefaultsView {
  projectId: string;
  revision: number;
  defaults: NativeProjectDefaults | null;
}
export type NativeProjectDefaultsRecord = NativeProjectDefaultsView;
export const sourceTextLimitBytes = 16 * 1024;
export const reviewSourceTextLimitBytes = 16 * 1024;
export const reviewSourceSnapshotLimitBytes = 32 * 1024;
/** Explicitly selected review material has a separate budget from editable feedback. */
export const ReviewSourceNote = z
  .object({
    origin: z.enum(['saved', 'draft']),
    reviewId: z.string().uuid().nullable().optional(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    criterionIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    criterionText: z.string().max(20000).nullable(),
    note: z
      .string()
      .max(4000)
      .refine((value) => !!value.trim(), '备注不能为空'),
  })
  .strict()
  .refine((value) => value.origin !== 'draft' || !value.reviewId, '本机备注资料不能冒用已保存复核记录标识');
export type ReviewSourceNote = z.infer<typeof ReviewSourceNote>;
export function reviewSourceTextByteLength(notes: readonly Pick<ReviewSourceNote, 'note'>[]): number {
  const encoder = new TextEncoder();
  return notes.reduce((bytes, item) => bytes + encoder.encode(item.note).length, 0);
}
export function reviewSourceSnapshotByteLength(notes: readonly ReviewSourceNote[]): number {
  return new TextEncoder().encode(
    JSON.stringify(notes.map((note) => ({ ...note, reviewId: note.reviewId ?? null }))),
  ).length;
}
/** Count captured public text only; source metadata has its own snapshot size limit. */
export function sourceTextByteLength(messages: readonly { text: string }[], feedback: string): number {
  const encoder = new TextEncoder();
  return messages.reduce(
    (bytes, message) => bytes + encoder.encode(message.text).length,
    encoder.encode(feedback.trim()).length,
  );
}
export const RunSourceSelection = z
  .object({
    runId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    messageIds: z.array(z.string().uuid()).max(10),
    artifacts: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            version: z.number().int().positive(),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(10),
    feedback: z.string().trim().max(4000),
    reviewNotes: z.array(ReviewSourceNote).max(40).default([]),
    expectedDeliveryFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.feedback && !value.reviewNotes.length)
      context.addIssue({ code: 'custom', path: ['feedback'], message: '请填写修改意见或明确选择复核备注' });
    if (!value.messageIds.length && !value.artifacts.length && !value.reviewNotes.length)
      context.addIssue({ code: 'custom', message: '至少选择一条消息、一个产物或一条复核备注' });
    if (value.reviewNotes.length && !value.expectedDeliveryFingerprint)
      context.addIssue({
        code: 'custom',
        path: ['expectedDeliveryFingerprint'],
        message: '请核对来源交付版本',
      });
  });
export type RunSourceSelection = z.infer<typeof RunSourceSelection>;
export type DeliveryReviewStatus = 'unreviewed' | 'accepted' | 'changes_requested' | 'stale';
export interface DeliveryReviewIssue {
  code: 'DELIVERY_UNREADABLE';
  message: string;
  retryable: true;
}
export interface DeliveryReviewSummary {
  runId: string;
  reviewStatus: DeliveryReviewStatus | null;
  reviewedAt: string | null;
  reviewIssue?: DeliveryReviewIssue;
}
export const RunDeliveryItems = z.array(z.string().trim().min(1).max(2000)).min(1).max(40);
export const DeliveryReviewInput = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    expectedRootRevision: z.number().int().nonnegative(),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['accepted', 'changes_requested']),
    note: z.string().max(4000),
    criteriaNotes: z
      .array(z.object({ index: z.number().int().nonnegative(), note: z.string().max(1000) }).strict())
      .max(40),
  })
  .strict();
export interface DeliveryUserReview {
  reviewId?: string;
  decision: 'accepted' | 'changes_requested';
  note: string;
  criteriaNotes: { index: number; note: string; criterionText?: string }[];
  fingerprint: string;
  reviewedAt: string;
  rootTaskId: string;
  rootRevision: number;
}
export interface DeliveryChangeSummary {
  baseline: 'known' | 'unknown';
  status: 'unchanged' | 'changed' | 'unknown';
  reason?: 'baseline_missing' | 'baseline_invalid' | 'current_unreadable';
  fields: {
    root: boolean;
    status: boolean;
    deliverables: boolean;
    criteria: boolean;
    result: boolean;
  } | null;
  artifacts: { added: number; removed: number; changed: number } | null;
}
/** Immutable comparison metadata; it does not promise that an old object is still available. */
export interface DeliveryArtifactMetadata {
  id: string;
  taskId: string;
  name: string;
  version: number;
  hash: string;
  mediaType: string;
  verified: boolean;
}
export interface DeliveryArtifactChange {
  artifactId: string;
  kind: 'added' | 'removed' | 'changed';
  before: DeliveryArtifactMetadata | null;
  after: DeliveryArtifactMetadata | null;
  /** Only the artifact in the current run may use the existing preview entry point. */
  currentArtifactId: string | null;
}
export interface DeliveryArtifactChangePage {
  runId: string;
  reviewId: string;
  currentFingerprint: string;
  changeSummary: DeliveryChangeSummary;
  items: DeliveryArtifactChange[];
  /** Unknown comparison metadata has no page, rather than a misleading zero total. */
  page: DeliveryPage | null;
}
export interface DeliveryReviewHistoryItem {
  id: string;
  decision: DeliveryUserReview['decision'];
  reviewedAt: string;
  fingerprint: string;
  notePreview: string;
  criteriaNotesCount: number;
  origin: 'saved' | 'legacy_snapshot';
  baselineAvailable: boolean;
}
export interface DeliveryReviewHistory {
  runId: string;
  items: DeliveryReviewHistoryItem[];
  page: RecordPage;
  coverage: { sinceVersion: '0.27.0-preview.1'; possibleGaps: boolean; legacyCount: number };
}
export interface DeliveryReviewHistoryDetail {
  runId: string;
  item: DeliveryReviewHistoryItem;
  review: DeliveryUserReview;
  changeSummary: DeliveryChangeSummary;
  currentFingerprint: string | null;
  runRevision: number;
  rootRevision: number | null;
}
export interface DeliveryReviewState {
  runId: string;
  runRevision: number;
  rootRevision: number;
  fingerprint: string;
  userReview: (DeliveryUserReview & { stale: boolean }) | null;
  changeSummary: DeliveryChangeSummary | null;
}
export interface RunRevisionItem {
  runId: string;
  title: string;
  kind: 'task' | 'chat';
  status: string;
  projectId: string | null;
  archived: boolean;
  createdAt: string;
  sourceRunId: string | null;
}
export interface RunRevisions {
  runId: string;
  items: RunRevisionItem[];
  page: RecordPage;
}
export interface RunLineage {
  runId: string;
  ancestors: {
    runId: string;
    title: string;
    kind: 'task' | 'chat' | null;
    status: string | null;
    projectId: string | null;
    archived: boolean | null;
    missing: boolean;
    capturedAt: string;
  }[];
  hasMore: boolean;
  cycleDetected: boolean;
}
export interface SourceMessage {
  id: string;
  revision: number;
  role: 'user' | 'assistant';
  text: string;
  truncated: boolean;
}
export interface SourceArtifact {
  id: string;
  name: string;
  version: number;
  hash: string;
  mediaType: string;
  verified: boolean;
}
export interface SourceOptions {
  runId: string;
  runRevision: number;
  title: string;
  messages: SourceMessage[];
  messagePage: { hasMore: boolean; nextBefore: string | null; before: string | null; limit: number };
  artifacts: SourceArtifact[];
  artifactPage: RecordPage;
}
export interface RunSourceSnapshot {
  version: 1;
  runId: string;
  runRevision: number;
  title: string;
  surface: 'native';
  capturedAt: string;
  feedback: string;
  reviewNotes?: ReviewSourceNote[];
  capturedDeliveryFingerprint?: string;
  messages: Omit<SourceMessage, 'truncated'>[];
  artifacts: (SourceArtifact & { objectRef: string; source: string; importedId: string })[];
  bundleArtifactId: string;
  hash: string;
}
export interface DeliveryEvidence {
  type: 'file' | 'artifact' | 'command';
  ref: string;
  hash: string | null;
  note: string;
  artifact: SourceArtifact | null;
}
export interface DeliveryPage {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
}
export interface DeliveryCriterion {
  index: number;
  text: string;
  evidence: DeliveryEvidence[];
  evidenceTotal: number;
  evidencePage: DeliveryPage;
}
export interface DeliveryEvidencePage {
  runId: string;
  runRevision: number;
  rootTaskId: string;
  rootRevision: number;
  criterion: number;
  evidence: DeliveryEvidence[];
  page: DeliveryPage;
}
export interface DeliveryReview extends DeliveryReviewState {
  runId: string;
  runRevision: number;
  rootTaskId: string;
  rootRevision: number;
  status: string;
  summary: string;
  verifiedAt: string | null;
  limitation: string;
  criteria: DeliveryCriterion[];
  criteriaPage: DeliveryPage;
  criteriaHasMore: boolean;
  evidenceTruncated: boolean;
  artifacts: SourceArtifact[];
  artifactPage: RecordPage;
  source: { runId: string; title: string; capturedAt: string; hash: string } | null;
}
