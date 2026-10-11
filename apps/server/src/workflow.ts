import type { FastifyInstance } from 'fastify';
import { statSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  AppError,
  Evidence,
  invariant,
  minimumContextWindowTokens,
  type Artifact,
  type Message,
  type Project,
  type Run,
  type Task,
  type ProviderConfig,
} from '../../../packages/contracts/src/index.js';
import {
  NativeProjectDefaults,
  sourceTextByteLength,
  sourceTextLimitBytes,
  type NativeProjectDefaultsView,
  type RunSourceSelection,
  type RunSourceSnapshot,
  type SourceArtifact,
  type SourceMessage,
  type SourceOptions,
  type DeliveryReview,
  type DeliveryEvidence,
  type DeliveryEvidencePage,
  type DeliveryPage,
} from '../../../packages/contracts/src/workflow.js';
import { hash, id, now, stable, type Store } from '../../../packages/storage/src/index.js';
import { deliveryUserState, registerDeliveryLifecycle } from './delivery-lifecycle.js';
import { captureReviewSource } from './review-source.js';

const textLimit = sourceTextLimitBytes;
const artifactLimit = 8 * 1024 * 1024;
const publicArtifact = (a: Artifact): SourceArtifact => ({
  id: a.id,
  name: a.name.slice(0, 300),
  version: a.version,
  hash: a.hash,
  mediaType: a.mediaType,
  verified: a.verified,
});
function nativeRun(store: Store, runId: string) {
  const run = store.require<Run>('runs', runId);
  invariant((run.execution?.kind ?? 'native') === 'native', 'SOURCE_SURFACE', '只能在原生入口引用原生对话');
  return run;
}
function assertRevision(expected: number, actual: number) {
  if (expected !== actual)
    throw new AppError(
      'REVISION_CONFLICT',
      '记录已更新，请重新读取后确认',
      false,
      { currentRevision: actual },
      409,
    );
}
/** Source import is intentionally bounded and verifies bytes before retaining the reference. */
function boundedObject(store: Store, ref: string, limit: number) {
  const sqlite = /^sqlite:[a-f0-9]{64}$/.test(ref);
  invariant(
    sqlite || /^objects[\\/][a-f0-9]{2}[\\/][a-f0-9]{64}$/.test(ref),
    'INVALID_OBJECT',
    '来源对象引用无效',
  );
  // Schema migration can retain a legacy objects/... reference in compressed_objects.
  const meta = store.db
    .prepare('SELECT hash,raw_size,length(content) size FROM compressed_objects WHERE ref=?')
    .get(ref) as { hash: string; raw_size: number; size: number } | undefined;
  if (meta) {
    invariant(
      meta.raw_size <= limit && meta.size <= limit + 65536,
      'SOURCE_OBJECT_LIMIT',
      '所选来源文件过大，请选择不超过 8 MiB 的产物',
    );
    const row = store.db.prepare('SELECT content FROM compressed_objects WHERE ref=?').get(ref) as {
      content: Uint8Array;
    };
    const bytes = gunzipSync(row.content, { maxOutputLength: limit });
    invariant(
      bytes.length === meta.raw_size && hash(bytes) === meta.hash && ref.endsWith(meta.hash),
      'OBJECT_CORRUPT',
      '来源对象完整性核验失败',
    );
    return bytes;
  }
  invariant(!sqlite, 'OBJECT_NOT_FOUND', '来源对象不存在');
  invariant(
    statSync(path.join(store.directory, ref)).size <= limit,
    'SOURCE_OBJECT_LIMIT',
    '所选来源文件过大，请选择不超过 8 MiB 的产物',
  );
  return store.readObject(ref);
}
/** Do not hydrate native provider data, reasoning fields or tool payloads into the public source. */
function publicMessage(store: Store, messageId: string, runId: string): Message | null {
  const row = store.db
    .prepare('SELECT data,content FROM messages WHERE id=? AND run_id=?')
    .get(messageId, runId) as { data: string; content: Uint8Array | null } | undefined;
  invariant(row, 'SOURCE_MESSAGE_MISSING', '来源消息已不存在，请重新选择');
  const value = JSON.parse(
    row.content ? gunzipSync(row.content, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8') : row.data,
  ) as Message;
  if (value.contentRef)
    Object.assign(
      value,
      JSON.parse(boundedObject(store, value.contentRef, 4 * 1024 * 1024).toString('utf8')),
    );
  if (
    !['user', 'assistant'].includes(value.role) ||
    value.purpose ||
    value.calls?.length ||
    value.callId ||
    !value.text?.trim()
  )
    return null;
  return value;
}
export function sourceMessage(store: Store, runId: string, messageId: string): SourceMessage {
  nativeRun(store, runId);
  const message = publicMessage(store, messageId, runId);
  invariant(message, 'SOURCE_MESSAGE_PRIVATE', '只能读取公开用户或助手正文');
  const bytes = Buffer.from(message.text, 'utf8');
  // Drop an incomplete trailing UTF-8 sequence rather than changing the source text.
  const text =
    bytes.length <= textLimit
      ? message.text
      : bytes
          .subarray(0, textLimit)
          .toString('utf8')
          .replace(/\uFFFD$/, '');
  return {
    id: message.id,
    revision: message.revision,
    role: message.role as 'user' | 'assistant',
    text,
    truncated: bytes.length > textLimit,
  };
}
export function sourceOptions(
  store: Store,
  runId: string,
  beforeMessage?: string,
  beforeArtifact?: string,
): SourceOptions {
  const run = nativeRun(store, runId);
  let boundary: number | undefined;
  if (beforeMessage) {
    const row = store.db
      .prepare('SELECT rowid position FROM messages WHERE id=? AND run_id=?')
      .get(beforeMessage, run.id) as { position: number } | undefined;
    if (!row)
      throw new AppError('MESSAGE_CURSOR_MISSING', '来源消息位置已失效，请返回最新', false, null, 409);
    boundary = row.position;
  }
  // Scan one bounded raw page; empty public pages may still have an earlier page.
  const rows = store.db
    .prepare(
      `SELECT id FROM messages WHERE run_id=? ${boundary === undefined ? '' : 'AND rowid<?'} ORDER BY rowid DESC LIMIT 21`,
    )
    .all(...(boundary === undefined ? [run.id] : [run.id, boundary])) as { id: string }[];
  const selected = rows.slice(0, 20);
  const messages = selected.reverse().flatMap(({ id }) => {
    const m = publicMessage(store, id, run.id);
    return m
      ? [
          {
            id: m.id,
            revision: m.revision,
            role: m.role as 'user' | 'assistant',
            text: m.text.slice(0, 1600),
            truncated: m.text.length > 1600,
          },
        ]
      : [];
  });
  const artifacts = store.entityPage<Artifact>('artifacts', 20, beforeArtifact, run.id);
  return {
    runId: run.id,
    runRevision: run.revision,
    title: run.title,
    messages,
    messagePage: {
      hasMore: rows.length > 20,
      nextBefore: rows.length > 20 ? selected[0].id : null,
      before: beforeMessage ?? null,
      limit: 20,
    },
    artifacts: artifacts.items.map(publicArtifact),
    artifactPage: artifacts.page,
  };
}
export function captureRunSource(store: Store, selection: RunSourceSelection): RunSourceSnapshot {
  const source = nativeRun(store, selection.runId);
  assertRevision(selection.expectedRevision, source.revision);
  const reviewSource = captureReviewSource(store, source, selection);
  invariant(
    new Set(selection.messageIds).size === selection.messageIds.length &&
      new Set(selection.artifacts.map((a) => a.id)).size === selection.artifacts.length,
    'SOURCE_DUPLICATE',
    '来源选择不能重复',
  );
  const messages = selection.messageIds.map((messageId) => {
    const message = publicMessage(store, messageId, source.id);
    invariant(message, 'SOURCE_MESSAGE_PRIVATE', '只能选择公开用户或助手正文，工具与内部消息不能引用');
    return {
      id: message.id,
      revision: message.revision,
      role: message.role as 'user' | 'assistant',
      text: message.text,
    };
  });
  invariant(
    sourceTextByteLength(messages, selection.feedback) <= textLimit,
    'SOURCE_TEXT_LIMIT',
    '所选正文与修订说明合计超过 16 KiB，请减少消息选择',
  );
  let artifactBytes = 0;
  const artifacts = selection.artifacts.map((selected) => {
    const artifact = store.require<Artifact>('artifacts', selected.id);
    invariant(artifact.runId === source.id, 'SOURCE_ARTIFACT_SCOPE', '不能引用其他对话的产物');
    invariant(
      artifact.version === selected.version && artifact.hash === selected.hash,
      'SOURCE_ARTIFACT_CHANGED',
      '来源产物版本已变化，请重新选择',
    );
    const bytes = boundedObject(store, artifact.objectRef, artifactLimit);
    artifactBytes += bytes.length;
    invariant(
      artifactBytes <= 32 * 1024 * 1024,
      'SOURCE_OBJECT_LIMIT',
      '所选产物合计超过 32 MiB，请减少选择',
    );
    invariant(hash(bytes) === artifact.hash, 'OBJECT_CORRUPT', '来源产物哈希与内容不一致');
    return {
      ...publicArtifact(artifact),
      objectRef: artifact.objectRef,
      source: artifact.source.slice(0, 1000),
      importedId: id(),
    };
  });
  const snapshot = {
    version: 1 as const,
    runId: source.id,
    runRevision: source.revision,
    title: source.title,
    surface: 'native' as const,
    capturedAt: now(),
    feedback: selection.feedback,
    ...reviewSource,
    messages,
    artifacts,
    bundleArtifactId: id(),
  };
  invariant(
    Buffer.byteLength(stable(snapshot), 'utf8') <= (reviewSource.reviewNotes?.length ? 64 : 32) * 1024,
    'SOURCE_SNAPSHOT_LIMIT',
    `来源快照超过 ${reviewSource.reviewNotes?.length ? 64 : 32} KiB，请减少选择`,
  );
  return { ...snapshot, hash: hash(stable(snapshot)) };
}
export function attachRunSource(store: Store, run: Run, source: RunSourceSnapshot) {
  const bundle = store.object(stable(source));
  store.put<Artifact>('artifacts', {
    id: source.bundleArtifactId,
    revision: 0,
    runId: run.id,
    taskId: run.rootTaskId,
    name: '来源快照.json',
    ...bundle,
    source: `source-run:${source.runId}`,
    version: 1,
    verified: false,
    mediaType: 'application/json',
  });
  for (const artifact of source.artifacts)
    store.put<Artifact>('artifacts', {
      id: artifact.importedId,
      revision: 0,
      runId: run.id,
      taskId: run.rootTaskId,
      name: artifact.name,
      hash: artifact.hash,
      objectRef: artifact.objectRef,
      source: artifact.source,
      version: artifact.version,
      verified: false,
      mediaType: artifact.mediaType,
    });
  return store.put<Run>('runs', { ...run, source }, run.revision);
}
function deliveryState(store: Store, runId: string, expectedRootRevision?: number) {
  const run = nativeRun(store, runId),
    root = store.require<Task>('tasks', run.rootTaskId);
  if (expectedRootRevision !== undefined) assertRevision(expectedRootRevision, root.revision);
  const result =
    root.result && typeof root.result === 'object' ? (root.result as Record<string, unknown>) : {};
  const rawEvidence = Array.isArray(result.evidence) ? result.evidence : [];
  return { run, root, result, rawEvidence };
}
function deliveryPage(offset: number, limit: number, total: number): DeliveryPage {
  const hasMore = offset + limit < total;
  return { offset, limit, total, hasMore, nextOffset: hasMore ? offset + limit : null };
}
function publicEvidence(store: Store, runId: string, evidence: Evidence): DeliveryEvidence {
  const artifact = evidence.type === 'artifact' ? store.get<Artifact>('artifacts', evidence.ref) : undefined;
  return {
    type: evidence.type,
    ref: evidence.ref.slice(0, 1000),
    hash: evidence.hash?.slice(0, 100) ?? null,
    note: evidence.note.slice(0, 1500),
    artifact: artifact?.runId === runId ? publicArtifact(artifact) : null,
  };
}
/** Count matching evidence before paging it; unrelated criteria cannot consume this page's budget. */
function criterionEvidence(
  store: Store,
  runId: string,
  rawEvidence: unknown[],
  indices: number[],
  offset: number,
  limit: number,
) {
  const groups = new Map(indices.map((index) => [index, { total: 0, evidence: [] as DeliveryEvidence[] }]));
  for (const raw of rawEvidence) {
    if (!raw || typeof raw !== 'object') continue;
    const group = groups.get((raw as { criterion?: number }).criterion!);
    if (!group) continue;
    const parsed = Evidence.safeParse(raw);
    if (!parsed.success) continue;
    const position = group.total++;
    if (position >= offset && group.evidence.length < limit)
      group.evidence.push(publicEvidence(store, runId, parsed.data));
  }
  return groups;
}
export function deliveryEvidencePage(
  store: Store,
  runId: string,
  criterion: number,
  offset = 0,
  expectedRootRevision?: number,
): DeliveryEvidencePage {
  const { run, root, rawEvidence } = deliveryState(store, runId, expectedRootRevision);
  invariant(
    Number.isInteger(criterion) && criterion >= 0 && criterion < root.spec.acceptanceCriteria.length,
    'CRITERION_SCOPE',
    '验收项不存在，请重新读取交付记录',
  );
  const group = criterionEvidence(store, runId, rawEvidence, [criterion], offset, 20).get(criterion)!;
  return {
    runId: run.id,
    runRevision: run.revision,
    rootTaskId: root.id,
    rootRevision: root.revision,
    criterion,
    evidence: group.evidence,
    page: deliveryPage(offset, 20, group.total),
  };
}
export function deliveryReview(
  store: Store,
  runId: string,
  beforeArtifact?: string,
  criteriaOffset = 0,
  expectedRootRevision?: number,
): DeliveryReview {
  const { run, root, result, rawEvidence } = deliveryState(store, runId, expectedRootRevision);
  const criteriaPage = deliveryPage(criteriaOffset, 40, root.spec.acceptanceCriteria.length);
  const items = root.spec.acceptanceCriteria.slice(criteriaOffset, criteriaOffset + criteriaPage.limit);
  const groups = criterionEvidence(
    store,
    runId,
    rawEvidence,
    items.map((_, index) => index + criteriaOffset),
    0,
    2,
  );
  const criteria = items.map((text, pageIndex) => {
    const index = criteriaOffset + pageIndex,
      group = groups.get(index)!;
    return {
      index,
      text: text.slice(0, 2000),
      evidence: group.evidence,
      evidenceTotal: group.total,
      evidencePage: deliveryPage(0, 2, group.total),
    };
  });
  const artifacts = store.entityPage<Artifact>('artifacts', 20, beforeArtifact, run.id);
  return {
    ...deliveryUserState(store, run, root),
    runId: run.id,
    runRevision: run.revision,
    rootTaskId: root.id,
    rootRevision: root.revision,
    status: run.status,
    summary: typeof result.summary === 'string' ? result.summary.slice(0, 6000) : '',
    verifiedAt: typeof result.verifiedAt === 'string' ? result.verifiedAt.slice(0, 100) : null,
    limitation:
      '此处展示提交时的文件、引用与命令结构核验记录，不表示内容正确、符合需求或已由用户验收；文件后续变化需重新核对。',
    criteria,
    criteriaPage,
    criteriaHasMore: criteriaPage.hasMore,
    evidenceTruncated: criteria.some((criterion) => criterion.evidencePage.hasMore),
    artifacts: artifacts.items.map(publicArtifact),
    artifactPage: artifacts.page,
    source: run.source
      ? {
          runId: run.source.runId,
          title: run.source.title,
          capturedAt: run.source.capturedAt,
          hash: run.source.hash,
        }
      : null,
  };
}
export function registerWorkflow(
  app: FastifyInstance,
  store: Store,
  assertMutable: (runId: string | null, projectId?: string) => void,
) {
  registerDeliveryLifecycle(app, store, assertMutable);
  app.get<{ Params: { id: string; messageId: string } }>(
    '/api/runs/:id/handoff/messages/:messageId',
    async (request) => sourceMessage(store, request.params.id, request.params.messageId),
  );
  app.get<{ Params: { id: string } }>('/api/runs/:id/handoff', async (request) => {
    const query = z
      .object({ beforeMessage: z.string().uuid().optional(), beforeArtifact: z.string().uuid().optional() })
      .strict()
      .parse(request.query);
    return sourceOptions(store, request.params.id, query.beforeMessage, query.beforeArtifact);
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/delivery', async (request) => {
    const query = z
      .object({
        beforeArtifact: z.string().uuid().optional(),
        criteriaOffset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
        expectedRootRevision: z.coerce.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(request.query);
    return deliveryReview(
      store,
      request.params.id,
      query.beforeArtifact,
      query.criteriaOffset,
      query.expectedRootRevision,
    );
  });
  app.get<{ Params: { id: string; index: string } }>(
    '/api/runs/:id/delivery/criteria/:index/evidence',
    async (request) => {
      const criterion = z.coerce
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .parse(request.params.index);
      const query = z
        .object({
          offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
          expectedRootRevision: z.coerce.number().int().nonnegative().optional(),
        })
        .strict()
        .parse(request.query);
      return deliveryEvidencePage(
        store,
        request.params.id,
        criterion,
        query.offset,
        query.expectedRootRevision,
      );
    },
  );
  const view = (project: Project): NativeProjectDefaultsView => ({
    projectId: project.id,
    revision: project.revision,
    defaults: project.nativeDefaults ?? null,
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/native-defaults', async (request) =>
    view(store.require<Project>('projects', request.params.id)),
  );
  app.put<{ Params: { id: string } }>('/api/projects/:id/native-defaults', async (request) => {
    const body = z
      .object({
        commandId: z.string().uuid(),
        expectedRevision: z.number().int().nonnegative(),
        defaults: NativeProjectDefaults.nullable(),
      })
      .strict()
      .parse(request.body);
    return store.command(
      body.commandId,
      { route: `/projects/${request.params.id}/native-defaults`, body },
      () => {
        const project = store.require<Project>('projects', request.params.id);
        assertMutable(null, project.id);
        assertRevision(body.expectedRevision, project.revision);
        invariant(!project.archived, 'PROJECT_ARCHIVED', '请先恢复项目再修改默认配置');
        if (body.defaults?.modelChoice) {
          const provider = store.require<ProviderConfig>('providers', body.defaults.modelChoice.providerId);
          invariant(!provider.archived, 'PROVIDER_ARCHIVED', '模型连接已归档，请重新选择');
          invariant(provider.checkedRevision === provider.revision, 'PROVIDER_UNCHECKED', '请先验证模型连接');
          invariant(
            body.defaults.contextPolicy?.mode !== 'manual' ||
              body.defaults.contextPolicy.windowTokens! <= provider.contextLimit,
            'CONTEXT_LIMIT',
            '默认窗口超过连接的上下文容量',
          );
          invariant(
            body.defaults.contextPolicy?.mode !== 'manual' ||
              body.defaults.contextPolicy.windowTokens! >= minimumContextWindowTokens(provider),
            'CONTEXT_LIMIT',
            '默认窗口不足以容纳模型输出和安全预留',
          );
        }
        return view(
          store.put<Project>('projects', { ...project, nativeDefaults: body.defaults }, project.revision),
        );
      },
    );
  });
}
