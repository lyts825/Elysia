/**
 * 汇总交付审阅数据并提供读取服务。
 * 维护按状态筛选的小型当前投影并按需核验，隔离坏记录且暴露问题代码；不改复核正文或代替用户验收。
 * EN: Summarizes delivery-review state and provides read services. Maintains filterable current projections with lazy verification and damaged-row issue codes, without editing reviews or deciding acceptance.
 */
import type { Run, Task } from '../../../packages/contracts/src/index.js';
import type {
  DeliveryReviewStatus,
  DeliveryReviewSummary,
} from '../../../packages/contracts/src/workflow.js';
import type { Store } from '../../../packages/storage/src/index.js';
import { deliveryFingerprint } from './delivery-fingerprint.js';

type Row = {
  review_status: DeliveryReviewStatus | null;
  reviewed_at: string | null;
  issue_code: string | null;
};
const unreadable = {
  code: 'DELIVERY_UNREADABLE' as const,
  message: '交付记录暂时无法读取，复核结论未知。可修复记录后重试。',
  retryable: true as const,
};
/**
 * 单项和批量读取共用缺失值与不可读摘要映射。
 * EN: Shares missing-value and unreadable-summary mapping between single and batch reads.
 */
const reviewSummary = (runId: string, row?: Row): DeliveryReviewSummary => ({
  runId,
  reviewStatus: row?.review_status ?? null,
  reviewedAt: row?.reviewed_at ?? null,
  ...(row?.issue_code ? { reviewIssue: unreadable } : {}),
});
type Projection = {
  deliveryProjectionVersion?: number;
  deliveryReview?: Pick<NonNullable<Run['deliveryReview']>, 'decision' | 'fingerprint' | 'reviewedAt'> | null;
  readModel?: Pick<Run, 'id' | 'kind' | 'status' | 'projectId' | 'rootTaskId' | 'execution'>;
};
/**
 * 生成兼容 readModel 与旧字段的根任务 SQL 表达式；别名只来自本模块固定查询。
 * EN: Builds root-task SQL supporting readModel and legacy fields; aliases come only from fixed module queries.
 */
const rootId = (alias: string) =>
  `COALESCE(json_extract(${alias ? alias + '.' : ''}data,'$.readModel.rootTaskId'),json_extract(${alias ? alias + '.' : ''}data,'$.rootTaskId'))`;

/**
 * 可重建索引：来源写入事务内的触发器使其失效，读取会排空全部脏批次。 维护交付复核摘要投影并协调预热，支持缓存查询和失败重试。
 * EN: Rebuildable index. Triggers invalidate inside the source write transaction; reads drain all dirty batches. Maintains delivery-review summary projections and warm-up, including caching and explicit retry.
 */
export class DeliveryReviewReads {
  private warming?: Promise<void>;
  /**
   * 建立小型交付复核投影、兼容列和索引，并安装关联变更触发器；业务正文仍由显式读取隔离核验。
   * EN: Creates compact review projections, compatibility columns/indexes and mutation triggers; explicit reads still isolate and validate business bodies.
   */
  constructor(private store: Store) {
    store.tx(() => {
      store.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_review_summary_v1(
        run_id TEXT PRIMARY KEY,review_status TEXT,reviewed_at TEXT,dirty INTEGER NOT NULL DEFAULT 1,issue_code TEXT
      );
      CREATE INDEX IF NOT EXISTS delivery_review_dirty ON delivery_review_summary_v1(dirty,run_id);
      CREATE INDEX IF NOT EXISTS delivery_review_status ON delivery_review_summary_v1(review_status,run_id);
      CREATE INDEX IF NOT EXISTS delivery_review_root ON runs(${rootId('')});
      INSERT OR IGNORE INTO delivery_review_summary_v1(run_id) SELECT id FROM runs;
    `);
      const columns = store.db.prepare('PRAGMA table_info(delivery_review_summary_v1)').all() as {
        name: string;
      }[];
      if (!columns.some((column) => column.name === 'issue_code'))
        store.db.exec('ALTER TABLE delivery_review_summary_v1 ADD COLUMN issue_code TEXT');
      store.db.exec(
        'CREATE INDEX IF NOT EXISTS delivery_review_issue ON delivery_review_summary_v1(issue_code,run_id)',
      );
      /**
       * 包装投影失效 upsert SQL，保留原行并置 dirty 供后续按需重建。
       * EN: Builds invalidation upsert SQL that retains rows and marks them dirty for lazy rebuilding.
       */
      const dirty = (query: string) => `INSERT INTO delivery_review_summary_v1(run_id,dirty) ${query}
      ON CONFLICT(run_id) DO UPDATE SET dirty=1;`;
      for (const table of ['runs', 'tasks', 'artifacts']) {
        /**
         * 按触发器表及 NEW/OLD 归属选择受影响运行；任务只关联根任务，产物按 run_id 关联。
         * EN: Selects affected runs by trigger table and NEW/OLD ownership, linking tasks by root and artifacts by run_id.
         */
        const query = (alias: 'NEW' | 'OLD') =>
          table === 'runs'
            ? `SELECT id,1 FROM runs WHERE id=${alias}.id`
            : table === 'tasks'
              ? `SELECT r.id,1 FROM runs r WHERE ${rootId('r')}=${alias}.id`
              : `SELECT id,1 FROM runs WHERE id=${alias}.run_id`;
        /**
         * 生成内部触发器使用的 JSON 字段读取表达式，不接受外部别名或字段。
         * EN: Builds JSON-field expressions for internal triggers only, with no external aliases or field names.
         */
        const field = (alias: string, name: string) => `json_extract(${alias}.data,'$.${name}')`;
        const changed =
          table === 'runs'
            ? [
                'readModel.kind',
                'readModel.status',
                'readModel.projectId',
                'readModel.rootTaskId',
                'readModel.execution.kind',
                'deliveryProjectionVersion',
                'deliveryReview',
              ]
                .map((name) => `${field('NEW', name)} IS NOT ${field('OLD', name)}`)
                .join(' OR ') +
              ` OR json_type(NEW.data,'$.readModel') IS NOT 'object' OR ${field('NEW', 'deliveryProjectionVersion')} IS NOT 1`
            : `NEW.run_id IS NOT OLD.run_id OR ${field('NEW', 'deliverySemanticHash')} IS NOT ${field('OLD', 'deliverySemanticHash')}
          OR ${field('NEW', 'deliverySemanticHash')} IS NULL OR ${field('OLD', 'deliverySemanticHash')} IS NULL`;
        /**
         * 生成受影响投影已有错误的 SQL 判定，允许后续修复使失败摘要重新变脏。
         * EN: Builds SQL detecting failed affected projections so later repairs can invalidate those summaries again.
         */
        const failed = (
          alias: 'NEW' | 'OLD',
        ) => `EXISTS(SELECT 1 FROM delivery_review_summary_v1 d WHERE d.issue_code IS NOT NULL
        AND d.run_id IN (${query(alias).replace(',1 FROM', ' FROM')}))`;
        store.db.exec(`
        CREATE TRIGGER IF NOT EXISTS delivery_review_${table}_insert AFTER INSERT ON ${table}
        BEGIN ${dirty(query('NEW'))} END;
        DROP TRIGGER IF EXISTS delivery_review_${table}_update;
        CREATE TRIGGER delivery_review_${table}_update AFTER UPDATE ON ${table}
        WHEN ${changed} OR (NEW.revision IS OLD.revision AND NEW.content IS NOT OLD.content)
          OR ${failed('OLD')} OR ${failed('NEW')}
        BEGIN ${dirty(query('OLD'))} ${dirty(query('NEW'))} END;
        CREATE TRIGGER IF NOT EXISTS delivery_review_${table}_delete AFTER DELETE ON ${table}
        BEGIN ${table === 'runs' ? 'DELETE FROM delivery_review_summary_v1 WHERE run_id=OLD.id;' : dirty(query('OLD'))} END;
      `);
      }
    });
  }
  /**
   * 只读已构建摘要；调用方需先 ensure/read 保证脏记录已处理，错误码另行表达未知结论。
   * EN: Reads built summaries only. Callers must ensure/read dirty work first; error codes separately represent unknown conclusions.
   */
  cached(runId: string): DeliveryReviewSummary {
    const row = this.store.db
      .prepare('SELECT review_status,reviewed_at,issue_code FROM delivery_review_summary_v1 WHERE run_id=?')
      .get(runId) as Row | undefined;
    return reviewSummary(runId, row);
  }
  /**
   * 在 ensure/read 的一致性边界内批读当前页已有摘要；缺失项仍返回未知结论，不预热或缓存。
   * EN: Reads existing page summaries within ensure/read's consistency boundary; missing entries remain unknown, without warming or caching.
   */
  cachedMany(runIds: readonly string[]): Map<string, DeliveryReviewSummary> {
    if (!runIds.length) return new Map();
    const rows = this.store.db
      .prepare(
        'SELECT run_id,review_status,reviewed_at,issue_code FROM delivery_review_summary_v1 WHERE run_id IN (SELECT value FROM json_each(?))',
      )
      .all(JSON.stringify(runIds)) as (Row & { run_id: string })[];
    const found = new Map(rows.map((row) => [row.run_id, row]));
    return new Map(runIds.map((runId) => [runId, reviewSummary(runId, found.get(runId))]));
  }
  /**
   * 显式将失败项重新标脏，不修改原始交付/复核正文；下一次 ensure 才真正重建。
   * EN: Explicitly marks failed rows dirty without editing authoritative delivery or review bodies; the next ensure performs rebuilding.
   */
  retryFailures(runId?: string) {
    this.store.db
      .prepare(
        `UPDATE delivery_review_summary_v1 SET dirty=1 WHERE issue_code IS NOT NULL${runId ? ' AND run_id=?' : ''}`,
      )
      .run(...(runId ? [runId] : []));
  }
  /**
   * 单条坏记录只回滚自身刷新并保存不可读标记；数据库错误仍中止整次读取。
   * EN: A bad row rolls back only its refresh and saves an unreadable marker; database errors still abort the complete read.
   */
  private refreshSafely(runId: string) {
    this.store.db.exec('SAVEPOINT delivery_review_item');
    try {
      this.refresh(runId);
      this.store.db.exec('RELEASE delivery_review_item');
    } catch (error) {
      this.store.db.exec('ROLLBACK TO delivery_review_item; RELEASE delivery_review_item');
      /**
       * 数据库或事务失败影响整次读取，不当作单条交付记录错误。
       * EN: Database/transaction failures affect the whole read, not a single delivery record.
       */
      if ((error as { code?: string })?.code === 'ERR_SQLITE_ERROR') throw error;
      this.store.db
        .prepare(
          'UPDATE delivery_review_summary_v1 SET review_status=NULL,reviewed_at=NULL,issue_code=?,dirty=0 WHERE run_id=?',
        )
        .run(unreadable.code, runId);
    }
  }
  /**
   * 只为已完成的原生项目任务生成复核状态，旧投影按需回填；指纹不符的旧结论标 stale。
   * EN: Builds review status only for completed native project tasks, backfills legacy projections on demand, and marks mismatched old decisions stale.
   */
  private refresh(runId: string) {
    const row = this.store.db.prepare('SELECT data FROM runs WHERE id=?').get(runId) as
      | { data: string }
      | undefined;
    if (!row) {
      this.store.db.prepare('DELETE FROM delivery_review_summary_v1 WHERE run_id=?').run(runId);
      return;
    }
    let projection = JSON.parse(row.data) as Projection;
    /**
     * 仅允许已完成、属于项目的原生任务进入交付复核；缺少可读投影时返回 false。
     * EN: Allows only completed native project tasks into delivery review; missing readable projections return false.
     */
    const eligible = (run: Projection['readModel']) =>
      !!run &&
      run.kind === 'task' &&
      run.status === 'DONE' &&
      !!run.projectId &&
      (run.execution?.kind ?? 'native') === 'native';
    /**
     * 旧摘要缺复核元数据，仅对可能符合条件的记录还原一次正文。
     * EN: Legacy summaries lack review metadata. Hydrate only potentially eligible records once.
     */
    if (
      !projection.readModel ||
      (eligible(projection.readModel) && projection.deliveryProjectionVersion !== 1)
    ) {
      const run = this.store.require<Run>('runs', runId);
      this.store.refreshReadProjection('runs', run);
      projection = { readModel: run, deliveryProjectionVersion: 1, deliveryReview: run.deliveryReview };
    }
    let status: DeliveryReviewStatus | null = null;
    let reviewedAt: string | null = null;
    if (eligible(projection.readModel)) {
      const review = projection.deliveryReview;
      status = 'unreviewed';
      if (review) {
        const root = this.store.get<Task>('tasks', projection.readModel!.rootTaskId);
        if (
          root &&
          !this.store.db
            .prepare(
              "SELECT 1 FROM tasks WHERE id=? AND json_extract(data,'$.deliverySemanticHash') IS NOT NULL",
            )
            .get(root.id)
        )
          this.store.refreshReadProjection('tasks', root);
        status =
          root &&
          root.runId === runId &&
          review.fingerprint === deliveryFingerprint(this.store, { id: runId }, root)
            ? review.decision
            : 'stale';
        reviewedAt = review.reviewedAt;
      }
    }
    this.store.db
      .prepare(
        'UPDATE delivery_review_summary_v1 SET review_status=?,reviewed_at=?,dirty=0,issue_code=NULL WHERE run_id=?',
      )
      .run(status, reviewedAt, runId);
  }
  /**
   * 指定运行仅刷新该项；全量预热共享一个 Promise，分批让出事件循环。
   * EN: A selected run refreshes only that entry; global warming shares one promise and yields between batches.
   */
  async ensure(runId?: string) {
    if (runId) {
      if (
        this.store.db
          .prepare('SELECT 1 FROM delivery_review_summary_v1 WHERE run_id=? AND dirty=1')
          .get(runId)
      )
        this.store.tx(() => this.refreshSafely(runId));
      return;
    }
    if (this.warming) return this.warming;
    const pending = this.batches();
    this.warming = pending;
    try {
      await pending;
    } finally {
      if (this.warming === pending) this.warming = undefined;
    }
  }
  /**
   * 即使其他写入在await期间使摘要变脏，也只发布一致快照。
   * EN: Publish a coherent snapshot even when another writer dirties a summary during an await.
   */
  async read<T>(read: () => T, runId?: string): Promise<T> {
    for (;;) {
      await this.ensure(runId);
      const result = this.store.tx(() => {
        const dirty = runId
          ? this.store.db
              .prepare('SELECT 1 FROM delivery_review_summary_v1 WHERE run_id=? AND dirty=1')
              .get(runId)
          : this.store.db.prepare('SELECT 1 FROM delivery_review_summary_v1 WHERE dirty=1 LIMIT 1').get();
        return dirty ? { ready: false as const } : { ready: true as const, value: read() };
      });
      if (result.ready) return result.value;
    }
  }
  /**
   * 每批最多32条、同批事务提交；持续读取脏队列直到当前没有待处理项。
   * EN: Commits at most 32 rows per batch and drains dirty work until no entries remain in the current view.
   */
  private async batches() {
    for (;;) {
      const rows = this.store.db
        .prepare('SELECT run_id FROM delivery_review_summary_v1 WHERE dirty=1 ORDER BY run_id LIMIT 32')
        .all() as { run_id: string }[];
      if (!rows.length) return;
      this.store.tx(() => {
        for (const { run_id } of rows) this.refreshSafely(run_id);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
const instances = new WeakMap<Store, DeliveryReviewReads>();
/**
 * 按 Store 惰性复用复核读取器，避免每次路由重复创建表、索引和触发器。
 * EN: Lazily reuses one review reader per Store rather than recreating schema/index/trigger setup per route.
 */
export function deliveryReviewReads(store: Store) {
  let instance = instances.get(store);
  if (!instance) {
    instance = new DeliveryReviewReads(store);
    instances.set(store, instance);
  }
  return instance;
}
