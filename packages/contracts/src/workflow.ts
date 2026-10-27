// 项目工作流、运行来源和交付评审的契约。
import { z } from 'zod';
import { Budget, ContextPolicy, ModelChoice } from './index.js';
import type { RecordPage } from './run-reads.js';

// 项目默认值只提供创建任务的初始配置，模型和上下文策略可缺省。
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
export const artifactChangeTextLimitBytes = 16 * 1024;
export const artifactChangeSnapshotLimitBytes = 32 * 1024;
/** 用户明确选择的历史产物差异与修改要求，不自动选择旧产物字节。 */
export const ArtifactChangeSelection = z
  .object({
    reviewId: z.string().uuid(),
    artifactId: z.string().uuid(),
    requirement: z
      .string()
      .max(2000)
      .refine((value) => !!value.trim(), '请填写具体修改要求'),
  })
  .strict();
export type ArtifactChangeSelection = z.infer<typeof ArtifactChangeSelection>;
// 需求长度按 UTF-8 字节计算，而不是 JavaScript 字符数。
export function artifactChangeTextByteLength(items: readonly Pick<ArtifactChangeSelection, 'requirement'>[]) {
  const encoder = new TextEncoder();
  return items.reduce((total, item) => total + encoder.encode(item.requirement).length, 0);
}
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
/** 单独累计用户选择的备注正文预算，不把备注元数据误算为可编辑反馈。 */
export function reviewSourceTextByteLength(notes: readonly Pick<ReviewSourceNote, 'note'>[]): number {
  const encoder = new TextEncoder();
  return notes.reduce((bytes, item) => bytes + encoder.encode(item.note).length, 0);
}
// 序列化完整备注并统一缺省 reviewId，再计算快照实际占用的 UTF-8 字节数。
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
// 来源选择绑定运行的预期修订和明确选中的资料，避免自动引入整个历史。
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
    artifactChanges: z.array(ArtifactChangeSelection).max(20).default([]),
    expectedDeliveryFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.feedback && !value.reviewNotes.length && !value.artifactChanges.length)
      context.addIssue({ code: 'custom', path: ['feedback'], message: '请填写修改意见或明确选择复核备注' });
    if (
      !value.messageIds.length &&
      !value.artifacts.length &&
      !value.reviewNotes.length &&
      !value.artifactChanges.length
    )
      context.addIssue({ code: 'custom', message: '至少选择一条消息、一个产物、一条复核备注或产物差异' });
    if ((value.reviewNotes.length || value.artifactChanges.length) && !value.expectedDeliveryFingerprint)
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
/** 人工复核命令同时绑定运行、根任务和交付指纹，避免把旧页面的接受意见用于新内容。 */
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
// 用户复核与运行状态独立；关联的指纹用于识别后续交付内容变化。
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
/** 基线不可读时返回 unknown；不能把无法比较表达成“无变化”。 */
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
/** 历史与当前元数据比较；removed 仅证明旧记录存在，不承诺旧文件还可读取。 */
export interface DeliveryArtifactChange {
  artifactId: string;
  kind: 'added' | 'removed' | 'changed';
  before: DeliveryArtifactMetadata | null;
  after: DeliveryArtifactMetadata | null;
  /** Only the artifact in the current run may use the existing preview entry point. */
  currentArtifactId: string | null;
}
export interface SourceArtifactChange extends DeliveryArtifactChange {
  reviewId: string;
  reviewFingerprint: string;
  currentFingerprint: string;
  requirement: string;
}
export const SourceNoteResolutionStatus = z.enum(['pending', 'resolved', 'needs_changes']);
export type SourceNoteResolutionStatus = z.infer<typeof SourceNoteResolutionStatus>;
/** 来源备注处理命令绑定来源快照、当前交付和该备注处理修订，防止跨版本误标已解决。 */
export const SourceNoteResolutionInput = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    expectedRootRevision: z.number().int().nonnegative(),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    noteIndex: z.number().int().min(0).max(39),
    expectedResolutionRevision: z.number().int().nonnegative(),
    status: SourceNoteResolutionStatus,
    note: z.string().max(1000),
    criterionIndex: z.number().int().nonnegative().nullable(),
    evidenceIndices: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).max(10),
  })
  .strict();
export type SourceNoteResolutionInput = z.infer<typeof SourceNoteResolutionInput>;
/** 一次备注处理结论与当时选中的验收证据；当前交付变化后 stale 可使结论失效。 */
export interface SourceNoteResolution {
  revision: number;
  status: SourceNoteResolutionStatus;
  note: string;
  criterionIndex: number | null;
  criterionText: string | null;
  evidence: (DeliveryEvidence & { index: number })[];
  fingerprint: string;
  updatedAt: string;
  stale: boolean;
}
export interface SourceNoteResolutions {
  runId: string;
  runRevision: number;
  rootRevision: number;
  currentFingerprint: string;
  sourceHash: string | null;
  writable: boolean;
  items: { noteIndex: number; sourceNote: ReviewSourceNote; resolution: SourceNoteResolution | null }[];
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
/** 保留审核历史及兼容记录的覆盖说明，possibleGaps 不能被列表为空掩盖。 */
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
/** 按冻结来源追溯祖先；缺失记录、扫描上限和环路分别表达，不能无限追溯。 */
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
/** 创建续接任务前可选的公开消息与产物目录，分页结果不表示整个历史已加载。 */
export interface SourceOptions {
  runId: string;
  runRevision: number;
  title: string;
  messages: SourceMessage[];
  messagePage: { hasMore: boolean; nextBefore: string | null; before: string | null; limit: number };
  artifacts: SourceArtifact[];
  artifactPage: RecordPage;
}
/**
 * 新任务创建时冻结的选定来源资料。importedId 是新任务内的产物身份，bundleArtifactId
 * 指向完整来源说明；旧权限、预算、内部工具调用和供应商私有状态不随资料继承。
 */
export interface RunSourceSnapshot {
  version: 1;
  runId: string;
  runRevision: number;
  title: string;
  surface: 'native';
  capturedAt: string;
  feedback: string;
  reviewNotes?: ReviewSourceNote[];
  artifactChanges?: SourceArtifactChange[];
  capturedDeliveryFingerprint?: string;
  messages: Omit<SourceMessage, 'truncated'>[];
  artifacts: (SourceArtifact & { objectRef: string; source: string; importedId: string })[];
  bundleArtifactId: string;
  hash: string;
}
/** 一条展示证据及可选产物元数据；正文需按其真实类型通过专用入口读取。 */
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
/** 验收项只内联当前证据页，evidenceTotal 和 evidencePage 表达尚未读取的部分。 */
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
/** 人工验收视图：当前执行结果、证据分页、产物目录和用户复核状态共同呈现。 */
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
