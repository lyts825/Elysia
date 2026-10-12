import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  Evidence,
  invariant,
  type Artifact,
  type Project,
  type Run,
  type Task,
} from '../../../packages/contracts/src/index.js';
import {
  ProjectDeliveryBoardInput,
  ProjectDeliveryItemInput,
  ProjectDeliveryManifestInput,
  ProjectDeliveryBundleJobInput,
  type ProjectDeliveryBinding,
  type ProjectDeliveryBoard,
  type ProjectDeliveryItem,
  type ProjectDeliveryRunSummary,
  type ProjectDeliveryConfirmation,
  type ProjectDeliveryAttempts,
  type ProjectDeliveryManifest,
  type ProjectDeliveryManifestList,
  type ProjectDeliveryManifestView,
} from '../../../packages/contracts/src/project-delivery.js';
import { hash, id, now, stable, type Store } from '../../../packages/storage/src/index.js';
import { projectionReads } from '../../../packages/storage/src/projection-reads.js';
import { deliveryFingerprint } from './delivery-fingerprint.js';
import { ensureCurrentReviewSnapshot, savedReviewSnapshot } from './delivery-review-history.js';
import { sourceNoteResolutionsFor } from './source-note-resolutions.js';
import { projectDeliveryMarkdown } from './project-delivery-export.js';
import { assertBundleManifest, ProjectDeliveryBundleService } from './project-delivery-bundle.js';
import { ProjectDeliveryArchiveService, readProjectArchives } from './project-delivery-archive.js';

type StoredItem = z.infer<typeof ProjectDeliveryItemInput> & {
  itemRevision: number;
  currentRunId: string | null;
  confirmation: ProjectDeliveryConfirmation | null;
};
type StoredBoard = { goal: string; scope: string[]; nonGoals: string[]; items: StoredItem[] };
const confirmationSchema = z
  .object({
    itemRevision: z.number().int().positive(),
    runId: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reviewId: z.string().uuid(),
    note: z.string().max(1000),
    confirmedAt: z.string(),
  })
  .strict();
const storedBoardSchema = ProjectDeliveryBoardInput.omit({ commandId: true, expectedRevision: true })
  .extend({
    items: z
      .array(
        ProjectDeliveryItemInput.extend({
          itemRevision: z.number().int().positive(),
          currentRunId: z.string().uuid().nullable(),
          confirmation: confirmationSchema.nullable(),
        }),
      )
      .max(40),
  })
  .strict();
const commandSchema = z.object({
  commandId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
});
const attemptsLimit = 200;
const bundleJobBinding = z
  .object({
    expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    clientId: z.string().uuid().optional(),
  })
  .strict();
function bundleRequestSignal(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const disconnect = () => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once('aborted', abort);
  reply.raw.once('close', disconnect);
  if (request.raw.aborted) abort();
  return {
    signal: controller.signal,
    detach: () => {
      request.raw.off('aborted', abort);
      reply.raw.off('close', disconnect);
    },
  };
}
function bundleSessionHash(request: FastifyRequest) {
  const session = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('elysia_session='))
    ?.slice('elysia_session='.length);
  // The enclosing local-server authentication hook validates this cookie.
  return hash(session ?? 'isolated-session');
}
function conflict(code: string, message: string): never {
  throw new AppError(code, message, false, null, 409);
}
function revision(expected: number, actual: number) {
  if (expected !== actual) conflict('PROJECT_BOARD_CONFLICT', '项目交付工作台已更新，请保留输入并重新读取');
}
function readableError(message = '关联交付暂时无法读取，不能确认或冻结'): never {
  throw new AppError('PROJECT_DELIVERY_UNREADABLE', message, true, null, 422);
}
function boardRecord(store: Store, projectId: string) {
  const project = store.require<Project>('projects', projectId);
  const row = store.db
    .prepare('SELECT revision,data FROM project_delivery_boards_v1 WHERE project_id=?')
    .get(projectId) as { revision: number; data: string } | undefined;
  if (!row)
    return { project, revision: 0, data: { goal: '', scope: [], nonGoals: [], items: [] } as StoredBoard };
  try {
    const data = storedBoardSchema.parse(JSON.parse(row.data));
    if (new Set(data.items.map((i) => i.id)).size !== data.items.length) throw Error('duplicate');
    return { project, revision: row.revision, data };
  } catch {
    readableError('项目交付定义暂时无法读取，请修复记录后重试');
  }
}
function mutable(project: Project, guard: (runId: string | null, projectId?: string) => void) {
  guard(null, project.id);
  invariant(!project.archived, 'PROJECT_ARCHIVED', '请先恢复归档项目');
}
function itemOf(board: StoredBoard, itemId: string) {
  const item = board.items.find((item) => item.id === itemId);
  if (!item) throw new AppError('PROJECT_ITEM_NOT_FOUND', '交付项不存在', false, null, 404);
  return item;
}
function semantic(item: z.infer<typeof ProjectDeliveryItemInput>) {
  return stable({
    title: item.title,
    description: item.description,
    deliverables: item.deliverables,
    acceptanceCriteria: item.acceptanceCriteria,
  });
}
function saveBoard(store: Store, projectId: string, expected: number, data: StoredBoard) {
  const json = stable(data);
  invariant(
    Buffer.byteLength(json, 'utf8') <= 256 * 1024,
    'PROJECT_BOARD_LIMIT',
    '交付定义超过 256 KiB，请减少内容；不会自动截断',
  );
  const next = expected + 1;
  if (!expected) {
    store.db
      .prepare('INSERT INTO project_delivery_boards_v1(project_id,revision,data) VALUES(?,?,?)')
      .run(projectId, next, json);
  } else {
    const result = store.db
      .prepare('UPDATE project_delivery_boards_v1 SET revision=?,data=? WHERE project_id=? AND revision=?')
      .run(next, json, projectId, expected);
    if (!result.changes) conflict('PROJECT_BOARD_CONFLICT', '项目交付工作台已更新，请重新读取');
  }
  return next;
}
function emptySummary(runId: string, title: string, missing = false): ProjectDeliveryRunSummary {
  return {
    runId,
    title,
    runRevision: null,
    rootRevision: null,
    status: null,
    fingerprint: null,
    reviewId: null,
    reviewStatus: null,
    sourceNotes: { total: 0, resolved: 0, pending: 0, needsChanges: 0, stale: 0, unavailable: 1 },
    missing,
    issue: missing ? '原任务已删除' : '关联交付暂时无法读取',
  };
}
function assertRunScope(run: Run, projectId: string) {
  invariant(
    run.projectId === projectId && run.kind === 'task' && (run.execution?.kind ?? 'native') === 'native',
    'PROJECT_RUN_SCOPE',
    '只能关联本项目的原生任务',
  );
}
function assertLinked(store: Store, projectId: string, itemId: string, runId: string) {
  invariant(
    store.db
      .prepare('SELECT 1 FROM project_delivery_links_v1 WHERE project_id=? AND item_id=? AND run_id=?')
      .get(projectId, itemId, runId),
    'PROJECT_RUN_NOT_LINKED',
    '当前关联记录缺失，请重新关联任务后核对',
  );
}
function runState(store: Store, projectId: string, runId: string) {
  const reads = projectionReads(store),
    run = reads.require<Run>('runs', runId);
  assertRunScope(run, projectId);
  const root = reads.require<Task>('tasks', run.rootTaskId);
  invariant(root.runId === run.id, 'PROJECT_RUN_SCOPE', '根任务归属不一致');
  if (!reads.coverage(undefined, runId).complete) readableError();
  const fingerprint = deliveryFingerprint(store, run, root);
  const reviewId = ensureCurrentReviewSnapshot(store, run) ?? null;
  const review = reviewId ? savedReviewSnapshot(store, run.id, reviewId) : undefined;
  const source = sourceNoteResolutionsFor(store, run, root, fingerprint);
  const sourceNotes = {
    total: source.items.length,
    resolved: 0,
    pending: 0,
    needsChanges: 0,
    stale: 0,
    unavailable: 0,
  };
  for (const item of source.items) {
    if (!item.resolution) sourceNotes.pending++;
    else if (item.resolution.stale) sourceNotes.stale++;
    else if (item.resolution.status === 'resolved') sourceNotes.resolved++;
    else if (item.resolution.status === 'needs_changes') sourceNotes.needsChanges++;
    else sourceNotes.pending++;
  }
  const reviewStatus: ProjectDeliveryRunSummary['reviewStatus'] =
    run.status !== 'DONE' || root.status !== 'DONE'
      ? null
      : !review
        ? 'unreviewed'
        : review.fingerprint !== fingerprint
          ? 'stale'
          : review.decision;
  const executionHold = store.getExecutionHold(run.id);
  const summary: ProjectDeliveryRunSummary = {
    runId: run.id,
    title: run.title,
    runRevision: run.revision,
    rootRevision: root.revision,
    status: run.status,
    fingerprint,
    reviewId,
    reviewStatus,
    sourceNotes,
    missing: false,
    ...(executionHold
      ? { executionHold, issue: executionHold.message }
      : run.archived
        ? { issue: '关联任务已归档，请先恢复任务' }
        : {}),
  };
  return { run, root, fingerprint, review, reviewId, source, summary };
}
function summarize(store: Store, projectId: string, runId: string, title: string): ProjectDeliveryRunSummary {
  if (!store.db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId)) return emptySummary(runId, title, true);
  try {
    return runState(store, projectId, runId).summary;
  } catch (error) {
    if ((error as { code?: string })?.code === 'ERR_SQLITE_ERROR') throw error;
    return emptySummary(runId, title);
  }
}
function itemView(
  item: StoredItem,
  current: ProjectDeliveryRunSummary | null,
  attemptCount: number,
): ProjectDeliveryItem {
  const c = item.confirmation;
  const confirmationStale =
    !!c &&
    (!current ||
      c.runId !== item.currentRunId ||
      c.itemRevision !== item.itemRevision ||
      c.fingerprint !== current.fingerprint ||
      c.reviewId !== current.reviewId);
  let readiness: ProjectDeliveryItem['readiness'] = 'ready';
  if (!current) readiness = 'unlinked';
  else if (current.issue || current.missing || current.sourceNotes.unavailable) readiness = 'unavailable';
  else if (current.status !== 'DONE') readiness = 'not_done';
  else if (current.reviewStatus === 'stale') readiness = 'review_stale';
  else if (current.reviewStatus === 'changes_requested') readiness = 'changes_requested';
  else if (current.reviewStatus !== 'accepted') readiness = 'review_pending';
  else if (current.sourceNotes.pending || current.sourceNotes.needsChanges || current.sourceNotes.stale)
    readiness = 'source_feedback_pending';
  else if (!c || confirmationStale) readiness = 'unconfirmed';
  return { ...item, attemptCount, current, confirmationStale, readiness };
}
export function projectDeliveryBoard(store: Store, projectId: string): ProjectDeliveryBoard {
  const record = boardRecord(store, projectId);
  const counts = store.db
    .prepare('SELECT item_id,COUNT(*) n FROM project_delivery_links_v1 WHERE project_id=? GROUP BY item_id')
    .all(projectId) as { item_id: string; n: number }[];
  const byItem = new Map(counts.map((row) => [row.item_id, Number(row.n)]));
  const current = new Map<string, ProjectDeliveryRunSummary>();
  const items = record.data.items.map((item) => {
    if (!item.currentRunId) return itemView(item, null, byItem.get(item.id) ?? 0);
    const link = store.db
      .prepare('SELECT title FROM project_delivery_links_v1 WHERE project_id=? AND item_id=? AND run_id=?')
      .get(projectId, item.id, item.currentRunId) as { title: string } | undefined;
    if (!link) return itemView(item, emptySummary(item.currentRunId, '关联缺失'), byItem.get(item.id) ?? 0);
    if (!current.has(item.currentRunId))
      current.set(item.currentRunId, summarize(store, projectId, item.currentRunId, link.title));
    return itemView(item, current.get(item.currentRunId)!, byItem.get(item.id) ?? 0);
  });
  return {
    projectId,
    revision: record.revision,
    archived: record.project.archived,
    goal: record.data.goal,
    scope: record.data.scope,
    nonGoals: record.data.nonGoals,
    items,
    counts: {
      total: items.length,
      required: items.filter((i) => i.required).length,
      ready: items.filter((i) => i.readiness === 'ready').length,
      requiredReady: items.filter((i) => i.required && i.readiness === 'ready').length,
      unavailable: items.filter((i) => i.readiness === 'unavailable').length,
    },
  };
}
function linkRun(
  store: Store,
  record: ReturnType<typeof boardRecord>,
  itemId: string,
  run: Run,
  makeCurrent: boolean,
) {
  assertRunScope(run, record.project.id);
  invariant(!run.archived, 'RUN_ARCHIVED', '请先恢复归档任务');
  const item = itemOf(record.data, itemId);
  const exists = store.db
    .prepare('SELECT 1 FROM project_delivery_links_v1 WHERE project_id=? AND item_id=? AND run_id=?')
    .get(record.project.id, itemId, run.id);
  if (!exists) {
    const count = Number(
      store.db
        .prepare('SELECT COUNT(*) n FROM project_delivery_links_v1 WHERE project_id=? AND item_id=?')
        .get(record.project.id, itemId)!.n,
    );
    invariant(count < attemptsLimit, 'PROJECT_ATTEMPTS_LIMIT', '每个交付项最多关联 200 次任务尝试');
    store.db
      .prepare(
        'INSERT INTO project_delivery_links_v1(project_id,item_id,run_id,title,linked_at) VALUES(?,?,?,?,?)',
      )
      .run(record.project.id, itemId, run.id, run.title, now());
  }
  if (makeCurrent && item.currentRunId !== run.id) {
    item.currentRunId = run.id;
    item.confirmation = null;
  }
  saveBoard(store, record.project.id, record.revision, record.data);
}
/** Invoked only inside the existing create command: a failed board CAS rolls back the new Run too. */
export function attachProjectDeliveryRun(store: Store, run: Run, binding: ProjectDeliveryBinding) {
  invariant(run.projectId, 'PROJECT_RUN_SCOPE', '项目交付项不能关联独立聊天');
  const record = boardRecord(store, run.projectId);
  revision(binding.expectedRevision, record.revision);
  invariant(!record.project.archived, 'PROJECT_ARCHIVED', '请先恢复归档项目');
  linkRun(store, record, binding.itemId, run, true);
}
function manifestRow(store: Store, projectId: string, manifestId: string) {
  store.require<Project>('projects', projectId);
  const row = store.db
    .prepare('SELECT data,hash FROM project_delivery_manifests_v1 WHERE project_id=? AND id=?')
    .get(projectId, manifestId) as { data: string; hash: string } | undefined;
  if (!row) throw new AppError('NOT_FOUND', '交付清单不存在', false, null, 404);
  try {
    const manifest = JSON.parse(row.data) as ProjectDeliveryManifest;
    const { hash: expected, ...body } = manifest;
    if (
      expected !== row.hash ||
      hash(stable(body)) !== expected ||
      manifest.projectId !== projectId ||
      manifest.id !== manifestId
    )
      throw Error('manifest');
    return manifest;
  } catch {
    readableError('冻结清单完整性核验失败，请修复记录后重试');
  }
}
function manifestView(store: Store, manifest: ProjectDeliveryManifest): ProjectDeliveryManifestView {
  const availability = manifest.items.map((item) => {
    const current = summarize(store, manifest.projectId, item.run.id, item.run.title);
    return {
      itemId: item.item.id,
      runId: item.run.id,
      run: current.missing
        ? ('missing' as const)
        : current.issue
          ? ('unavailable' as const)
          : current.fingerprint !== item.run.fingerprint ||
              current.reviewId !== item.review.reviewId ||
              current.runRevision !== item.run.revision ||
              current.rootRevision !== item.run.rootRevision
            ? ('changed' as const)
            : ('available' as const),
      artifacts: item.artifacts.map((a) => {
        try {
          const artifact = store.get<Artifact>('artifacts', a.id);
          return {
            id: a.id,
            state: !artifact
              ? ('missing' as const)
              : artifact.runId !== item.run.id
                ? ('unavailable' as const)
                : artifact.version !== a.version ||
                    artifact.hash !== a.hash ||
                    artifact.name !== a.name ||
                    artifact.mediaType !== a.mediaType ||
                    artifact.verified !== a.verified
                  ? ('changed' as const)
                  : ('available' as const),
          };
        } catch {
          return { id: a.id, state: 'unavailable' as const };
        }
      }),
    };
  });
  return { manifest, availability };
}
export function registerProjectDelivery(
  app: FastifyInstance,
  store: Store,
  guard: (runId: string | null, projectId?: string) => void,
) {
  const archives = new ProjectDeliveryArchiveService(store, guard);
  const bundles = new ProjectDeliveryBundleService(store, archives);
  app.addHook('onClose', () => bundles.close());
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS project_delivery_boards_v1(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,revision INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE IF NOT EXISTS project_delivery_links_v1(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,item_id TEXT NOT NULL,run_id TEXT NOT NULL,title TEXT NOT NULL,linked_at TEXT NOT NULL,PRIMARY KEY(project_id,item_id,run_id));
    CREATE TABLE IF NOT EXISTS project_delivery_manifests_v1(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,title TEXT NOT NULL,created_at TEXT NOT NULL,item_count INTEGER NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS project_delivery_manifests_project ON project_delivery_manifests_v1(project_id);`);
  app.get<{ Params: { id: string } }>('/api/projects/:id/delivery-board', (request) => {
    z.object({}).strict().parse(request.query);
    return projectDeliveryBoard(store, request.params.id);
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/delivery-board', (request) => {
    const body = ProjectDeliveryBoardInput.parse(request.body);
    return store.command(body.commandId, { route: request.url, body }, () => {
      const record = boardRecord(store, request.params.id);
      mutable(record.project, guard);
      revision(body.expectedRevision, record.revision);
      invariant(
        new Set(body.items.map((i) => i.id)).size === body.items.length,
        'PROJECT_ITEM_DUPLICATE',
        '交付项 ID 不能重复',
      );
      const data: StoredBoard = {
        goal: body.goal,
        scope: body.scope,
        nonGoals: body.nonGoals,
        items: body.items.map((input) => {
          const old = record.data.items.find((i) => i.id === input.id);
          return {
            ...input,
            itemRevision: old ? old.itemRevision + (semantic(old) === semantic(input) ? 0 : 1) : 1,
            currentRunId: old?.currentRunId ?? null,
            confirmation: old?.confirmation ?? null,
          };
        }),
      };
      saveBoard(store, record.project.id, record.revision, data);
      return projectDeliveryBoard(store, record.project.id);
    });
  });
  app.get<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/delivery-board/items/:itemId/runs',
    (request) => {
      const query = z.object({ before: z.string().uuid().optional() }).strict().parse(request.query),
        record = boardRecord(store, request.params.id),
        item = itemOf(record.data, request.params.itemId);
      let before: number | undefined;
      if (query.before) {
        const cursor = store.db
          .prepare(
            'SELECT rowid n FROM project_delivery_links_v1 WHERE project_id=? AND item_id=? AND run_id=?',
          )
          .get(record.project.id, item.id, query.before) as { n: number } | undefined;
        if (!cursor) conflict('PROJECT_ATTEMPT_CURSOR', '关联位置已失效，请返回首页');
        before = cursor.n;
      }
      const rows = store.db
        .prepare(
          `SELECT run_id,title,linked_at FROM project_delivery_links_v1 WHERE project_id=? AND item_id=? ${before === undefined ? '' : 'AND rowid<?'} ORDER BY rowid DESC LIMIT 21`,
        )
        .all(record.project.id, item.id, ...(before === undefined ? [] : [before])) as {
        run_id: string;
        title: string;
        linked_at: string;
      }[];
      const total = Number(
          store.db
            .prepare('SELECT COUNT(*) n FROM project_delivery_links_v1 WHERE project_id=? AND item_id=?')
            .get(record.project.id, item.id)!.n,
        ),
        selected = rows.slice(0, 20),
        hasMore = rows.length > 20;
      return {
        projectId: record.project.id,
        itemId: item.id,
        boardRevision: record.revision,
        items: selected.map((row) => ({
          ...summarize(store, record.project.id, row.run_id, row.title),
          linkedAt: row.linked_at,
          current: row.run_id === item.currentRunId,
        })),
        page: {
          limit: 20,
          before: query.before ?? null,
          total,
          hasMore,
          nextBefore: hasMore ? selected.at(-1)!.run_id : null,
        },
      } satisfies ProjectDeliveryAttempts;
    },
  );
  app.post<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/delivery-board/items/:itemId/runs',
    (request) => {
      const body = commandSchema
        .extend({ runId: z.string().uuid(), makeCurrent: z.boolean() })
        .strict()
        .parse(request.body);
      return store.command(body.commandId, { route: request.url, body }, () => {
        const record = boardRecord(store, request.params.id);
        mutable(record.project, guard);
        revision(body.expectedRevision, record.revision);
        linkRun(
          store,
          record,
          request.params.itemId,
          projectionReads(store).require<Run>('runs', body.runId),
          body.makeCurrent,
        );
        return projectDeliveryBoard(store, record.project.id);
      });
    },
  );
  app.post<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/delivery-board/items/:itemId/current',
    (request) => {
      const body = commandSchema.extend({ runId: z.string().uuid() }).strict().parse(request.body);
      return store.command(body.commandId, { route: request.url, body }, () => {
        const record = boardRecord(store, request.params.id);
        mutable(record.project, guard);
        revision(body.expectedRevision, record.revision);
        const item = itemOf(record.data, request.params.itemId);
        invariant(
          store.db
            .prepare('SELECT 1 FROM project_delivery_links_v1 WHERE project_id=? AND item_id=? AND run_id=?')
            .get(record.project.id, item.id, body.runId),
          'PROJECT_RUN_NOT_LINKED',
          '请先关联此任务',
        );
        const run = projectionReads(store).require<Run>('runs', body.runId);
        assertRunScope(run, record.project.id);
        invariant(!run.archived, 'RUN_ARCHIVED', '请先恢复归档任务');
        if (item.currentRunId !== run.id) {
          item.currentRunId = run.id;
          item.confirmation = null;
        }
        saveBoard(store, record.project.id, record.revision, record.data);
        return projectDeliveryBoard(store, record.project.id);
      });
    },
  );
  app.post<{ Params: { id: string; itemId: string } }>(
    '/api/projects/:id/delivery-board/items/:itemId/confirm',
    (request) => {
      const body = commandSchema
        .extend({
          expectedItemRevision: z.number().int().positive(),
          runId: z.string().uuid(),
          expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          expectedReviewId: z.string().uuid(),
          note: z.string().max(1000),
        })
        .strict()
        .parse(request.body);
      return store.command(body.commandId, { route: request.url, body }, () => {
        const record = boardRecord(store, request.params.id);
        mutable(record.project, guard);
        revision(body.expectedRevision, record.revision);
        const item = itemOf(record.data, request.params.itemId);
        if (item.itemRevision !== body.expectedItemRevision || item.currentRunId !== body.runId)
          conflict('PROJECT_ITEM_CHANGED', '交付项或当前候选已变化，请重新核对');
        assertLinked(store, record.project.id, item.id, body.runId);
        const state = runState(store, record.project.id, body.runId);
        if (state.fingerprint !== body.expectedFingerprint || state.reviewId !== body.expectedReviewId)
          conflict('DELIVERY_CHANGED', '候选交付或复核已变化，请重新读取');
        invariant(
          !state.summary.issue &&
            !state.run.archived &&
            state.summary.status === 'DONE' &&
            state.root.status === 'DONE' &&
            state.summary.reviewStatus === 'accepted',
          'PROJECT_REVIEW_REQUIRED',
          '当前候选须已完成、有当前有效的采纳复核且未被停止或隔离',
        );
        item.confirmation = {
          itemRevision: item.itemRevision,
          runId: state.run.id,
          fingerprint: state.fingerprint,
          reviewId: state.reviewId!,
          note: body.note,
          confirmedAt: now(),
        };
        saveBoard(store, record.project.id, record.revision, record.data);
        return projectDeliveryBoard(store, record.project.id);
      });
    },
  );
  app.post<{ Params: { id: string } }>('/api/projects/:id/delivery-manifests', (request) => {
    const body = ProjectDeliveryManifestInput.parse(request.body);
    return store.command(body.commandId, { route: request.url, body }, () => {
      const record = boardRecord(store, request.params.id);
      mutable(record.project, guard);
      revision(body.expectedRevision, record.revision);
      invariant(!!record.data.goal.trim(), 'PROJECT_GOAL_REQUIRED', '冻结前请填写项目目标');
      const ids = new Set(body.items.map((i) => i.itemId));
      invariant(ids.size === body.items.length, 'PROJECT_ITEM_DUPLICATE', '交付项不能重复');
      invariant(
        record.data.items.every((i) => !i.required || ids.has(i.id)),
        'PROJECT_REQUIRED_ITEMS',
        '本次清单必须包含全部必选交付项',
      );
      const selected = body.items.map((selection) => {
        const item = itemOf(record.data, selection.itemId);
        if (item.itemRevision !== selection.expectedItemRevision || item.currentRunId !== selection.runId)
          conflict('PROJECT_ITEM_CHANGED', '交付项或当前候选已变化，请重新核对');
        assertLinked(store, record.project.id, item.id, selection.runId);
        const state = runState(store, record.project.id, selection.runId),
          view = itemView(item, state.summary, 0);
        if (
          selection.expectedRunRevision !== state.run.revision ||
          selection.expectedRootRevision !== state.root.revision ||
          selection.expectedFingerprint !== state.fingerprint ||
          selection.expectedReviewId !== state.reviewId
        )
          conflict('DELIVERY_CHANGED', '交付或复核已变化，请重新核对冻结清单');
        invariant(
          view.readiness === 'ready',
          'PROJECT_DELIVERY_NOT_READY',
          '所选交付项仍有未确认、未采纳、待复验或无法读取的问题',
        );
        invariant(
          new Set(selection.artifactIds).size === selection.artifactIds.length,
          'PROJECT_ARTIFACT_DUPLICATE',
          '产物不能重复选择',
        );
        const artifacts = selection.artifactIds.map((key) => {
          const a = store.require<Artifact>('artifacts', key);
          invariant(
            a.runId === state.run.id && a.verified,
            'PROJECT_ARTIFACT_SCOPE',
            '只能选择当前任务已核验的产物元数据',
          );
          return {
            id: a.id,
            name: a.name,
            version: a.version,
            hash: a.hash,
            mediaType: a.mediaType,
            verified: a.verified,
          };
        });
        const { currentRunId: _current, confirmation: _confirmation, ...definition } = item;
        const evidence = (
          state.root.result &&
          typeof state.root.result === 'object' &&
          Array.isArray((state.root.result as any).evidence)
            ? (state.root.result as any).evidence
            : []
        ).map((e: unknown) => Evidence.parse(e));
        return {
          item: definition,
          run: {
            id: state.run.id,
            title: state.run.title,
            revision: state.run.revision,
            rootTaskId: state.root.id,
            rootRevision: state.root.revision,
            fingerprint: state.fingerprint,
            objective: state.run.objective,
            deliverables: state.root.spec.deliverables,
            acceptanceCriteria: state.root.spec.acceptanceCriteria,
          },
          confirmation: item.confirmation!,
          review: {
            reviewId: state.reviewId!,
            decision: 'accepted' as const,
            reviewedAt: state.review!.reviewedAt,
            note: state.review!.note,
            criteriaNotes: state.review!.criteriaNotes,
          },
          sourceNotes: state.summary.sourceNotes,
          source: state.run.source ? { runId: state.run.source.runId, hash: state.run.source.hash } : null,
          sourceFeedback: state.source.items,
          evidence,
          artifacts,
        };
      });
      const snapshot = {
        version: 1 as const,
        id: id(),
        projectId: record.project.id,
        projectName: record.project.name,
        title: body.title,
        createdAt: now(),
        boardRevision: record.revision,
        goal: record.data.goal,
        scope: record.data.scope,
        nonGoals: record.data.nonGoals,
        items: selected,
      };
      const json = stable(snapshot);
      invariant(
        Buffer.byteLength(json, 'utf8') <= 8 * 1024 * 1024,
        'PROJECT_MANIFEST_LIMIT',
        '冻结清单超过 8 MiB，请减少可选项或证据内容；不会自动截断',
      );
      const manifest: ProjectDeliveryManifest = { ...snapshot, hash: hash(json) };
      store.db
        .prepare(
          'INSERT INTO project_delivery_manifests_v1(id,project_id,title,created_at,item_count,hash,data) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          manifest.id,
          manifest.projectId,
          manifest.title,
          manifest.createdAt,
          manifest.items.length,
          manifest.hash,
          stable(manifest),
        );
      return manifestView(store, manifest);
    });
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/delivery-manifests', (request) => {
    const query = z.object({ before: z.string().uuid().optional() }).strict().parse(request.query);
    store.require<Project>('projects', request.params.id);
    let before: number | undefined;
    if (query.before) {
      const cursor = store.db
        .prepare('SELECT rowid n FROM project_delivery_manifests_v1 WHERE project_id=? AND id=?')
        .get(request.params.id, query.before) as { n: number } | undefined;
      if (!cursor) conflict('PROJECT_MANIFEST_CURSOR', '清单位置已失效，请返回首页');
      before = cursor.n;
    }
    const rows = store.db
      .prepare(
        `SELECT id,title,created_at,item_count,hash FROM project_delivery_manifests_v1 WHERE project_id=? ${before === undefined ? '' : 'AND rowid<?'} ORDER BY rowid DESC LIMIT 21`,
      )
      .all(request.params.id, ...(before === undefined ? [] : [before])) as {
      id: string;
      title: string;
      created_at: string;
      item_count: number;
      hash: string;
    }[];
    const total = Number(
        store.db
          .prepare('SELECT COUNT(*) n FROM project_delivery_manifests_v1 WHERE project_id=?')
          .get(request.params.id)!.n,
      ),
      chosen = rows.slice(0, 20),
      hasMore = rows.length > 20;
    return {
      projectId: request.params.id,
      items: chosen.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.created_at,
        itemCount: r.item_count,
        hash: r.hash,
      })),
      page: {
        limit: 20,
        before: query.before ?? null,
        total,
        hasMore,
        nextBefore: hasMore ? chosen.at(-1)!.id : null,
      },
    } satisfies ProjectDeliveryManifestList;
  });
  app.get<{ Params: { id: string; manifestId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId',
    (request) => {
      z.object({}).strict().parse(request.query);
      return manifestView(store, manifestRow(store, request.params.id, request.params.manifestId));
    },
  );
  app.get<{ Params: { id: string } }>('/api/projects/:id/delivery-archives', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return readProjectArchives(
      store,
      request.params.id,
      request.query as { limit?: number; before?: string },
    );
  });
  app.get<{ Params: { id: string; manifestId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId/archive',
    (request, reply) => {
      const { expectedManifestHash } = z
        .object({ expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(request.query);
      const manifest = manifestRow(store, request.params.id, request.params.manifestId);
      assertBundleManifest(manifest, expectedManifestHash);
      reply.header('Cache-Control', 'no-store');
      return archives.read(manifest);
    },
  );
  app.delete<{ Params: { id: string; manifestId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId/archive',
    (request, reply) => {
      z.object({}).strict().parse(request.query);
      const { expectedManifestHash, expectedObjectHash } = z
        .object({
          expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
          expectedObjectHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(request.body);
      const manifest = manifestRow(store, request.params.id, request.params.manifestId);
      assertBundleManifest(manifest, expectedManifestHash);
      reply.header('Cache-Control', 'no-store');
      return archives.remove(manifest, expectedObjectHash);
    },
  );
  app.get<{ Params: { id: string; manifestId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId/archive/file',
    async (request, reply) => {
      const { expectedManifestHash, expectedObjectHash } = z
        .object({
          expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
          expectedObjectHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(request.query);
      const manifest = manifestRow(store, request.params.id, request.params.manifestId);
      assertBundleManifest(manifest, expectedManifestHash);
      const cancellation = bundleRequestSignal(request, reply);
      let resource: Awaited<ReturnType<ProjectDeliveryBundleService['body']>> | undefined;
      try {
        resource = await bundles.body(
          (signal) => archives.body(manifest, expectedObjectHash, signal),
          cancellation.signal,
        );
        resource.stream.once('close', cancellation.detach);
        return reply
          .type('application/zip')
          .header('Cache-Control', 'no-store')
          .header('Content-Disposition', `attachment; filename="project-delivery-${manifest.id}.zip"`)
          .header('Content-Length', resource.size)
          .send(resource.stream);
      } catch (error) {
        cancellation.detach();
        await resource?.dispose();
        throw error;
      }
    },
  );
  app.get<{ Params: { id: string; manifestId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId/bundle-plan',
    async (request, reply) => {
      const { expectedManifestHash } = z
        .object({ expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(request.query);
      const manifest = manifestRow(store, request.params.id, request.params.manifestId);
      assertBundleManifest(manifest, expectedManifestHash);
      const cancellation = bundleRequestSignal(request, reply);
      reply.header('Cache-Control', 'no-store');
      try {
        return await bundles.plan(manifest, cancellation.signal);
      } finally {
        cancellation.detach();
      }
    },
  );
  app.post<{ Params: { id: string; manifestId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId/bundle-jobs',
    (request, reply) => {
      z.object({}).strict().parse(request.query);
      const input = ProjectDeliveryBundleJobInput.parse(request.body);
      const manifest = manifestRow(store, request.params.id, request.params.manifestId);
      assertBundleManifest(manifest, input.expectedManifestHash);
      reply.status(202).header('Cache-Control', 'no-store');
      return bundles.start(manifest, input, bundleSessionHash(request));
    },
  );
  app.get<{ Params: { id: string; manifestId: string; jobId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId/bundle-jobs/:jobId',
    (request, reply) => {
      const { expectedManifestHash, clientId } = bundleJobBinding.parse(request.query);
      z.string().uuid().parse(request.params.jobId);
      const manifest = manifestRow(store, request.params.id, request.params.manifestId);
      assertBundleManifest(manifest, expectedManifestHash);
      reply.header('Cache-Control', 'no-store');
      return bundles.job(manifest, request.params.jobId, bundleSessionHash(request), clientId);
    },
  );
  app.delete<{ Params: { id: string; manifestId: string; jobId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId/bundle-jobs/:jobId',
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      const { expectedManifestHash, clientId } = bundleJobBinding.parse(request.body);
      z.string().uuid().parse(request.params.jobId);
      const manifest = manifestRow(store, request.params.id, request.params.manifestId);
      assertBundleManifest(manifest, expectedManifestHash);
      reply.header('Cache-Control', 'no-store');
      return bundles.cancel(manifest, request.params.jobId, bundleSessionHash(request), clientId);
    },
  );
  app.get<{ Params: { id: string; manifestId: string; jobId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId/bundle-jobs/:jobId/file',
    async (request, reply) => {
      const { expectedManifestHash, clientId } = bundleJobBinding.parse(request.query);
      z.string().uuid().parse(request.params.jobId);
      const manifest = manifestRow(store, request.params.id, request.params.manifestId);
      assertBundleManifest(manifest, expectedManifestHash);
      const cancellation = bundleRequestSignal(request, reply);
      let bundle: ReturnType<ProjectDeliveryBundleService['send']> | undefined;
      try {
        bundle = bundles.send(
          manifest,
          request.params.jobId,
          bundleSessionHash(request),
          cancellation.signal,
          clientId,
        );
        bundle.stream.once('close', cancellation.detach);
        return reply
          .type('application/zip')
          .header('Cache-Control', 'no-store')
          .header('Content-Disposition', `attachment; filename="project-delivery-${manifest.id}.zip"`)
          .header('Content-Length', bundle.size)
          .send(bundle.stream);
      } catch (error) {
        cancellation.detach();
        // A rejected duplicate GET has acquired nothing and must not cancel the
        // legitimate sender. Only clean up this request's successfully claimed ZIP.
        if (bundle) {
          await bundles.cancel(manifest, request.params.jobId, bundleSessionHash(request), clientId);
          await bundle.dispose();
        }
        throw error;
      }
    },
  );
  app.get<{ Params: { id: string; manifestId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId/bundle',
    async (request, reply) => {
      const { expectedManifestHash } = z
        .object({ expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(request.query);
      const manifest = manifestRow(store, request.params.id, request.params.manifestId);
      assertBundleManifest(manifest, expectedManifestHash);
      const cancellation = bundleRequestSignal(request, reply);
      let bundle: Awaited<ReturnType<ProjectDeliveryBundleService['bundle']>> | undefined;
      try {
        bundle = await bundles.bundle(manifest, cancellation.signal);
        bundle.stream.once('close', cancellation.detach);
        return reply
          .type('application/zip')
          .header('Cache-Control', 'no-store')
          .header('Content-Disposition', `attachment; filename="project-delivery-${manifest.id}.zip"`)
          .header('Content-Length', bundle.size)
          .send(bundle.stream);
      } catch (error) {
        cancellation.detach();
        await bundle?.dispose();
        throw error;
      }
    },
  );
  app.get<{ Params: { id: string; manifestId: string } }>(
    '/api/projects/:id/delivery-manifests/:manifestId/export',
    (request, reply) => {
      const { format } = z
        .object({ format: z.enum(['json', 'markdown']) })
        .strict()
        .parse(request.query);
      const manifest = manifestRow(store, request.params.id, request.params.manifestId);
      reply.header(
        'Content-Disposition',
        `attachment; filename="project-delivery-${manifest.id}.${format === 'json' ? 'json' : 'md'}"`,
      );
      if (format === 'json')
        return reply.type('application/json; charset=utf-8').send(JSON.stringify(manifest, null, 2));
      return reply.type('text/markdown; charset=utf-8').send(projectDeliveryMarkdown(manifest));
    },
  );
}
