import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, type Entity } from '../../../packages/contracts/src/index.js';
import type {
  TaskCenterItem,
  TaskCenterPage,
  TaskCenterChanges,
} from '../../../packages/contracts/src/task-center.js';
import type { Store } from '../../../packages/storage/src/index.js';
import type { DeliveryReviewStatus } from '../../../packages/contracts/src/workflow.js';
import { deliveryReviewReads, type DeliveryReviewReads } from './delivery-summary.js';
import {
  projectionIssue,
  projectionReads,
  type ProjectionReads,
} from '../../../packages/storage/src/projection-reads.js';

type Row = {
  seq: number;
  run_id: string;
  position: number | null;
  title: string | null;
  project_id: string | null;
  kind: 'task' | 'chat';
  status: TaskCenterItem['status'];
  revision: number;
  category: TaskCenterItem['category'];
  reason: string | null;
  archived: number;
  deleted: number;
  updated_at: string;
  notification_status: NonNullable<TaskCenterItem['notification']>['status'] | null;
  notification_revision: number;
};
const categories = [
  'all',
  'running',
  'waiting',
  'verification',
  'done',
  'failed',
  'paused',
  'unavailable',
] as const;
const reviewStatuses = ['unreviewed', 'accepted', 'changes_requested', 'stale'] as const;
const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const state = (alias: string) =>
  `COALESCE(json_extract(${alias ? alias + '.' : ''}data,'$.readModel.status'),json_extract(${alias ? alias + '.' : ''}data,'$.status'))`;
const waitReason = (alias: string) =>
  `COALESCE(json_extract(${alias}.data,'$.readModel.waitReason'),json_extract(${alias}.data,'$.waitReason'))`;

/** A small persistent current-state read model; historical bodies are warmed only on explicit access. */
export class TaskCenterReads {
  private warming?: Promise<void>;
  private delivery: DeliveryReviewReads;
  private projections: ProjectionReads;
  constructor(private store: Store) {
    this.projections = projectionReads(store);
    this.delivery = deliveryReviewReads(store);
    const status = state('r');
    const runReason = "COALESCE(json_extract(r.data,'$.readModel.reason'),json_extract(r.data,'$.reason'))";
    const tasks = (condition: string) => `EXISTS(SELECT 1 FROM tasks t WHERE t.run_id=r.id AND ${condition})`;
    const taskWaiting = `${state('t')}='WAITING'`;
    const verification = [
      `(${status}='WAITING' AND ${runReason} IN ('verification','terminal_review','terminal_verification'))`,
      `EXISTS(SELECT 1 FROM tool_operations o WHERE o.run_id=r.id AND ${state('o')}='UNCERTAIN')`,
      `EXISTS(SELECT 1 FROM requests q WHERE q.run_id=r.id AND ${state('q')}='UNKNOWN')`,
      tasks(
        `${taskWaiting} AND ${waitReason('t')} IN ('verification','terminal_review','terminal_verification')`,
      ),
    ].join(' OR ');
    const paused = `(${status}='WAITING' AND ${runReason} IN ('paused','interrupted')) OR ${tasks(`${taskWaiting} AND ${waitReason('t')} IN ('paused','interrupted')`)}`;
    const waiting = `${status}='WAITING' OR ${tasks(`${taskWaiting} AND COALESCE(${waitReason('t')},'')<>'children'`)}`;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS task_center_changes_v1(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL UNIQUE,
        position INTEGER,title TEXT,project_id TEXT,kind TEXT,status TEXT,revision INTEGER,
        category TEXT,reason TEXT,archived INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,
        notification_status TEXT,notification_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS task_center_current ON task_center_changes_v1(deleted,archived,category,position);
      CREATE INDEX IF NOT EXISTS task_center_tombstones ON task_center_changes_v1(deleted,seq);
      INSERT OR IGNORE INTO storage_meta(key,value) VALUES('task-center-floor:v1','0');
      INSERT OR IGNORE INTO storage_meta(key,value) VALUES('task-center-warm:v1','1');
      DROP VIEW IF EXISTS task_center_source_v1;
      CREATE VIEW task_center_source_v1 AS SELECT
        r.id run_id,r.rowid position,
        COALESCE(json_extract(r.data,'$.readModel.title'),json_extract(r.data,'$.title'),json_extract(r.data,'$.objective'),r.id) title,
        COALESCE(json_extract(r.data,'$.readModel.projectId'),json_extract(r.data,'$.projectId')) project_id,
        COALESCE(json_extract(r.data,'$.readModel.kind'),json_extract(r.data,'$.kind'),'task') kind,
        CASE WHEN EXISTS(SELECT 1 FROM projection_read_issues_v1 p WHERE p.run_id=r.id) THEN NULL ELSE ${status} END status,r.revision revision,
        CASE WHEN EXISTS(SELECT 1 FROM projection_read_issues_v1 p WHERE p.run_id=r.id) THEN 'unavailable'
          WHEN ${verification} THEN 'verification'
          WHEN ${status}='FAILED' THEN 'failed'
          WHEN ${status} IN ('DONE','CANCELLED') THEN 'done'
          WHEN ${tasks(`${state('t')}='FAILED'`)} THEN 'failed'
          WHEN ${paused} THEN 'paused'
          WHEN ${waiting} THEN 'waiting' ELSE 'running' END category,
        COALESCE(${runReason},(SELECT ${waitReason('t')} FROM tasks t WHERE t.run_id=r.id
          AND ${taskWaiting} AND COALESCE(${waitReason('t')},'')<>'children' ORDER BY t.rowid LIMIT 1)) reason,
        COALESCE(json_extract(r.data,'$.readModel.archived'),json_extract(r.data,'$.archived'),0) archived
      FROM runs r;
      CREATE TRIGGER IF NOT EXISTS task_center_initial_notification AFTER INSERT ON task_center_changes_v1
      WHEN NEW.notification_status IS NOT NULL
      BEGIN UPDATE task_center_changes_v1 SET notification_revision=NEW.seq WHERE run_id=NEW.run_id; END;
    `);
    for (const table of ['tasks', 'requests', 'tool_operations'] as const)
      this.store.db.exec(
        `CREATE INDEX IF NOT EXISTS task_center_${table}_state ON ${table}(run_id,${state('')});`,
      );
    for (const table of ['runs', 'tasks', 'requests', 'tool_operations'] as const) {
      const key = table === 'runs' ? 'NEW.id' : 'NEW.run_id';
      const oldKey = table === 'runs' ? 'OLD.id' : 'OLD.run_id';
      const changed =
        table === 'runs'
          ? 'NEW.revision IS NOT OLD.revision OR NEW.data IS NOT OLD.data'
          : `${state('NEW')} IS NOT ${state('OLD')}${table === 'tasks' ? ` OR ${waitReason('NEW')} IS NOT ${waitReason('OLD')}` : ''}`;
      const oldProjection =
        table === 'runs' || table === 'tasks'
          ? "json_type(NEW.data,'$.readModel') IS NOT 'object' OR json_extract(NEW.data,'$.readModelVersion') IS NOT 1"
          : `${state('NEW')} IS NULL`;
      this.store.db.exec(`
        CREATE TRIGGER IF NOT EXISTS task_center_${table}_insert AFTER INSERT ON ${table}
        BEGIN ${this.refreshSql(key)} END;
        CREATE TRIGGER IF NOT EXISTS task_center_${table}_update AFTER UPDATE ON ${table} WHEN ${changed}
        BEGIN ${this.refreshSql(key)} END;
        CREATE TRIGGER IF NOT EXISTS task_center_${table}_delete AFTER DELETE ON ${table}
        BEGIN ${
          table === 'runs'
            ? `
          INSERT INTO task_center_changes_v1(run_id,deleted,updated_at) VALUES(OLD.id,1,${stamp})
          ON CONFLICT(run_id) DO UPDATE SET seq=excluded.seq,deleted=1,updated_at=excluded.updated_at;
          UPDATE storage_meta SET value=CAST(MAX(CAST(value AS INTEGER),COALESCE((
            SELECT seq FROM task_center_changes_v1 WHERE deleted=1 ORDER BY seq DESC LIMIT 1 OFFSET 1024
          ),0)) AS TEXT) WHERE key='task-center-floor:v1';
          DELETE FROM task_center_changes_v1 WHERE deleted=1 AND seq<=CAST((
            SELECT value FROM storage_meta WHERE key='task-center-floor:v1'
          ) AS INTEGER);
        `
            : this.refreshSql(oldKey)
        } END;
        CREATE TRIGGER IF NOT EXISTS task_center_${table}_legacy_insert AFTER INSERT ON ${table}
        WHEN NEW.content IS NOT NULL AND (${oldProjection})
        BEGIN UPDATE storage_meta SET value='1' WHERE key='task-center-warm:v1'; END;
        CREATE TRIGGER IF NOT EXISTS task_center_${table}_legacy_update AFTER UPDATE ON ${table}
        WHEN NEW.content IS NOT NULL AND (${oldProjection})
        BEGIN UPDATE storage_meta SET value='1' WHERE key='task-center-warm:v1'; END;
      `);
    }
    this.store.tx(() =>
      this.store.db.exec(`
      DROP TRIGGER IF EXISTS task_center_delivery_review_update;
      CREATE TRIGGER task_center_delivery_review_update
      AFTER UPDATE OF review_status,reviewed_at,issue_code ON delivery_review_summary_v1
      WHEN NEW.review_status IS NOT OLD.review_status OR NEW.reviewed_at IS NOT OLD.reviewed_at OR NEW.issue_code IS NOT OLD.issue_code
      BEGIN ${this.refreshSql('NEW.run_id')} END;
      CREATE TRIGGER IF NOT EXISTS task_center_projection_issue_insert AFTER INSERT ON projection_read_issues_v1
      BEGIN ${this.refreshSql('NEW.run_id')} END;
      CREATE TRIGGER IF NOT EXISTS task_center_projection_issue_delete AFTER DELETE ON projection_read_issues_v1
      BEGIN ${this.refreshSql('OLD.run_id')} END;
    `),
    );
  }
  private refreshSql(runId: string) {
    // seq is allocated even on upsert, so observations can continue across process restarts.
    const meaningful =
      "excluded.notification_status IS NOT NULL AND (excluded.category IS NOT task_center_changes_v1.category OR (excluded.status='DONE' AND task_center_changes_v1.status IS NOT 'DONE'))";
    return `INSERT INTO task_center_changes_v1(run_id,position,title,project_id,kind,status,revision,category,reason,archived,updated_at,notification_status)
      SELECT run_id,position,title,project_id,kind,status,revision,category,reason,archived,${stamp},
        CASE category WHEN 'verification' THEN 'UNCERTAIN' WHEN 'waiting' THEN 'WAITING'
          WHEN 'failed' THEN 'FAILED' WHEN 'done' THEN CASE WHEN status='DONE' THEN 'DONE' END END
      FROM task_center_source_v1 WHERE run_id=${runId}
      ON CONFLICT(run_id) DO UPDATE SET seq=excluded.seq,position=excluded.position,title=excluded.title,
        project_id=excluded.project_id,kind=excluded.kind,status=excluded.status,revision=excluded.revision,
        category=excluded.category,reason=excluded.reason,archived=excluded.archived,deleted=0,updated_at=excluded.updated_at,
        notification_status=CASE WHEN ${meaningful} THEN excluded.notification_status ELSE task_center_changes_v1.notification_status END,
        notification_revision=CASE WHEN ${meaningful} THEN excluded.seq ELSE task_center_changes_v1.notification_revision END;`;
  }
  private async warm() {
    if (this.warming) return this.warming;
    if (
      (
        this.store.db.prepare("SELECT value FROM storage_meta WHERE key='task-center-warm:v1'").get() as {
          value: string;
        }
      ).value !== '1' &&
      this.store.db.prepare("SELECT value FROM storage_meta WHERE key='task-center-complete:v2'").get()
    )
      return;
    const pending = this.warmBatches();
    this.warming = pending;
    try {
      await pending;
    } finally {
      if (this.warming === pending) this.warming = undefined;
    }
  }
  private async warmBatches() {
    // Older builds cleared this marker before their first batch. A separate completion
    // marker makes their partial rebuilds recoverable, without scanning on every read.
    this.store.db.prepare("UPDATE storage_meta SET value='1' WHERE key='task-center-warm:v1'").run();
    for (;;) {
      for (const table of ['runs', 'tasks', 'requests', 'tool_operations'] as const) {
        const where =
          table === 'runs' || table === 'tasks'
            ? "json_type(data,'$.readModel') IS NOT 'object' OR json_extract(data,'$.readModelVersion') IS NOT 1"
            : `${state(table)} IS NULL`;
        for (;;) {
          const rows = this.store.db
            .prepare(
              `SELECT id FROM ${table} WHERE content IS NOT NULL AND (${where}) AND ${this.projections.available(table)} ORDER BY rowid LIMIT 32`,
            )
            .all() as { id: string }[];
          if (!rows.length) break;
          this.store.tx(() => {
            for (const { id } of rows) {
              this.projections.read<Entity>(table, id, true);
            }
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      for (;;) {
        const missing = this.store.db
          .prepare(
            'SELECT id FROM runs r WHERE NOT EXISTS(SELECT 1 FROM task_center_changes_v1 c WHERE c.run_id=r.id AND c.deleted=0) ORDER BY rowid LIMIT 32',
          )
          .all() as { id: string }[];
        if (!missing.length) break;
        this.store.tx(() => {
          for (const { id } of missing) this.store.db.prepare(this.refreshSql('?')).run(id);
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // A legacy writer can change an earlier table while a later batch yields.
      // Check all projections once more before atomically marking this build complete.
      const pending = (['runs', 'tasks', 'requests', 'tool_operations'] as const).some((table) => {
        const where =
          table === 'runs' || table === 'tasks'
            ? "json_type(data,'$.readModel') IS NOT 'object' OR json_extract(data,'$.readModelVersion') IS NOT 1"
            : `${state(table)} IS NULL`;
        return this.store.db
          .prepare(
            `SELECT 1 FROM ${table} WHERE content IS NOT NULL AND (${where}) AND ${this.projections.available(table)} LIMIT 1`,
          )
          .get();
      });
      if (!pending) {
        this.store.tx(() => {
          this.prune();
          this.store.db.prepare("UPDATE storage_meta SET value='0' WHERE key='task-center-warm:v1'").run();
          this.store.db
            .prepare("INSERT OR REPLACE INTO storage_meta(key,value) VALUES('task-center-complete:v2','1')")
            .run();
        });
        return;
      }
    }
  }
  private prune() {
    const old = this.store.db
      .prepare('SELECT seq FROM task_center_changes_v1 WHERE deleted=1 ORDER BY seq DESC LIMIT 1 OFFSET 1024')
      .get() as { seq: number } | undefined;
    if (!old) return;
    const through = old.seq;
    this.store.db
      .prepare(
        "UPDATE storage_meta SET value=CAST(MAX(CAST(value AS INTEGER),?) AS TEXT) WHERE key='task-center-floor:v1'",
      )
      .run(through);
    this.store.db.prepare('DELETE FROM task_center_changes_v1 WHERE deleted=1 AND seq<=?').run(through);
  }
  private item(row: Row): TaskCenterItem {
    const unavailable = row.category === 'unavailable';
    const review = unavailable ? undefined : this.delivery.cached(row.run_id);
    const expected =
      row.category === 'verification'
        ? 'UNCERTAIN'
        : row.category === 'waiting'
          ? 'WAITING'
          : row.category === 'failed'
            ? 'FAILED'
            : row.category === 'done' && row.status === 'DONE'
              ? 'DONE'
              : null;
    return {
      id: row.run_id,
      title: (row.title || row.run_id).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
      projectId: row.project_id,
      kind: row.kind,
      status: row.status,
      revision: row.revision,
      category: row.category,
      changeRevision: row.seq,
      ...(row.reason ? { reason: row.reason } : {}),
      updatedAt: row.updated_at,
      ...(unavailable ? { readIssue: projectionIssue } : {}),
      ...(review?.reviewStatus ? { reviewStatus: review.reviewStatus } : {}),
      ...(review?.reviewedAt ? { reviewedAt: review.reviewedAt } : {}),
      ...(review?.reviewIssue ? { reviewIssue: review.reviewIssue } : {}),
      ...(expected && expected === row.notification_status && row.notification_revision > 0
        ? { notification: { status: expected, revision: row.notification_revision } }
        : {}),
    };
  }
  async list(query: {
    filter: (typeof categories)[number];
    limit: number;
    before?: string;
    projectId?: string;
    kind?: 'task' | 'chat';
    query?: string;
    reviewFilter?: DeliveryReviewStatus;
    retryReviews?: 'true' | 'false';
    retryProjections?: 'true' | 'false';
  }): Promise<TaskCenterPage> {
    if (query.retryProjections === 'true') await this.projections.retry();
    await this.warm();
    if (query.retryReviews === 'true') this.delivery.retryFailures();
    return this.delivery.read(() => {
      let position: number | undefined;
      if (query.before) {
        const row = this.store.db.prepare('SELECT rowid position FROM runs WHERE id=?').get(query.before) as
          | { position: number }
          | undefined;
        if (!row)
          throw new AppError('RECORD_CURSOR_MISSING', '任务位置已失效，请返回最新列表', false, null, 409);
        position = row.position;
      }
      const clauses = [
        'deleted=0',
        'archived=0',
        ...(query.filter === 'all' ? [] : ['category=?']),
        ...(query.projectId ? ['project_id=?'] : []),
        ...(query.kind ? ['kind=?'] : []),
        ...(query.query?.trim() ? ["instr(lower(COALESCE(title,'')),?)>0"] : []),
      ];
      const params = [
        ...(query.filter === 'all' ? [] : [query.filter]),
        ...(query.projectId ? [query.projectId] : []),
        ...(query.kind ? [query.kind] : []),
        ...(query.query?.trim() ? [query.query.trim().toLocaleLowerCase()] : []),
      ];
      // Known scope exclusions remain exact. A broken Run body may also hide its
      // project/title, so those uncertain memberships stay in the coverage warning.
      const unknownRun =
        "EXISTS(SELECT 1 FROM projection_read_issues_v1 p WHERE p.table_name='runs' AND p.record_id=task_center_changes_v1.run_id)";
      const unknownKind = "kind IS NULL OR kind NOT IN ('task','chat')";
      const unknownProject =
        "project_id IS NOT NULL AND NOT (typeof(project_id)='text' AND length(project_id)=36 AND substr(project_id,9,1)='-' AND substr(project_id,14,1)='-' AND substr(project_id,19,1)='-' AND substr(project_id,24,1)='-' AND length(replace(project_id,'-',''))=32 AND lower(replace(project_id,'-','')) NOT GLOB '*[^0-9a-f]*')";
      const uncertainProject = query.kind && query.projectId ? ` OR (${unknownProject})` : '';
      const projectionUnavailable = Number(
        (
          this.store.db
            .prepare(
              `SELECT COUNT(*) n FROM task_center_changes_v1 WHERE deleted=0 AND archived=0 AND ${
                query.kind
                  ? `(category='unavailable' OR (${unknownKind})${uncertainProject})`
                  : "category='unavailable'"
              }
          ${query.projectId ? ` AND (project_id=? OR (project_id IS NULL AND ${unknownRun})${uncertainProject})` : ''}
          ${query.query?.trim() ? ` AND (instr(lower(COALESCE(title,'')),?)>0 OR ${unknownRun})` : ''}
          ${query.kind ? ` AND (kind=? OR ${unknownRun} OR (${unknownKind}))` : ''}`,
            )
            .get(
              ...(query.projectId ? [query.projectId] : []),
              ...(query.query?.trim() ? [query.query.trim().toLocaleLowerCase()] : []),
              ...(query.kind ? [query.kind] : []),
            ) as { n: number }
        ).n,
      );
      const unavailable = Number(
        (
          this.store.db
            .prepare(
              `SELECT COUNT(*) n FROM task_center_changes_v1 WHERE ${clauses.join(' AND ')}
        AND run_id IN (SELECT run_id FROM delivery_review_summary_v1 WHERE issue_code IS NOT NULL)`,
            )
            .get(...params) as { n: number }
        ).n,
      );
      if (query.reviewFilter) {
        clauses.push("category<>'unavailable'");
        clauses.push('run_id IN (SELECT run_id FROM delivery_review_summary_v1 WHERE review_status=?)');
        params.push(query.reviewFilter);
      }
      // New kind-filtered callers must not use another scope's cursor. Legacy callers
      // retain their original cursor semantics when no kind is supplied.
      if (
        query.kind &&
        query.before &&
        !this.store.db
          .prepare(`SELECT 1 FROM task_center_changes_v1 WHERE run_id=? AND ${clauses.join(' AND ')}`)
          .get(query.before, ...params)
      )
        throw new AppError(
          'RECORD_CURSOR_SCOPE',
          '任务位置不属于当前筛选范围，请返回最新列表',
          false,
          null,
          409,
        );
      const total = Number(
        (
          this.store.db
            .prepare(`SELECT COUNT(*) n FROM task_center_changes_v1 WHERE ${clauses.join(' AND ')}`)
            .get(...params) as { n: number }
        ).n,
      );
      const rows = this.store.db
        .prepare(
          `SELECT * FROM task_center_changes_v1 WHERE ${clauses.join(' AND ')}${position === undefined ? '' : ' AND position<?'} ORDER BY position DESC LIMIT ?`,
        )
        .all(...params, ...(position === undefined ? [] : [position]), query.limit + 1) as Row[];
      const hasMore = rows.length > query.limit,
        selected = rows.slice(0, query.limit);
      return {
        items: selected.map((row) => this.item(row)),
        reviewCoverage: { complete: unavailable === 0, unavailable },
        projectionCoverage: { complete: projectionUnavailable === 0, unavailable: projectionUnavailable },
        page: {
          total,
          limit: query.limit,
          before: query.before ?? null,
          hasMore,
          nextBefore: hasMore ? selected.at(-1)!.run_id : null,
        },
      };
    });
  }
  /** Verify one queued notification against current state without expanding its Run. */
  async itemById(runId: string): Promise<{ item: TaskCenterItem | null }> {
    await this.warm();
    return this.delivery.read(() => {
      const row = this.store.db
        .prepare('SELECT * FROM task_center_changes_v1 WHERE run_id=? AND deleted=0 AND archived=0')
        .get(runId) as Row | undefined;
      return { item: row ? this.item(row) : null };
    }, runId);
  }
  async changes(after: number | undefined, limit: number): Promise<TaskCenterChanges> {
    await this.warm();
    return this.delivery.read(() => {
      this.prune();
      const latest = Number(
        (
          this.store.db
            .prepare(
              "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='task_center_changes_v1'),0) n",
            )
            .get() as { n: number }
        ).n,
      );
      const floor = Number(
        (
          this.store.db.prepare("SELECT value FROM storage_meta WHERE key='task-center-floor:v1'").get() as {
            value: string;
          }
        ).value,
      );
      if (after === undefined) return { items: [], cursor: latest, hasMore: false, baseline: true };
      if (after < floor || after > latest)
        return { items: [], cursor: latest, hasMore: false, baseline: true, resetRequired: true };
      const rows = this.store.db
        .prepare('SELECT * FROM task_center_changes_v1 WHERE seq>? ORDER BY seq LIMIT ?')
        .all(after, limit + 1) as Row[];
      const hasMore = rows.length > limit,
        selected = rows.slice(0, limit);
      return {
        items: selected.map((row) => ({
          id: row.run_id,
          changeRevision: row.seq,
          item: row.deleted || row.archived ? null : this.item(row),
        })),
        cursor: hasMore ? selected.at(-1)!.seq : latest,
        hasMore,
      };
    });
  }
}
export function registerTaskCenter(app: FastifyInstance, store: Store) {
  const reads = new TaskCenterReads(store);
  app.get('/api/task-center', (request) =>
    reads.list(
      z
        .object({
          filter: z.enum(categories).default('all'),
          reviewFilter: z.enum(reviewStatuses).optional(),
          retryReviews: z.enum(['true', 'false']).optional(),
          retryProjections: z.enum(['true', 'false']).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(40),
          before: z.string().uuid().optional(),
          projectId: z.string().uuid().optional(),
          kind: z.enum(['task', 'chat']).optional(),
          query: z.string().max(200).optional(),
        })
        .strict()
        .parse(request.query),
    ),
  );
  app.get('/api/task-center/changes', (request) => {
    const query = z
      .object({
        after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(40),
      })
      .strict()
      .parse(request.query);
    return reads.changes(query.after, query.limit);
  });
  app.get('/api/task-center/:id', (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reads.itemById(id);
  });
}
