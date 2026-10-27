// 读取业务表投影，并向调用者报告无法安全读取的记录。
import { AppError, Status, type Entity } from '../../contracts/src/index.js';
import type { ProjectionReadCoverage, ProjectionReadIssue } from '../../contracts/src/run-reads.js';
import type { Store } from './index.js';

export const projectionTables = ['runs', 'tasks', 'requests', 'tool_operations'] as const;
export type ProjectionTable = (typeof projectionTables)[number];
export const projectionIssue: ProjectionReadIssue = {
  code: 'READ_MODEL_UNAVAILABLE',
  message: '部分记录暂时无法读取，状态与统计可能不完整。修复记录后可重试读取。',
  retryable: true,
};
const states: Record<ProjectionTable, readonly string[]> = {
  runs: Status.options,
  tasks: Status.options,
  requests: ['RESERVED', 'SETTLED', 'UNKNOWN', 'RELEASED'],
  tool_operations: ['INTENT', 'DONE', 'FAILED', 'UNCERTAIN'],
};

/** Derived failures never overwrite the original compressed body or pretend it was migrated. */
export class ProjectionReads {
  constructor(private store: Store) {
    store.tx(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS projection_read_issues_v1(
        table_name TEXT NOT NULL,record_id TEXT NOT NULL,run_id TEXT NOT NULL,retry_requested INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(table_name,record_id)
      );
      CREATE INDEX IF NOT EXISTS projection_read_issue_run ON projection_read_issues_v1(run_id);`);
      for (const table of projectionTables)
        store.db.exec(`DROP TRIGGER IF EXISTS projection_issue_${table}_changed;
          CREATE TRIGGER projection_issue_${table}_changed
          AFTER UPDATE ON ${table}
          WHEN NEW.content IS NOT OLD.content OR NEW.run_id IS NOT OLD.run_id
            OR NEW.revision IS NOT OLD.revision
            OR json_extract(NEW.data,'$.revision') IS NOT json_extract(OLD.data,'$.revision')
            OR (NEW.content IS NULL AND NEW.data IS NOT OLD.data)
          BEGIN DELETE FROM projection_read_issues_v1 WHERE table_name='${table}' AND record_id=NEW.id;
            UPDATE storage_meta SET value='1' WHERE key='task-center-warm:v1'; END;
          CREATE TRIGGER IF NOT EXISTS projection_issue_${table}_deleted AFTER DELETE ON ${table}
          BEGIN DELETE FROM projection_read_issues_v1 WHERE table_name='${table}' AND record_id=OLD.id; END;`);
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS projection_issue_search_insert
        AFTER INSERT ON projection_read_issues_v1 WHEN NEW.table_name='runs'
        BEGIN DELETE FROM history_search_v1 WHERE kind='run' AND record_id=NEW.record_id;
          DELETE FROM history_search_pending_v2 WHERE kind='run' AND record_id=NEW.record_id;
          INSERT INTO history_search_epochs_v2(kind,scope,revision) VALUES('run','global',1)
          ON CONFLICT(kind,scope) DO UPDATE SET revision=revision+1; END;
        CREATE TRIGGER IF NOT EXISTS projection_issue_search_delete
        AFTER DELETE ON projection_read_issues_v1 WHEN OLD.table_name='runs'
        BEGIN INSERT OR IGNORE INTO history_search_pending_v2(kind,record_id,run_id)
          SELECT 'run',id,id FROM runs WHERE id=OLD.record_id;
          INSERT INTO history_search_epochs_v2(kind,scope,revision) VALUES('run','global',1)
          ON CONFLICT(kind,scope) DO UPDATE SET revision=revision+1; END;`);
    });
  }
  available(table: ProjectionTable, alias = table) {
    return `NOT EXISTS(SELECT 1 FROM projection_read_issues_v1 p WHERE p.table_name='${table}' AND p.record_id=${alias}.id)`;
  }
  missing(table: ProjectionTable, alias = table) {
    return `(json_extract(${alias}.data,'$.readModelVersion') IS NOT 1 OR json_type(${alias}.data,'$.readModel') IS NOT 'object')`;
  }
  has(table: ProjectionTable, id: string) {
    return !!this.store.db
      .prepare('SELECT 1 FROM projection_read_issues_v1 WHERE table_name=? AND record_id=?')
      .get(table, id);
  }
  read<T extends Entity>(table: ProjectionTable, id: string, refresh = false, retry = false): T | undefined {
    if (!retry && this.has(table, id)) return;
    this.store.db.exec('SAVEPOINT projection_read_item');
    try {
      const entity = this.store.get<T>(table, id);
      if (entity) {
        const value = entity as any;
        const metadata = this.store.db.prepare(`SELECT revision,run_id FROM ${table} WHERE id=?`).get(id) as
          | { revision: number; run_id: string | null }
          | undefined;
        if (
          value.id !== id ||
          value.revision !== metadata?.revision ||
          (value.runId ?? null) !== metadata?.run_id ||
          !states[table].includes(value.status) ||
          (table === 'tasks' &&
            (!value.spec || typeof value.spec !== 'object' || Array.isArray(value.spec))) ||
          (table === 'requests' &&
            (!value.manifest || typeof value.manifest !== 'object' || Array.isArray(value.manifest))) ||
          (table === 'runs' && (typeof value.objective !== 'string' || typeof value.title !== 'string'))
        )
          throw new Error('Invalid legacy read fields');
        if (refresh) this.store.refreshReadProjection(table, entity);
      }
      if (retry)
        this.store.db
          .prepare('DELETE FROM projection_read_issues_v1 WHERE table_name=? AND record_id=?')
          .run(table, id);
      this.store.db.exec('RELEASE projection_read_item');
      return entity;
    } catch (error) {
      this.store.db.exec('ROLLBACK TO projection_read_item; RELEASE projection_read_item');
      if ((error as { code?: string })?.code === 'ERR_SQLITE_ERROR') throw error;
      this.store.db
        .prepare(
          `INSERT OR REPLACE INTO projection_read_issues_v1(table_name,record_id,run_id)
        SELECT ?,id,${table === 'runs' ? 'id' : 'COALESCE(run_id,id)'} FROM ${table} WHERE id=?`,
        )
        .run(table, id);
      return;
    }
  }
  require<T extends Entity>(table: ProjectionTable, id: string): T {
    const result = this.read<T>(table, id);
    if (result) return result;
    if (this.has(table, id))
      throw new AppError(projectionIssue.code, projectionIssue.message, true, null, 422);
    throw new AppError('NOT_FOUND', '记录不存在', false, null, 404);
  }
  /** Keep healthy records readable without touching the original business bodies. */
  collection<T extends Entity>(table: Exclude<ProjectionTable, 'runs'>, runId: string): T[] {
    const rows = this.store.db
      .prepare(`SELECT id FROM ${table} WHERE run_id=? AND ${this.available(table)} ORDER BY rowid`)
      .all(runId) as { id: string }[];
    return rows.flatMap(({ id }) => {
      const row = this.read<T>(table, id);
      return row ? [row] : [];
    });
  }
  batch(table: ProjectionTable, runId?: string) {
    const rows = this.store.db
      .prepare(
        `SELECT id FROM ${table} WHERE content IS NOT NULL AND ${this.missing(table)} AND ${this.available(table)}${runId ? ' AND run_id=?' : ''} ORDER BY rowid LIMIT 32`,
      )
      .all(...(runId ? [runId] : [])) as { id: string }[];
    this.store.tx(() => {
      for (const row of rows) this.read(table, row.id, true);
    });
    return rows.length;
  }
  async warm(table: ProjectionTable, runId?: string) {
    while (this.batch(table, runId)) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  warmSync(table: ProjectionTable, runId?: string) {
    while (this.batch(table, runId)) {}
  }
  async retry(runId?: string) {
    this.store.tx(() => {
      this.store.db
        .prepare(`UPDATE projection_read_issues_v1 SET retry_requested=1${runId ? ' WHERE run_id=?' : ''}`)
        .run(...(runId ? [runId] : []));
      this.store.db.prepare("UPDATE storage_meta SET value='1' WHERE key='task-center-warm:v1'").run();
    });
    for (;;) {
      const rows = this.store.db
        .prepare(
          `SELECT table_name,record_id FROM projection_read_issues_v1 WHERE retry_requested=1${runId ? ' AND run_id=?' : ''} LIMIT 32`,
        )
        .all(...(runId ? [runId] : [])) as { table_name: ProjectionTable; record_id: string }[];
      if (!rows.length) return;
      this.store.tx(() => {
        for (const row of rows) this.read(row.table_name, row.record_id, true, true);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  coverage(table?: ProjectionTable, runId?: string): ProjectionReadCoverage {
    const clauses = [...(table ? ['table_name=?'] : []), ...(runId ? ['run_id=?'] : [])];
    const unavailable = Number(
      (
        this.store.db
          .prepare(
            `SELECT COUNT(${table ? '*' : 'DISTINCT run_id'}) n FROM projection_read_issues_v1${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}`,
          )
          .get(...(table ? [table] : []), ...(runId ? [runId] : [])) as { n: number }
      ).n,
    );
    return { complete: unavailable === 0, unavailable };
  }
}
const instances = new WeakMap<Store, ProjectionReads>();
export function projectionReads(store: Store) {
  let value = instances.get(store);
  if (!value) {
    value = new ProjectionReads(store);
    instances.set(store, value);
  }
  return value;
}
