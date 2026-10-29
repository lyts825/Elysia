/**
 * 汇总任务中心数据并注册查询接口。
 * 持久当前分类、复核摘要及单调通知/墓碑，触发器维护小投影且旧正文按需预热；通知核对当前状态，首个基线不误报历史为新事件。
 * EN: Aggregates task-center data and registers reads. Persists current categories/reviews/monotonic notifications and tombstones with compact triggers/lazy warming; verifies current state and never reports history as new baseline events.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, type Entity } from '../../../packages/contracts/src/index.js';
import type {
  TaskCenterItem,
  TaskCenterPage,
  TaskCenterChanges,
} from '../../../packages/contracts/src/task-center.js';
import type { Store } from '../../../packages/storage/src/index.js';
import type {
  DeliveryReviewStatus,
  DeliveryReviewSummary,
} from '../../../packages/contracts/src/workflow.js';
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
/**
 * 生成兼容新旧投影的状态 SQL，别名来自内部固定表引用。
 * EN: Builds status SQL supporting current/legacy projections using internal fixed aliases.
 */
const state = (alias: string) =>
  `COALESCE(json_extract(${alias ? alias + '.' : ''}data,'$.readModel.status'),json_extract(${alias ? alias + '.' : ''}data,'$.status'))`;
/**
 * 生成任务等待原因 SQL，优先读取小投影并兼容旧字段。
 * EN: Builds wait-reason SQL preferring compact projections with legacy fallback.
 */
const waitReason = (alias: string) =>
  `COALESCE(json_extract(${alias}.data,'$.readModel.waitReason'),json_extract(${alias}.data,'$.waitReason'))`;

/**
 * 采用小型持久当前状态投影；仅在显式访问时预热历史正文。 读取任务中心投影和交付复核摘要，支持筛选、分页及增量查询。
 * EN: A small persistent current-state read model; historical bodies are warmed only on explicit access. Reads task-center projections and delivery review summaries with filtering, paging and incremental queries.
 */
export class TaskCenterReads {
  private warming?: Promise<void>;
  private delivery: DeliveryReviewReads;
  private projections: ProjectionReads;
  /**
   * 创建当前分类、单调通知序号和删除墓碑投影及触发器；分类综合问题、核验、hold 和交付复核，历史正文仅按需预热。
   * EN: Creates current classification, monotonic notification and tombstone projections/triggers. Classification combines questions, verification, holds and delivery review while history bodies warm lazily.
   */
  constructor(private store: Store) {
    /**
     * 用小型当前状态投影维护分类与通知序号；历史正文只在显式预热/读取时展开。
     * EN: Maintains categories and notification sequence with a small current-state projection; historical bodies expand only on explicit warm/read.
     */
    this.projections = projectionReads(store);
    this.delivery = deliveryReviewReads(store);
    const status = state('r');
    const runReason = "COALESCE(json_extract(r.data,'$.readModel.reason'),json_extract(r.data,'$.reason'))";
    /**
     * 生成同运行任务存在性子查询，把内部分类条件嵌入只读触发器 SQL。
     * EN: Builds same-run task existence SQL from internal classification predicates for read-model triggers.
     */
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
    const held = 'EXISTS(SELECT 1 FROM execution_holds_v1 h WHERE h.run_id=r.id)';
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
          WHEN ${held} OR ${paused} THEN 'paused'
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
    for (const table of ['execution_holds_v1', 'execution_recovery_issues_v1'] as const) {
      const changed =
        table === 'execution_holds_v1'
          ? 'NEW.reason IS NOT OLD.reason OR NEW.since IS NOT OLD.since OR NEW.run_id IS NOT OLD.run_id'
          : 'NEW.run_id IS NOT OLD.run_id OR NEW.table_name IS NOT OLD.table_name OR NEW.record_id IS NOT OLD.record_id';
      this.store.db.exec(`
        CREATE TRIGGER IF NOT EXISTS task_center_${table}_insert AFTER INSERT ON ${table}
        BEGIN ${this.refreshSql('NEW.run_id')} END;
        CREATE TRIGGER IF NOT EXISTS task_center_${table}_update AFTER UPDATE ON ${table} WHEN ${changed}
        BEGIN ${this.refreshSql('CASE WHEN OLD.run_id IS NOT NEW.run_id THEN OLD.run_id END')} ${this.refreshSql('NEW.run_id')} END;
        CREATE TRIGGER IF NOT EXISTS task_center_${table}_delete AFTER DELETE ON ${table}
        BEGIN ${this.refreshSql('OLD.run_id')} END;
      `);
    }
  }
  /**
   * 触发器复用的投影更新语句；通知版本仅在可通知的状态转换时变化，普通文本更新不重复通知。
   * EN: Builds projection updates shared by triggers; notification revisions change only for notifiable transitions, not ordinary text updates.
   */
  private refreshSql(runId: string) {
    /**
     * 即使执行 upsert 也分配 seq，使观察游标可跨进程重启继续。
     * EN: seq is allocated even on upsert, so observations can continue across process restarts.
     */
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
  /**
   * 合并同时发生的预热请求并在完成/失败后清除相同承诺，让后续读取可继续补齐。
   * EN: Coalesces concurrent warm requests and clears the same promise after settlement so later reads can continue warming.
   */
  private async warm() {
    if (this.warming) return this.warming;
    const pending = this.warmCurrent();
    this.warming = pending;
    try {
      await pending;
    } finally {
      if (this.warming === pending) this.warming = undefined;
    }
  }
  /**
   * 先补齐旧 hold 分类，再根据独立完成标记决定是否需要全面预热，避免把旧版本部分工作视为完成。
   * EN: Warms legacy hold classification first, then checks independent completion markers before full warming so old partial builds are not mistaken for complete.
   */
  private async warmCurrent() {
    await this.warmExecutionHolds();
    if (
      (
        this.store.db.prepare("SELECT value FROM storage_meta WHERE key='task-center-warm:v1'").get() as {
          value: string;
        }
      ).value !== '1' &&
      this.store.db.prepare("SELECT value FROM storage_meta WHERE key='task-center-complete:v2'").get()
    )
      return;
    await this.warmBatches();
  }
  /**
   * 按持久 ID 游标分批重算 hold 运行分类，每批提交进度并让出事件循环；新插入/解除由触发器覆盖。
   * EN: Reclassifies held runs in persistent-ID batches, committing resumable progress and yielding between batches while triggers cover concurrent hold changes.
   */
  private async warmExecutionHolds() {
    const key = 'task-center-holds:v1';
    let after =
      (
        this.store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(key) as
          | { value: string }
          | undefined
      )?.value ?? '';
    if (after === 'complete') return;
    /**
     * 旧缓存行可能早于支持 hold 的分类；仅对 hold 运行分批重建并支持续扫，触发器覆盖并发插入和解除。
     * EN: Existing cached rows may predate hold-aware classification. Rebuild only held runs in bounded, resumable batches; triggers cover concurrent inserts/releases.
     */
    for (;;) {
      const rows = this.store.db
        .prepare('SELECT run_id FROM execution_holds_v1 WHERE run_id>? ORDER BY run_id LIMIT 32')
        .all(after) as { run_id: string }[];
      this.store.tx(() => {
        for (const row of rows) this.store.db.prepare(this.refreshSql('?')).run(row.run_id);
        after = rows.at(-1)?.run_id ?? 'complete';
        this.store.db.prepare('INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)').run(key, after);
      });
      if (after === 'complete') return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  /**
   * 分批补齐所有必要旧投影及分类，并在原子写完成标记前再次检查全表缺口；兼容旧写入者在让出期间修改前面批次的情况。
   * EN: Batch-warms required legacy projections/classifications and rechecks all gaps before atomically marking completion, covering old writers changing earlier tables during yields.
   */
  private async warmBatches() {
    /**
     * 旧构建在首批前已清除此标记；独立的完成 标记使部分重建可恢复，而不用每次读取都全量扫描。
     * EN: Older builds cleared this marker before their first batch. A separate completion marker makes their partial rebuilds recoverable, without scanning on every read.
     */
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
      /**
       * 旧版写入者可能在后续批次让出执行权时修改前面的表。 原子标记构建完成之前，必须再检查所有投影。
       * EN: A legacy writer can change an earlier table while a later batch yields. Check all projections once more before atomically marking this build complete.
       */
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
  /**
   * 仅裁剪超过保留量的删除墓碑并推进单调保留下限，旧游标随后必须全量重建。
   * EN: Prunes excess deletion tombstones and advances the monotonic retention floor so older cursors require full rebuild.
   */
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
  /**
   * 将投影映射为公开项；不可读分类不附带推测的复核状态，通知也须仍与当前分类一致。
   * EN: Maps projections to public items; unreadable categories get no inferred review state, and notifications must still match current classification.
   */
  private item(
    row: Row,
    details?: { executionHold: TaskCenterItem['executionHold']; review?: DeliveryReviewSummary },
  ): TaskCenterItem {
    const unavailable = row.category === 'unavailable';
    const executionHold = details ? details.executionHold : this.store.getExecutionHold(row.run_id);
    const review = unavailable ? undefined : details ? details.review : this.delivery.cached(row.run_id);
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
      ...(executionHold ? { executionHold } : {}),
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
  /**
   * 在当前读取事务内批读本页附加信息；已读但缺失的值不退回单项查询，损坏分类不推测复核状态。
   * EN: Batches page metadata within the current read transaction; known absences never fall back to single reads, and unavailable categories receive no inferred review state.
   */
  private items(rows: Row[]): TaskCenterItem[] {
    const holds = this.store.getExecutionHolds(rows.map((row) => row.run_id));
    const reviews = this.delivery.cachedMany(
      rows.filter((row) => row.category !== 'unavailable').map((row) => row.run_id),
    );
    return rows.map((row) =>
      this.item(row, { executionHold: holds.get(row.run_id), review: reviews.get(row.run_id) }),
    );
  }
  /**
   * 在预热/可选重试后按过滤条件分页，复核读取与列表组装共享一致性边界。 coverage 单独计入归属不明的损坏记录，不因它们无法匹配标题/项目就把结果声称完整。
   * EN: Pages after warm/optional retry with review reads and assembly sharing a consistency boundary. Coverage includes damaged records with unknown ownership instead of claiming completeness when title/project matching is impossible.
   */
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
      /**
       * 可证明的范围排除仍准确执行；损坏运行正文也可能隐藏 项目和标题，因此归属不确定的记录仍保留在覆盖率警告中。
       * EN: Known scope exclusions remain exact. A broken Run body may also hide its project/title, so those uncertain memberships stay in the coverage warning.
       */
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
      /**
       * 新增 kind 筛选不能使用其他范围的游标；未提供 kind 的旧调用方 保持原游标语义。
       * EN: New kind-filtered callers must not use another scope's cursor. Legacy callers retain their original cursor semantics when no kind is supplied.
       */
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
        items: this.items(selected),
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
  /**
   * 仅依据当前状态核验一项排队通知，不展开其运行正文。
   * EN: Verify one queued notification against current state without expanding its Run.
   */
  async itemById(runId: string): Promise<{ item: TaskCenterItem | null }> {
    await this.warm();
    return this.delivery.read(() => {
      const row = this.store.db
        .prepare('SELECT * FROM task_center_changes_v1 WHERE run_id=? AND deleted=0 AND archived=0')
        .get(runId) as Row | undefined;
      return { item: row ? this.item(row) : null };
    }, runId);
  }
  /**
   * 读取持久单调序号后的当前变更及删除墓碑；游标早于保留下限或晚于当前序号时要求全量重建。 首次调用只建立 baseline，不把既有历史误报为刚发生的通知。
   * EN: Reads current changes and deletion tombstones after a persistent monotonic sequence. Cursors outside retention/current bounds require a rebuild; the first call establishes a baseline without reporting old history as fresh notifications.
   */
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
      const items = new Map(
        this.items(selected.filter((row) => !row.deleted && !row.archived)).map((item) => [item.id, item]),
      );
      return {
        items: selected.map((row) => ({
          id: row.run_id,
          changeRevision: row.seq,
          item: row.deleted || row.archived ? null : items.get(row.run_id)!,
        })),
        cursor: hasMore ? selected.at(-1)!.seq : latest,
        hasMore,
      };
    });
  }
}
/**
 * 注册任务中心查询接口，并校验筛选和分页参数。
 * EN: Registers task-center queries and validates filters and pagination.
 */
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
