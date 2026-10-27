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

/** 记录投影读取问题，同时保留原始业务正文，供修复后重试。 */
export class ProjectionReads {
  /** 建立问题表和失效触发器；正文修复会解除旧问题并使任务中心、历史搜索重新预热。 */
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
  /** 生成排除已知问题行的 SQL 片段；table 来自固定表枚举，alias 仅供内部查询拼接。 */
  available(table: ProjectionTable, alias = table) {
    return `NOT EXISTS(SELECT 1 FROM projection_read_issues_v1 p WHERE p.table_name='${table}' AND p.record_id=${alias}.id)`;
  }
  /** 判断投影版本或 readModel 对象缺失，用于选取需要从权威正文重建的行。 */
  missing(table: ProjectionTable, alias = table) {
    return `(json_extract(${alias}.data,'$.readModelVersion') IS NOT 1 OR json_type(${alias}.data,'$.readModel') IS NOT 'object')`;
  }
  /** 判断是否已登记不可读问题；不尝试读取或修复正文。 */
  has(table: ProjectionTable, id: string) {
    return !!this.store.db
      .prepare('SELECT 1 FROM projection_read_issues_v1 WHERE table_name=? AND record_id=?')
      .get(table, id);
  }
  /**
   * 读取并校验实体与数据库元数据的一致性。refresh 可重建投影；retry 允许重查已标记问题。
   * 单条数据错误写入问题表并返回 undefined，SQLite 本身的错误继续向上传递。
   */
  read<T extends Entity>(table: ProjectionTable, id: string, refresh = false, retry = false): T | undefined {
    if (!retry && this.has(table, id)) return;
    // 单条记录失败只回滚自身的刷新，不撤销外围批次中的其他记录。
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
  /** 区分记录不存在与记录存在但当前不可读取。 */
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
  /** 每批最多刷新 32 条缺少投影的健康记录。 */
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
  /** 分批预热并在批次之间让出事件循环。 */
  async warm(table: ProjectionTable, runId?: string) {
    while (this.batch(table, runId)) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  /** 在必须同步完成的初始化路径逐批预热；正常交互应使用会让出事件循环的 warm。 */
  warmSync(table: ProjectionTable, runId?: string) {
    while (this.batch(table, runId)) {}
  }
  /** 请求重新检查已有问题；仍不可读的记录继续保留问题标记。 */
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
  /** 返回指定表或运行的不可读数量；未指定表时按运行去重。 */
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
/** 每个 Store 复用一个读取器；WeakMap 不延长已释放 Store 的生命周期。 */
export function projectionReads(store: Store) {
  let value = instances.get(store);
  if (!value) {
    value = new ProjectionReads(store);
    instances.set(store, value);
  }
  return value;
}
