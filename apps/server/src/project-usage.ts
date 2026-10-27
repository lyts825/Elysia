/**
 * 汇总项目使用量并注册查询接口。
 * 对完整项目请求账本统计并维护派生 epoch/快照，批次可取消且隔离坏记录；预留量不冒充实测，币种和未知费用分别保留。
 * EN: Aggregates project usage and registers read endpoints. Aggregates complete project ledgers with derived epochs/snapshots, cancellable batches and damage isolation; reservations are not observations and currencies/unknown costs remain separate.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, Status, type Project, type RequestRecord } from '../../../packages/contracts/src/index.js';
import type {
  ProjectUsageConnection,
  ProjectUsageRun,
  ProjectUsageSummary,
  ProjectUsageTotals,
} from '../../../packages/contracts/src/project-usage.js';
import { hash, id, type Store } from '../../../packages/storage/src/index.js';
import { projectionReads } from '../../../packages/storage/src/projection-reads.js';
import { ProjectUsageCache, usageSnapshotPage, type UsageSnapshot } from './project-usage-cache.js';

type Ledger = {
  id: string;
  revision: number;
  runId: string;
  providerId: string;
  status: RequestRecord['status'];
  account?: string;
  priceCurrency?: string;
  providerKind?: string;
  authMode?: string;
  model?: string;
  providerLabel?: string;
  usage: { inputTotal: number | null; outputTotal: number | null; cost: number | null } | null;
};
const metric = z.number().finite().nonnegative().nullable();
const ledgerSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  runId: z.string(),
  providerId: z.string().min(1),
  status: z.enum(['RESERVED', 'SETTLED', 'UNKNOWN', 'RELEASED']),
  account: z.string().optional(),
  priceCurrency: z.string().optional(),
  providerKind: z.string().optional(),
  authMode: z.string().optional(),
  model: z.string().optional(),
  providerLabel: z.string().optional(),
  usage: z.object({ inputTotal: metric, outputTotal: metric, cost: metric }).nullable(),
});
/**
 * 生成兼容新旧投影的项目归属 SQL，损坏 JSON 返回 NULL；别名由内部查询固定提供。
 * EN: Builds project-ownership SQL across new/legacy projections with NULL for invalid JSON; aliases are internal only.
 */
const scope = (alias = 'r') =>
  `CASE WHEN json_valid(${alias}.data) THEN COALESCE(json_extract(${alias}.data,'$.readModel.projectId'),json_extract(${alias}.data,'$.projectId')) END`;
/**
 * 生成归属可证明性的 SQL，区分明确无项目与损坏/缺失 UUID，防止 unknown 被排除为无关记录。
 * EN: Builds SQL distinguishing explicit no-project from damaged/missing UUID ownership so unknown rows are not excluded as unrelated.
 */
const scopeKnown = (alias = 'r') => `CASE WHEN json_valid(${alias}.data) THEN
  CASE WHEN ${scope(alias)} IS NULL THEN
    json_type(${alias}.data,'$.readModel.projectId') IS 'null' OR json_type(${alias}.data,'$.projectId') IS 'null'
  ELSE typeof(${scope(alias)})='text' AND length(${scope(alias)})=36
    AND substr(${scope(alias)},9,1)='-' AND substr(${scope(alias)},14,1)='-'
    AND substr(${scope(alias)},19,1)='-' AND substr(${scope(alias)},24,1)='-'
    AND length(replace(${scope(alias)},'-',''))=32
    AND lower(replace(${scope(alias)},'-','')) NOT GLOB '*[^0-9a-f]*' END ELSE 0 END`;
/**
 * 将后续批次让到事件循环下一轮，使统计期间取消和其他请求有机会运行。
 * EN: Yields subsequent batches to the next event-loop turn for cancellation and other requests.
 */
const yieldRead = () => new Promise<void>((resolve) => setImmediate(resolve));
/**
 * 创建独立的零计数汇总，完整性默认 true，再由每条请求按未知/不可读状态降级。
 * EN: Creates fresh zeroed totals with completeness initially true, degraded by unknown/unreadable requests.
 */
const newTotals = (): ProjectUsageTotals => ({
  requestCount: 0,
  readableCount: 0,
  unavailableCount: 0,
  statuses: { reserved: 0, settled: 0, unknown: 0, released: 0 },
  inputTokens: 0,
  outputTokens: 0,
  tokenUnknownCount: 0,
  tokenComplete: true,
  costs: [],
  costUnknownCount: 0,
  costComplete: true,
});
/**
 * 叠加一条请求的可读/状态/token/费用分类。缺失或非SETTLED的用量保持不完整标记， 已知费用按冻结币种分开累计；不能用预留量冒充实测，也不能把不同币种直接相加。
 * EN: Adds one request's readability, state, token and cost categories. Missing or unsettled usage stays incomplete; known costs accumulate by frozen currency, never replacing observations with reservations or mixing currencies.
 */
function add(totals: ProjectUsageTotals, row?: Ledger) {
  totals.requestCount++;
  if (!row) {
    totals.unavailableCount++;
    totals.tokenUnknownCount++;
    totals.costUnknownCount++;
    totals.tokenComplete = totals.costComplete = false;
    return;
  }
  totals.readableCount++;
  totals.statuses[
    { RESERVED: 'reserved', SETTLED: 'settled', UNKNOWN: 'unknown', RELEASED: 'released' }[
      row.status
    ] as keyof ProjectUsageTotals['statuses']
  ]++;
  totals.inputTokens += row.usage?.inputTotal ?? 0;
  totals.outputTokens += row.usage?.outputTotal ?? 0;
  if (row.usage?.inputTotal == null || row.usage.outputTotal == null || row.status !== 'SETTLED') {
    totals.tokenUnknownCount++;
    totals.tokenComplete = false;
  }
  if (
    row.status === 'SETTLED' &&
    row.usage?.cost != null &&
    ['USD', 'CNY'].includes(row.priceCurrency ?? '')
  ) {
    const currency = row.priceCurrency as 'USD' | 'CNY';
    let fee = totals.costs.find((value) => value.currency === currency);
    if (!fee) {
      fee = { currency, amount: 0, requestCount: 0 };
      totals.costs.push(fee);
    }
    fee.amount += row.usage.cost;
    fee.requestCount++;
  } else {
    totals.costUnknownCount++;
    totals.costComplete = false;
  }
  if (
    !Number.isFinite(totals.inputTokens + totals.outputTokens) ||
    totals.costs.some((fee) => !Number.isFinite(fee.amount))
  )
    throw new AppError(
      'PROJECT_USAGE_METRIC_LIMIT',
      '统计数值超出支持范围，请检查请求记录后刷新',
      false,
      null,
      422,
    );
}
type RunRow = { id: string; position: number; data: string };

/**
 * 项目账务为只读；允许预热旧版派生元数据，但不修改请求正文。 读取和缓存项目用量汇总，服务关闭时释放缓存和关闭钩子。
 * EN: Read-only project accounting; derived legacy metadata may warm without modifying request bodies. Reads and caches project usage and releases its cache and close hook when the service closes.
 */
export class ProjectUsageReads {
  private identity = id();
  private projections;
  private cache = new ProjectUsageCache();
  private closed = false;
  private removeCloseHook: () => void;
  /**
   * 建立账本失效索引、项目/归属 epoch 及触发器，绑定隔离投影读取器和关闭钩子；元数据更新用于缓存一致性，不修改请求正文。
   * EN: Creates ledger dirty indexes, project/ownership epochs and triggers, binding isolated projection reads and close cleanup. Derived metadata protects cache consistency without editing request bodies.
   */
  constructor(private store: Store) {
    this.projections = projectionReads(store);
    /**
     * 同版本原始记录修复后，不得继续使用旧的冻结账本。
     * EN: Same-revision raw repairs must not continue using an old frozen ledger.
     */
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_usage_dirty_v1(record_id TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS project_usage_request_insert AFTER INSERT ON requests
      WHEN CASE WHEN json_valid(NEW.data) THEN COALESCE(json_extract(NEW.data,'$.requestLedgerVersion'),0)<>2 ELSE 1 END
      BEGIN INSERT OR IGNORE INTO project_usage_dirty_v1 VALUES(NEW.id); END;
      DROP TRIGGER IF EXISTS project_usage_request_update;
      CREATE TRIGGER project_usage_request_update AFTER UPDATE ON requests
      BEGIN DELETE FROM project_usage_dirty_v1 WHERE record_id=NEW.id;
        INSERT OR IGNORE INTO project_usage_dirty_v1 SELECT NEW.id WHERE
        (NEW.content IS NOT OLD.content AND (NEW.data IS OLD.data OR NEW.revision IS OLD.revision)) OR
        CASE WHEN json_valid(NEW.data) THEN COALESCE(json_extract(NEW.data,'$.requestLedgerVersion'),0)<>2
          OR json_extract(NEW.data,'$.revision') IS NOT NEW.revision ELSE 1 END;
      END;
      CREATE TRIGGER IF NOT EXISTS project_usage_request_delete AFTER DELETE ON requests
      BEGIN DELETE FROM project_usage_dirty_v1 WHERE record_id=OLD.id; END;
      INSERT OR IGNORE INTO project_usage_dirty_v1
        SELECT id FROM requests WHERE CASE WHEN json_valid(data) THEN COALESCE(json_extract(data,'$.requestLedgerVersion'),0)<>2 ELSE 1 END;`);
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS project_usage_epochs_v1(project_id TEXT PRIMARY KEY,token TEXT NOT NULL);
      INSERT OR IGNORE INTO project_usage_epochs_v1 SELECT id,lower(hex(randomblob(16))) FROM projects;
      INSERT OR IGNORE INTO project_usage_epochs_v1 VALUES('__membership__',lower(hex(randomblob(16))));`);
    /**
     * 生成项目 epoch 更新 SQL，仅对非空项目分配随机令牌，供数据库触发器使用。
     * EN: Builds project epoch SQL assigning random tokens only for nonnull project IDs in triggers.
     */
    const touch = (project: string) => `INSERT INTO project_usage_epochs_v1(project_id,token)
      SELECT ${project},lower(hex(randomblob(16))) WHERE ${project} IS NOT NULL
      ON CONFLICT(project_id) DO UPDATE SET token=excluded.token;`;
    /**
     * 由请求 run_id 查询所属项目的内部 SQL 表达式，避免从请求正文推测项目。
     * EN: Builds internal SQL resolving project via request run_id rather than inferring it from request bodies.
     */
    const requestProject = (alias: string) => `(SELECT ${scope()} FROM runs r WHERE r.id=${alias}.run_id)`;
    /**
     * 从有效 JSON 取轻量请求账本，损坏数据返回 NULL 触发后续保守处理。
     * EN: Extracts compact ledgers from valid JSON and returns NULL for damage to trigger conservative handling.
     */
    const ledgerValue = (alias: string) => `CASE WHEN json_valid(${alias}.data)
      THEN json_extract(${alias}.data,'$.requestLedger') END`;
    /**
     * 生成与用量列表相关的最小运行投影 SQL，含归属可靠性，不展开合同或历史正文。
     * EN: Builds minimal run projection SQL for usage including ownership reliability without contracts/history bodies.
     */
    const runValue = (alias: string) => `CASE WHEN json_valid(${alias}.data) THEN json_object(
      'projectId',${scope(alias)},
      'title',COALESCE(json_extract(${alias}.data,'$.readModel.title'),json_extract(${alias}.data,'$.title')),
      'status',COALESCE(json_extract(${alias}.data,'$.readModel.status'),json_extract(${alias}.data,'$.status')),
      'archived',COALESCE(json_extract(${alias}.data,'$.readModel.archived'),json_extract(${alias}.data,'$.archived')),
      'scopeKnown',${scopeKnown(alias)}) END`;
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const aliases = operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW'];
      store.db.exec(`DROP TRIGGER IF EXISTS project_usage_epoch_request_${operation.toLowerCase()};
        DROP TRIGGER IF EXISTS project_usage_epoch_run_${operation.toLowerCase()};
        CREATE TRIGGER project_usage_epoch_request_${operation.toLowerCase()}
        AFTER ${operation} ON requests
        ${
          operation === 'UPDATE'
            ? `WHEN NEW.run_id IS NOT OLD.run_id OR ${ledgerValue('NEW')} IS NOT ${ledgerValue('OLD')}
          OR (NEW.content IS NOT OLD.content AND (NEW.data IS OLD.data OR NEW.revision IS OLD.revision))
          OR CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data,'$.revision') IS NOT NEW.revision
            OR json_extract(NEW.data,'$.requestLedgerVersion') IS NOT json_extract(OLD.data,'$.requestLedgerVersion') ELSE 1 END`
            : ''
        }
        BEGIN ${aliases.map((alias) => touch(requestProject(alias))).join('\n')} END;
        CREATE TRIGGER project_usage_epoch_run_${operation.toLowerCase()}
        AFTER ${operation} ON runs ${operation === 'UPDATE' ? `WHEN ${runValue('NEW')} IS NOT ${runValue('OLD')}` : ''}
        BEGIN ${aliases.map((alias) => touch(scope(alias))).join('\n')}
        ${
          operation === 'UPDATE'
            ? `UPDATE project_usage_epochs_v1 SET token=lower(hex(randomblob(16))) WHERE project_id='__membership__'
              AND (${scopeKnown('NEW')} IS NOT ${scopeKnown('OLD')});`
            : `UPDATE project_usage_epochs_v1 SET token=lower(hex(randomblob(16))) WHERE project_id='__membership__'
                AND NOT (${scopeKnown(aliases[0])});`
        }
        END;`);
      /**
       * 把不可读请求索引关联回项目，供损坏状态变化推进正确的项目 epoch。
       * EN: Links unreadable request issues back to their project so damage changes advance the correct epoch.
       */
      const issueProject = (alias: string) =>
        `(SELECT ${scope()} FROM requests q JOIN runs r ON r.id=q.run_id WHERE q.id=${alias}.record_id)`;
      store.db.exec(`DROP TRIGGER IF EXISTS project_usage_epoch_issue_${operation.toLowerCase()};
        CREATE TRIGGER project_usage_epoch_issue_${operation.toLowerCase()} AFTER ${operation} ON projection_read_issues_v1
        BEGIN ${aliases
          .map(
            (alias) => `INSERT INTO project_usage_epochs_v1(project_id,token)
          SELECT ${issueProject(alias)},lower(hex(randomblob(16))) WHERE ${alias}.table_name='requests' AND ${issueProject(alias)} IS NOT NULL
          ON CONFLICT(project_id) DO UPDATE SET token=excluded.token;`,
          )
          .join('\n')} END;`);
    }
    this.removeCloseHook = store.onClose(() => this.close());
  }
  /**
   * 标记读取器关闭、清空快照并移除 Store 关闭钩子，后续读取明确失败。
   * EN: Marks the reader closed, clears snapshots and removes Store close hooks so future reads fail explicitly.
   */
  close() {
    this.closed = true;
    this.cache.clear();
    this.removeCloseHook();
  }
  /**
   * 在读取批次检查请求取消和服务关闭，后者返回可重试 503。
   * EN: Checks request cancellation and service lifetime at read boundaries, returning retryable 503 when closed.
   */
  private checkOpen(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new AppError('PROJECT_USAGE_CLOSED', '用量读取服务已关闭', true, null, 503);
  }
  /**
   * 实例身份、项目数据epoch和全局归属epoch共同组成快照版本，使旧游标不能跨更新复用。
   * EN: Combines instance identity, project epoch and global ownership epoch into the snapshot version so cursors cannot cross updates.
   */
  private version(projectId: string) {
    const rows = this.store.db
      .prepare(
        "SELECT project_id,token FROM project_usage_epochs_v1 WHERE project_id IN (?, '__membership__') ORDER BY project_id",
      )
      .all(projectId);
    return hash(`${this.identity}:${JSON.stringify(rows)}`);
  }
  /**
   * 按rowid分批重建缺少或失效的请求账本投影；每条仍由ProjectionReads隔离坏记录。 外层已有事务时使用保存点而非提交调用方事务，批次间让出事件循环并检查取消。
   * EN: Rebuilds missing or stale ledger projections in rowid batches with per-record isolation. Uses savepoints inside caller transactions, yields between batches and observes cancellation.
   */
  private async warm(projectId: string, signal?: AbortSignal) {
    let after = 0;
    for (;;) {
      this.checkOpen(signal);
      const rows = this.store.db
        .prepare(
          `SELECT q.id,q.rowid position FROM requests q JOIN runs r ON r.id=q.run_id
        WHERE ${scope()}=? AND q.rowid>? AND NOT EXISTS(SELECT 1 FROM projection_read_issues_v1 p WHERE p.table_name='requests' AND p.record_id=q.id)
        AND (EXISTS(SELECT 1 FROM project_usage_dirty_v1 d WHERE d.record_id=q.id)
          OR CASE WHEN json_valid(q.data) THEN COALESCE(json_extract(q.data,'$.requestLedgerVersion'),0)<>2 ELSE 1 END)
        ORDER BY q.rowid LIMIT 32`,
        )
        .all(projectId, after) as { id: string; position: number }[];
      if (!rows.length) return;
      /**
       * 对当前有界批次逐条强制重建请求投影，每条前及批次末检查取消；隔离坏记录由投影读取器负责。
       * EN: Force-rebuilds each request projection in the bounded batch with cancellation checks; projection reads isolate damaged rows.
       */
      const backfill = () => {
        for (const row of rows) {
          this.checkOpen(signal);
          this.projections.read('requests', row.id, true);
        }
        this.checkOpen(signal);
      };
      /**
       * 每个短批次独立提交，每条记录仍有隔离失败的保存点。 即使某批失败，调用方拥有的 SQLite 事务也必须保持打开。
       * EN: Commit one short batch while each record retains its own failure-isolating savepoint. A caller-owned SQLite transaction must remain open, including on a failed batch.
       */
      if (this.store.db.isTransaction) {
        this.store.db.exec('SAVEPOINT project_usage_warm_batch');
        try {
          backfill();
          this.store.db.exec('RELEASE project_usage_warm_batch');
        } catch (error) {
          this.store.db.exec('ROLLBACK TO project_usage_warm_batch; RELEASE project_usage_warm_batch');
          throw error;
        }
      } else {
        this.store.tx(backfill);
      }
      after = rows.at(-1)!.position;
      await yieldRead();
    }
  }
  /**
   * 对完整项目账本生成一致快照后再分页运行；页大小不会缩小总量的统计范围。 expectedVersion 固定翻页基线，聚合期间epoch变化最多重试三轮，持续变化明确返回冲突。
   * EN: Builds a consistent complete ledger snapshot before paging runs, so page size cannot narrow totals. expectedVersion fixes the baseline; epoch changes retry at most three times before a conflict.
   */
  async summary(
    projectId: string,
    query: { before?: string; expectedVersion?: string } = {},
    signal?: AbortSignal,
  ): Promise<ProjectUsageSummary> {
    this.checkOpen(signal);
    this.store.require<Project>('projects', projectId);
    /**
     * 调用方事务中的临时视图不读写全局缓存，防止回滚后把未提交数据留作正式统计。
     * EN: A caller transaction's provisional view bypasses global cache to avoid retaining rolled-back data as committed statistics.
     */
    const transaction = this.store.db.isTransaction;
    if (!transaction) {
      const version = this.version(projectId);
      if (query.expectedVersion && query.expectedVersion !== version)
        throw new AppError('PROJECT_USAGE_CHANGED', '项目用量已变化，请刷新后重新翻页', false, null, 409);
      const cached = this.cache.get(projectId, version);
      if (cached) {
        const response = usageSnapshotPage(cached, query.before);
        if (!response)
          throw new AppError(
            'PROJECT_USAGE_CURSOR_MISSING',
            '任务位置已失效，请刷新项目用量',
            false,
            null,
            409,
          );
        /**
         * 独立 SQLite 写入连接可能在读取代际与复制分页之间提交。
         * EN: A separate SQLite writer can commit between generation lookup and page cloning.
         */
        if (this.version(projectId) === version) return response;
      }
    }
    await this.warm(projectId, signal);
    for (let attempt = 0; attempt < 3; attempt++) {
      this.checkOpen(signal);
      const version = this.version(projectId);
      if (query.expectedVersion && query.expectedVersion !== version)
        throw new AppError('PROJECT_USAGE_CHANGED', '项目用量已变化，请刷新后重新翻页', false, null, 409);
      const runRows = this.store.db
        .prepare(`SELECT r.id,r.rowid position,r.data FROM runs r WHERE ${scope()}=? ORDER BY r.rowid DESC`)
        .all(projectId) as RunRow[];
      const unassignedRunCount = Number(
        (
          this.store.db.prepare(`SELECT COUNT(*) n FROM runs r WHERE NOT (${scopeKnown()})`).get() as {
            n: number;
          }
        ).n,
      );
      const runTotals = new Map<string, ProjectUsageRun>();
      for (const row of runRows) {
        let value: any;
        try {
          const data = JSON.parse(row.data);
          value = data.readModel ?? data;
        } catch {
          value = {};
        }
        runTotals.set(row.id, {
          ...newTotals(),
          runId: row.id,
          title: typeof value.title === 'string' ? value.title : '任务信息无法读取',
          status: Status.safeParse(value.status).success ? value.status : null,
          archived: value.archived === true,
        });
      }
      const totals = newTotals(),
        connections = new Map<string, ProjectUsageConnection>();
      let after = 0,
        changed = false;
      requestPages: for (;;) {
        this.checkOpen(signal);
        if (this.version(projectId) !== version) {
          changed = true;
          break;
        }
        const rows = this.store.db
          .prepare(
            `SELECT q.id,q.revision,q.run_id,q.rowid position,q.data,
          EXISTS(SELECT 1 FROM projection_read_issues_v1 p WHERE p.table_name='requests' AND p.record_id=q.id) failed,
          EXISTS(SELECT 1 FROM project_usage_dirty_v1 d WHERE d.record_id=q.id) dirty
          FROM requests q JOIN runs r ON r.id=q.run_id WHERE ${scope()}=? AND q.rowid>? ORDER BY q.rowid LIMIT 200`,
          )
          .all(projectId, after) as {
          id: string;
          revision: number;
          run_id: string;
          position: number;
          data: string;
          failed: number;
          dirty: number;
        }[];
        if (!rows.length) break;
        for (const item of rows) {
          const run = runTotals.get(item.run_id);
          if (!run) {
            changed = true;
            break requestPages;
          }
          /**
           * 只消费版本和所属关系可核对的轻量账本，其余仍计入请求数并标记不可读/未知。
           * EN: Consumes only ledgers with verifiable revision and ownership; other requests remain counted and marked unreadable or unknown.
           */
          let row: Ledger | undefined;
          try {
            const data = JSON.parse(item.data);
            if (!item.failed && !item.dirty && data.requestLedgerVersion === 2) {
              const parsed = ledgerSchema.parse(data.requestLedger);
              /**
               * 流式追加会推进公开行版本，但不改变其账本数值。
               * EN: Streaming appends advance the public row revision without changing its ledger values.
               */
              if (
                parsed.id === item.id &&
                parsed.runId === item.run_id &&
                parsed.revision <= item.revision &&
                data.revision === item.revision
              )
                row = { ...parsed, revision: item.revision };
            }
          } catch {}
          add(totals, row);
          add(run, row);
          const auth = row?.authMode;
          const source =
            auth === 'apiKey'
              ? 'api'
              : ['codex', 'chatgpt'].includes(auth ?? '')
                ? 'subscription'
                : 'unknown';
          const key = JSON.stringify([
            row?.providerId ?? '',
            row?.providerKind ?? null,
            auth ?? null,
            row?.model ?? null,
            row?.account ?? null,
            row?.providerLabel ?? null,
          ]);
          let connection = connections.get(key);
          if (!connection) {
            connection = {
              ...newTotals(),
              providerId: row?.providerId ?? '',
              label: row?.providerLabel || row?.providerId || '连接信息未知',
              model: row?.model ?? null,
              account: row?.account ?? null,
              providerKind: row?.providerKind ?? null,
              source,
            };
            connections.set(key, connection);
          }
          add(connection, row);
          after = item.position;
        }
        await yieldRead();
      }
      if (changed || this.version(projectId) !== version) {
        await this.warm(projectId, signal);
        continue;
      }
      /**
       * 全局损坏运行可能属于本项目；归属无法证明时揭示缺口，不声称总量完整。
       * EN: A damaged global run may belong to this project; unverifiable ownership exposes a coverage gap instead of claiming complete totals.
       */
      if (unassignedRunCount) totals.tokenComplete = totals.costComplete = false;
      const summary = {
        projectId,
        generatedAt: new Date().toISOString(),
        version,
        runCount: runRows.length,
        unassignedRunCount,
        readCoverage: {
          complete: totals.unavailableCount === 0 && unassignedRunCount === 0,
          unavailable: totals.unavailableCount,
        },
        totals,
        connections: [...connections.values()].sort(
          (a, b) => a.label.localeCompare(b.label) || (a.model ?? '').localeCompare(b.model ?? ''),
        ),
      };
      const snapshot: UsageSnapshot = {
        summary,
        runs: runRows.map((row) => ({ position: row.position, value: runTotals.get(row.id)! })),
      };
      const response = usageSnapshotPage(snapshot, query.before);
      if (!response)
        throw new AppError(
          'PROJECT_USAGE_CURSOR_MISSING',
          '任务位置已失效，请刷新项目用量',
          false,
          null,
          409,
        );
      if (!transaction && !this.store.db.isTransaction && this.version(projectId) === version)
        this.cache.put(projectId, snapshot);
      return response;
    }
    throw new AppError('PROJECT_USAGE_CHANGED', '项目用量持续变化，请稍后刷新', true, null, 409);
  }
}
/**
 * 将请求中断和未写完响应的断连绑定到统计取消，并提供移除监听器的收尾函数。
 * EN: Binds aborted requests and prematurely closed responses to accounting cancellation and returns listener cleanup.
 */
function readSignal(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  /**
   * 中止当前用量统计 HTTP 请求的读取信号。
   * EN: Aborts the read signal for this usage HTTP request.
   */
  const abort = () => controller.abort();
  /**
   * 响应提前关闭才取消统计，正常完成的响应不触发中止。
   * EN: Cancels accounting only on premature response closure, not normal completion.
   */
  const close = () => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once('aborted', abort);
  reply.raw.once('close', close);
  return {
    signal: controller.signal,
    /**
     * 移除用量请求的中断/关闭监听器，结束后不再持有控制器。
     * EN: Removes usage request abort/close listeners after completion.
     */
    detach: () => {
      request.raw.off('aborted', abort);
      reply.raw.off('close', close);
    },
  };
}
/**
 * 注册项目用量查询，并在服务关闭时释放读取器。
 * EN: Registers usage queries and disposes the reader on server close.
 */
export function registerProjectUsage(app: FastifyInstance, store: Store) {
  const reads = new ProjectUsageReads(store);
  app.addHook('onClose', () => reads.close());
  app.get<{ Params: { id: string } }>('/api/projects/:id/usage', async (request, reply) => {
    const query = z
      .object({
        before: z.string().uuid().optional(),
        expectedVersion: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(request.query);
    const cancellation = readSignal(request, reply);
    reply.header('Cache-Control', 'no-store');
    try {
      return await reads.summary(request.params.id, query, cancellation.signal);
    } finally {
      cancellation.detach();
    }
  });
}
