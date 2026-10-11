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
    feedback: z.string().trim().min(1).max(4000),
  })
  .strict();
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
  decision: 'accepted' | 'changes_requested';
  note: string;
  criteriaNotes: { index: number; note: string; criterionText?: string }[];
  fingerprint: string;
  reviewedAt: string;
  rootTaskId: string;
  rootRevision: number;
}
export interface DeliveryReviewState {
  runId: string;
  runRevision: number;
  rootRevision: number;
  fingerprint: string;
  userReview: (DeliveryUserReview & { stale: boolean }) | null;
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
