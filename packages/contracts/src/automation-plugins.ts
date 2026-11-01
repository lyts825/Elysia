/**
 * 定义项目事件、订阅、路由提案和回信的有界契约。
 * 外部正文仅是资料；来源权限不授予任务执行权限，凭据只保存宿主引用。
 * EN: Defines bounded project events, subscriptions, routing proposals and replies.
 * External text is data; source permissions never grant execution authority, and credentials remain host references.
 */
import { z } from 'zod';

export const AUTOMATION_LIMITS = Object.freeze({
  page: 50,
  batch: 50,
  sources: 100,
  subscriptions: 100,
  configBytes: 64 * 1024,
  eventBytes: 96 * 1024,
  batchBytes: 512 * 1024,
  textChars: 16000,
  previewChars: 600,
  dispatch: 20,
  attempts: 5,
  retryBaseMs: 5000,
  retryMaxMs: 300000,
});

const key = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive();
export const AutomationScope = z
  .object({
    conversationIds: z
      .array(key.refine((value) => value !== '*', '必须列出具体会话'))
      .min(1)
      .max(100),
    receive: z.boolean(),
    reply: z.boolean(),
  })
  .strict()
  .refine((value) => new Set(value.conversationIds).size === value.conversationIds.length, '会话不能重复');
export type AutomationScope = z.infer<typeof AutomationScope>;

export const AutomationCredentialBinding = z
  .object({
    reference: z.string().min(1).max(256),
    revision: z.string().min(1).max(128),
  })
  .strict();
export type AutomationCredentialBinding = z.infer<typeof AutomationCredentialBinding>;

export const AutomationSourceConfiguration = z
  .object({
    id: z.string().uuid().optional(),
    expectedRevision: revision.optional(),
    title: z.string().trim().min(1).max(160),
    source: key,
    channel: key.nullable().default(null),
    router: key.nullable().default(null),
    config: z.record(z.string(), z.unknown()),
    credentialBinding: AutomationCredentialBinding.nullable().default(null),
    scope: AutomationScope,
    enabled: z.boolean().default(false),
  })
  .strict();
export type AutomationSourceConfiguration = z.infer<typeof AutomationSourceConfiguration>;

export const AutomationSourceInstance = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    revision,
    title: z.string().max(160),
    source: key,
    channel: key.nullable(),
    router: key.nullable(),
    credentialBinding: AutomationCredentialBinding.nullable(),
    scope: AutomationScope,
    enabled: z.boolean(),
    configRef: key,
    authorityHash: digest,
    cursor: z.string().max(4096).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AutomationSourceInstance = z.infer<typeof AutomationSourceInstance>;

export const AutomationSourceLease = AutomationSourceInstance.pick({
  id: true,
  projectId: true,
  revision: true,
  authorityHash: true,
  source: true,
});
export type AutomationSourceLease = z.infer<typeof AutomationSourceLease>;

export const AutomationIncomingEvent = z
  .object({
    eventId: key,
    revision: z.string().min(1).max(128),
    conversationId: key,
    actor: z.object({ id: key, kind: z.enum(['human', 'bot', 'system']) }).strict(),
    occurredAt: z.string().datetime(),
    text: z.string().max(AUTOMATION_LIMITS.textChars),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type AutomationIncomingEvent = z.infer<typeof AutomationIncomingEvent>;

export const AutomationSourceBatch = z
  .object({
    expectedCursor: z.string().max(4096).nullable(),
    nextCursor: z.string().max(4096).nullable(),
    events: z.array(AutomationIncomingEvent).max(AUTOMATION_LIMITS.batch),
  })
  .strict();
export type AutomationSourceBatch = z.infer<typeof AutomationSourceBatch>;

export const AutomationStoredEvent = z
  .object({
    id: digest,
    source: AutomationSourceLease,
    eventId: key,
    eventRevision: z.string().min(1).max(128),
    conversationId: key,
    actor: AutomationIncomingEvent.shape.actor,
    occurredAt: z.string().datetime(),
    receivedAt: z.string().datetime(),
    bodyRef: key,
    bodyHash: digest,
    preview: z.string().max(AUTOMATION_LIMITS.previewChars),
  })
  .strict();
export type AutomationStoredEvent = z.infer<typeof AutomationStoredEvent>;

export const AutomationSubscription = z
  .object({
    id: digest,
    source: AutomationSourceLease,
    conversationId: key,
    runId: z.string().uuid(),
    active: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AutomationSubscription = z.infer<typeof AutomationSubscription>;

export const AutomationRouteProposal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ignore'), summary: z.string().min(1).max(600) }).strict(),
  z.object({ kind: z.literal('suggest-run'), summary: z.string().min(1).max(600) }).strict(),
  z
    .object({
      kind: z.literal('suggest-attach'),
      runId: z.string().uuid(),
      summary: z.string().min(1).max(600),
    })
    .strict(),
]);
export type AutomationRouteProposal = z.infer<typeof AutomationRouteProposal>;

export const AutomationCandidate = z
  .object({
    id: digest,
    eventId: digest,
    source: AutomationSourceLease,
    conversationId: key,
    status: z.enum(['candidate', 'proposed', 'dismissed', 'stale']),
    preview: z.string().max(600),
    proposal: AutomationRouteProposal.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AutomationCandidate = z.infer<typeof AutomationCandidate>;

export const AutomationContextInput = z
  .object({
    id: digest,
    eventId: digest,
    source: AutomationSourceLease,
    runId: z.string().uuid(),
    kind: z.literal('context'),
    status: z.enum(['pending', 'observed', 'stale']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AutomationContextInput = z.infer<typeof AutomationContextInput>;

export const AutomationReplyRequest = z
  .object({
    messageId: z.string().min(1).max(128),
    expectedSourceRevision: revision,
    conversationId: key,
    text: z.string().trim().min(1).max(AUTOMATION_LIMITS.textChars),
    eventId: digest.optional(),
  })
  .strict();
export type AutomationReplyRequest = z.infer<typeof AutomationReplyRequest>;

export const AutomationOutboxMessage = z
  .object({
    id: digest,
    messageId: z.string().max(128),
    source: AutomationSourceLease,
    conversationId: key,
    eventId: digest.nullable(),
    messageRef: key,
    messageHash: digest,
    preview: z.string().max(600),
    status: z.enum(['pending', 'sending', 'retry', 'sent', 'unknown', 'failed', 'cancelled']),
    attempts: z.number().int().nonnegative(),
    dueAt: z.number().int().nonnegative(),
    cancelRequested: z.boolean(),
    lastOutcome: z.enum(['sent', 'not-sent', 'unknown']).nullable(),
    reason: z.string().max(1000),
    receipt: z.string().max(2048).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AutomationOutboxMessage = z.infer<typeof AutomationOutboxMessage>;

export const AutomationDeliveryResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('sent'), receipt: z.string().min(1).max(2048) }).strict(),
  z
    .object({ status: z.literal('not-sent'), retryable: z.boolean(), reason: z.string().min(1).max(1000) })
    .strict(),
  z.object({ status: z.literal('unknown'), reason: z.string().min(1).max(1000) }).strict(),
]);
export type AutomationDeliveryResult = z.infer<typeof AutomationDeliveryResult>;

export const AutomationPageQuery = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(AUTOMATION_LIMITS.page).default(20),
  })
  .strict();
export type AutomationPageQuery = z.infer<typeof AutomationPageQuery>;
export interface AutomationPage<T> {
  items: T[];
  nextAfter: number | null;
}
