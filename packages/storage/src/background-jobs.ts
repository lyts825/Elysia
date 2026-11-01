/** 后台作业正文压缩保存，查询元数据与正文在同一事务更新；不产生外置对象引用。 */
import type { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { BackgroundJob, type BackgroundJobSummary } from '../../contracts/src/background-jobs.js';
import { AppError, invariant } from '../../contracts/src/index.js';
import type { Store } from './index.js';

export function initializeBackgroundJobs(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS background_jobs_v1(
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, status TEXT NOT NULL,
    execution_operation_id TEXT NOT NULL UNIQUE, delivered_at TEXT, content BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS background_jobs_run ON background_jobs_v1(run_id,status);
    CREATE INDEX IF NOT EXISTS background_jobs_pending ON background_jobs_v1(status,delivered_at);`);
}

export class BackgroundJobsStore {
  constructor(private store: Store) {
    initializeBackgroundJobs(store.db);
  }
  get(id: string): BackgroundJob | undefined {
    const row = this.store.db.prepare('SELECT * FROM background_jobs_v1 WHERE id=?').get(id) as
      | {
          id: string;
          run_id: string;
          task_id: string;
          revision: number;
          status: string;
          execution_operation_id: string;
          delivered_at: string | null;
          content: Uint8Array;
        }
      | undefined;
    if (!row) return undefined;
    try {
      const value = BackgroundJob.parse(
        JSON.parse(gunzipSync(row.content, { maxOutputLength: 2 * 1024 * 1024 }).toString()),
      );
      invariant(
        value.id === row.id &&
          value.runId === row.run_id &&
          value.taskId === row.task_id &&
          value.revision === row.revision &&
          value.status === row.status &&
          value.executionOperationId === row.execution_operation_id &&
          (value.deliveredAt ?? null) === row.delivered_at,
        'JOB_CORRUPT',
        '后台作业元数据不一致',
      );
      return value;
    } catch {
      this.store.recovery.hold(row.run_id, 'recovery_unreadable');
      throw new AppError('JOB_CORRUPT', '后台作业记录无法核验，已停止所属运行');
    }
  }
  put(job: BackgroundJob, expectedRevision?: number): BackgroundJob {
    return this.store.tx(() => {
      const prior = this.get(job.id);
      invariant(
        expectedRevision === undefined || prior?.revision === expectedRevision,
        'JOB_CHANGED',
        '后台作业状态已变化，请刷新后重试',
      );
      const next = BackgroundJob.parse({
        ...job,
        revision: prior ? prior.revision + 1 : 0,
        updatedAt: new Date().toISOString(),
      });
      this.store.db
        .prepare(
          `INSERT INTO background_jobs_v1 VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,
        delivered_at=excluded.delivered_at,content=excluded.content`,
        )
        .run(
          next.id,
          next.runId,
          next.taskId,
          next.revision,
          next.status,
          next.executionOperationId,
          next.deliveredAt ?? null,
          gzipSync(JSON.stringify(next)),
        );
      return next;
    });
  }
  find(options: { runId?: string; taskId?: string; unsettled?: boolean; pendingDelivery?: boolean } = {}) {
    const clauses: string[] = [],
      args: string[] = [];
    if (options.runId) {
      clauses.push('run_id=?');
      args.push(options.runId);
    }
    if (options.taskId) {
      clauses.push('task_id=?');
      args.push(options.taskId);
    }
    if (options.unsettled) clauses.push("status IN ('RUNNING','UNCERTAIN')");
    if (options.pendingDelivery) clauses.push("status <> 'RUNNING' AND delivered_at IS NULL");
    return (
      this.store.db
        .prepare(
          'SELECT id FROM background_jobs_v1' +
            (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') +
            ' ORDER BY rowid',
        )
        .all(...args) as { id: string }[]
    ).map((row) => this.get(row.id)!);
  }
  list(runId: string): BackgroundJobSummary[] {
    return this.find({ runId }).map((job) => this.summary(job));
  }
  private summary({ result, command, ...job }: BackgroundJob): BackgroundJobSummary {
    return {
      ...job,
      command: {
        program: command.program,
        cwd: command.cwd,
        timeout: command.timeout,
        outputLimit: command.outputLimit,
      },
      resultAvailable: !!result,
    };
  }
  listPage(runId: string, before?: string) {
    let cursor: number | undefined;
    if (before) {
      const row = this.store.db
        .prepare('SELECT rowid FROM background_jobs_v1 WHERE id=? AND run_id=?')
        .get(before, runId) as { rowid: number } | undefined;
      invariant(row, 'JOB_CURSOR', '作业分页游标失效或不属于当前运行');
      cursor = row.rowid;
    }
    const rows = (
      cursor === undefined
        ? this.store.db
            .prepare('SELECT id FROM background_jobs_v1 WHERE run_id=? ORDER BY rowid DESC LIMIT 21')
            .all(runId)
        : this.store.db
            .prepare(
              'SELECT id FROM background_jobs_v1 WHERE run_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21',
            )
            .all(runId, cursor)
    ) as { id: string }[];
    const jobs = rows.slice(0, 20).map((row) => this.summary(this.get(row.id)!));
    const total = Number(
      (
        this.store.db.prepare('SELECT COUNT(*) count FROM background_jobs_v1 WHERE run_id=?').get(runId) as {
          count: number;
        }
      ).count,
    );
    return { jobs, total, hasMore: rows.length > 20, nextBefore: rows.length > 20 ? jobs.at(-1)!.id : null };
  }
  findByOperation(runId: string, operationId: string) {
    const row = this.store.db
      .prepare('SELECT id FROM background_jobs_v1 WHERE run_id=? AND execution_operation_id=?')
      .get(runId, operationId) as { id: string } | undefined;
    return row ? this.get(row.id) : undefined;
  }
}
