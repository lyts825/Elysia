/**
 * 读取运行记录、任务和相关数据并注册接口。
 * 提供列表、详情、历史及执行检查的小投影，按需展开旧记录；分页范围、完整统计和坏记录覆盖明确区分，缺必要资料则禁止执行写入。
 * EN: Reads runs, tasks and related projections and registers endpoints. Provides compact list/detail/history/execution projections with lazy legacy reads, explicit page/totals/damage scope and execution-write rejection on missing prerequisites.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  type Run,
  type Operation,
  type RequestRecord,
  type Artifact,
  type Message,
  type Task,
} from '../../../packages/contracts/src/index.js';
import type {
  RecordPage,
  RunUsageSummary,
  RunListItem,
  RunDetailCoverage,
} from '../../../packages/contracts/src/run-reads.js';
import type { MessageSearchPage } from '../../../packages/contracts/src/task-center.js';
import { readCurrentQuestions } from '../../../packages/storage/src/current-questions.js';
import { readDetailEvents } from '../../../packages/storage/src/detail-events.js';
import {
  REASONING_DISPLAY_MAX_CHARS,
  REASONING_PAGE_MAX_CHARS,
} from '../../../packages/contracts/src/reasoning.js';
import { hash, type Store, type ConversationMessageLinks } from '../../../packages/storage/src/index.js';
import {
  projectionIssue,
  projectionReads,
  type ProjectionReads,
} from '../../../packages/storage/src/projection-reads.js';

type Table = 'runs' | 'requests' | 'tool_operations';
type Metadata = { id: string; revision: number; rowid: number; value: any };
const tableNames = { requests: 'requests', operations: 'tool_operations', artifacts: 'artifacts' } as const;
const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(40),
    before: z.string().uuid().optional(),
  })
  .strict();
/**
 * 构造侧栏运行小投影，目标正文截到 240 字符，终端只暴露执行类型而不展开冻结连接。
 * EN: Builds a compact sidebar run, clipping objective to 240 characters and exposing terminal execution kind without frozen connection details.
 */
function sidebarRun(run: Run): RunListItem {
  return {
    id: run.id,
    revision: run.revision,
    title: run.title,
    objective: run.objective.slice(0, 240),
    createdAt: run.createdAt,
    kind: run.kind,
    projectId: run.projectId,
    rootTaskId: run.rootTaskId,
    status: run.status,
    reason: run.reason,
    archived: run.archived,
    ...(run.execution?.kind === 'docker-agent' ? { execution: { kind: 'docker-agent' } } : {}),
  };
}
/**
 * 按深度、字符串、数组和对象字段数裁剪详情预览；返回派生值，不修改原记录或声称预览完整。
 * EN: Clips preview depth, strings, arrays and object fields, returning derived data without mutating records or claiming completeness.
 */
function clipped(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 2048 ? value.slice(0, 2048) + '…' : value;
  if (!value || typeof value !== 'object') return value;
  if (depth >= 4) return '[详情按需读取]';
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => clipped(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 24)
      .map(([key, item]) => [key, clipped(item, depth + 1)]),
  );
}
/**
 * 裁剪操作结果中的大集合，生成适合详情预览的操作记录。
 * EN: Trims large operation-result collections for detail previews.
 */
export function briefOperation(operation: Operation): Operation {
  const result =
    operation.result && typeof operation.result === 'object' && !Array.isArray(operation.result)
      ? {
          ...operation.result,
          ...(Array.isArray((operation.result as any).entries)
            ? { entriesTotal: (operation.result as any).entries.length }
            : {}),
          ...(Array.isArray((operation.result as any).matches)
            ? { matchesTotal: (operation.result as any).matches.length }
            : {}),
        }
      : operation.result;
  return {
    ...operation,
    args: clipped(operation.args),
    result: clipped(result),
    detailsOmitted: true,
  } as Operation;
}
/**
 * 返回省略大 manifest 的请求视图，保留在途 partialText、上下文状态和有界差异并显式 detailsOmitted。
 * EN: Returns requests with large manifests omitted, retaining active partialText, context state and bounded difference with explicit detailsOmitted.
 */
function briefRequest(request: RequestRecord): RequestRecord {
  return {
    ...request,
    manifest: {
      ...(request.status === 'RESERVED' ? { partialText: request.manifest.partialText } : {}),
      contextRuntime: request.manifest.contextRuntime,
      difference: clipped(request.manifest.difference),
    },
    detailsOmitted: true,
  } as RequestRecord;
}
/**
 * 读取小型 SQL 投影；旧记录只预热一次，不重复展开业务正文。 聚合运行、任务、请求和操作的只读投影，并报告不可读记录。
 * EN: Reads small SQL projections; legacy rows warm once without expanding business bodies again. Aggregates read-only run/task/request/operation projections and reports unreadable records.
 */
export class RunReads {
  private projections: ProjectionReads;
  /**
   * 绑定存储与按记录隔离失败的投影读取器，后续读取共享损坏覆盖率。
   * EN: Binds Store and failure-isolating projection reads, sharing unreadable-record coverage across later operations.
   */
  constructor(private store: Store) {
    this.projections = projectionReads(store);
  }
  /**
   * 读取运行任务集合并保留投影读取器的坏记录隔离语义。
   * EN: Reads run tasks through projection readers with damaged-row isolation.
   */
  tasks(runId: string) {
    return this.projections.collection<Task>('tasks', runId);
  }
  /**
   * 委托存储详情事件入口返回有界运行事件预览，不扫描完整历史。
   * EN: Delegates to bounded detail-event preview rather than scanning full history.
   */
  eventPreview(runId: string) {
    return readDetailEvents(this.store, runId);
  }
  /**
   * 推理展示缓存失败只标记 readUnavailable，不让非权威缓存故障隐藏整个请求。
   * EN: Reasoning cache failures mark readUnavailable without hiding the entire request because the cache is non-authoritative.
   */
  requestPreview(request: RequestRecord) {
    try {
      const reasoning = this.store.requestReasoningMetadata(request.id);
      return { ...request, ...(reasoning ? { reasoning } : {}) };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'REASONING_UNAVAILABLE') throw error;
      const completed =
        request.status === 'SETTLED' &&
        Boolean(
          this.store.db
            .prepare(
              `SELECT 1 FROM messages
        WHERE run_id=? AND json_extract(data,'$.role')='assistant'
        AND json_extract(data,'$.conversationLinks.requestId')=? LIMIT 1`,
            )
            .get(request.runId, request.id),
        );
      return {
        ...request,
        reasoning: {
          kind: 'reasoning_content' as const,
          status:
            request.status === 'RESERVED'
              ? ('streaming' as const)
              : completed
                ? ('complete' as const)
                : ('interrupted' as const),
          characters: 0,
          truncated: false,
          readUnavailable: true as const,
        },
      };
    }
  }
  /**
   * 同时传入不可读任务 ID，使“当前没有问题”和“问题无法读取”在界面中可区分。
   * EN: Includes unreadable task IDs to distinguish no current question from an unreadable question.
   */
  currentQuestions(run: Run, tasks: readonly Task[]) {
    const unavailable = this.store.db
      .prepare("SELECT record_id FROM projection_read_issues_v1 WHERE table_name='tasks' AND run_id=?")
      .all(run.id) as { record_id: string }[];
    return readCurrentQuestions(
      this.store,
      run,
      tasks,
      unavailable.map((row) => row.record_id),
    );
  }
  /**
   * 汇集执行守卫所需完整任务、请求和操作集合；各类不可读记录由共享投影覆盖率记录。
   * EN: Collects full task/request/operation sets required by execution guards, tracking unreadable rows through shared projection coverage.
   */
  executionRecords(runId: string) {
    return {
      tasks: this.tasks(runId),
      requests: this.projections.collection<RequestRecord>('requests', runId),
      operations: this.projections.collection<Operation>('tool_operations', runId),
    };
  }
  /**
   * 标注详情各分区的读取范围和覆盖率，选中的一页不能被描述为全部请求/操作。
   * EN: Annotates partition scope and coverage so a selected page is never presented as all requests or operations.
   */
  detailCoverage(runId: string, scope: 'all' | 'selected'): RunDetailCoverage {
    /**
     * 为一个详情分区组合真实总量、坏记录覆盖率及 all/selected 范围标记，避免分页误报完整。
     * EN: Combines partition totals, unreadable coverage and all/selected scope so pages cannot be misreported complete.
     */
    const section = (table: 'tasks' | 'requests' | 'tool_operations', selectedScope: 'all' | 'selected') => ({
      ...this.projections.coverage(table, runId),
      total: this.count(table, runId),
      scope: selectedScope,
    });
    return {
      tasks: section('tasks', 'all'),
      requests: section('requests', scope),
      operations: section('tool_operations', scope),
    };
  }
  /**
   * 检查该运行任一投影是否存在读取缺口，不展开新正文。
   * EN: Checks whether the run's existing projection coverage has any gaps without expanding new bodies.
   */
  hasUnavailable(runId: string) {
    return !this.projections.coverage(undefined, runId).complete;
  }
  /**
   * 返回当前运行的共享可读覆盖率，供 HTTP 响应解释局部结果。
   * EN: Returns shared run readability coverage for HTTP explanations of partial results.
   */
  readCoverage(runId: string) {
    return this.projections.coverage(undefined, runId);
  }
  /**
   * 触发指定运行的投影重试，实际隔离与可取消预热由投影读取器实现。
   * EN: Triggers projection retry for one run through the projection reader's isolation/warming mechanism.
   */
  retry(runId: string) {
    return this.projections.retry(runId);
  }
  /**
   * 修改执行状态前强制读取必要记录；任一不可读使入口保持只读，防止基于残缺状态继续执行。
   * EN: Requires readable prerequisite records before execution mutations; any unreadable input keeps the entry read-only.
   */
  assertExecutionReadable(runId: string) {
    this.executionRecords(runId);
    if (this.hasUnavailable(runId))
      throw new AppError(
        projectionIssue.code,
        '部分执行记录暂时无法读取，当前仅供查看。修复后请重试读取。',
        true,
        null,
        422,
      );
  }
  /**
   * 按稳定 rowid 顺序对指定集合的 ID/版本生成摘要，检测列表读取期间集合变化而不加载正文。
   * EN: Hashes collection IDs/revisions in rowid order to detect changes without loading bodies.
   */
  private recordVersion(table: 'requests' | 'tool_operations' | 'artifacts', runId: string) {
    const rows = this.store.db
      .prepare(`SELECT id,revision FROM ${table} WHERE run_id=? ORDER BY rowid`)
      .all(runId);
    return hash(JSON.stringify(rows));
  }
  /**
   * 同步补齐指定表/运行的旧版小投影，避免后续元数据查询反复展开正文。
   * EN: Synchronously warms legacy compact projections for a table/run to avoid repeated body expansion in metadata queries.
   */
  private warmReadModels(table: Table, runId?: string) {
    this.projections.warmSync(table, runId);
  }
  /**
   * 先补齐旧投影，再读取可用记录的小元数据；缺少投影时按类型从权威记录派生必要字段，坏记录跳过并保留覆盖率。
   * EN: Warms old projections then reads compact metadata from available rows, deriving required fields from authoritative records when needed and retaining coverage for skipped damage.
   */
  private metadata(table: Table, runId?: string): Metadata[] {
    this.warmReadModels(table, runId);
    const rows = this.store.db
      .prepare(
        `SELECT id,revision,rowid,json_extract(data,'$.readModel') model FROM ${table} WHERE ${this.projections.available(table)}${runId ? ' AND run_id=?' : ''} ORDER BY rowid DESC`,
      )
      .all(...(runId ? [runId] : [])) as {
      id: string;
      revision: number;
      rowid: number;
      model: string | null;
    }[];
    return rows.flatMap((row) => {
      const { model, ...identity } = row;
      if (model) return [{ ...identity, value: JSON.parse(model) }];
      const entity = this.projections.read<any>(table, row.id);
      if (!entity) return [];
      const value =
        table === 'runs'
          ? sidebarRun(entity)
          : table === 'tool_operations'
            ? {
                taskId: entity.taskId,
                toolCallId: entity.toolCallId,
                name: entity.name,
                status: entity.status,
              }
            : {
                taskId: entity.taskId,
                status: entity.status,
                providerId: entity.providerId,
                usage: entity.usage
                  ? {
                      inputTotal: entity.usage.inputTotal,
                      outputTotal: entity.usage.outputTotal,
                      cost: entity.usage.cost,
                      cacheRead: entity.usage.cacheRead,
                      ttftMs: entity.usage.ttftMs,
                    }
                  : null,
              };
      this.store.refreshReadProjection(table, entity);
      return [{ ...identity, value }];
    });
  }
  /**
   * 用量独立汇总完整请求集合，不受当前对话分页影响。缺失成本/缓存观测保留 unknown， 不可读记录使 costKnown=false，避免将局部统计呈现为完整账单。
   * EN: Aggregates usage across all requests independently of conversation pages. Missing costs/cache observations stay unknown; unreadable rows clear costKnown so partial statistics are not presented as a full bill.
   */
  usage(runId: string): RunUsageSummary {
    const rows = this.metadata('requests', runId);
    const readCoverage = this.projections.coverage('requests', runId);
    const settled = rows.filter((r) => r.value.status === 'SETTLED');
    const provider = new Map<
      string,
      { input: number; cache: number; cacheKnown: boolean; ttft: number; count: number }
    >();
    let totalTokens = 0,
      cost = 0;
    for (const { value: row } of rows) {
      const usage = row.usage;
      totalTokens += (usage?.inputTotal ?? 0) + (usage?.outputTotal ?? 0);
      if (row.status === 'SETTLED') cost += usage?.cost ?? 0;
      if (!usage) continue;
      const data = provider.get(row.providerId) ?? {
        input: 0,
        cache: 0,
        cacheKnown: true,
        ttft: 0,
        count: 0,
      };
      data.input += usage.inputTotal ?? 0;
      data.cache += usage.cacheRead ?? 0;
      data.cacheKnown &&= typeof usage.cacheRead === 'number';
      if (typeof usage.ttftMs === 'number') {
        data.ttft += usage.ttftMs;
        data.count++;
      }
      provider.set(row.providerId, data);
    }
    return {
      requestCount: this.count('requests', runId),
      readCoverage,
      settledCount: settled.length,
      unknownCount: rows.filter((r) => r.value.status === 'UNKNOWN').length,
      totalTokens,
      cost,
      costKnown:
        readCoverage.complete &&
        settled.length > 0 &&
        settled.every((r) => typeof r.value.usage?.cost === 'number'),
      providers: [...provider].map(([providerId, data]) => ({
        providerId,
        input: data.input,
        cacheRead: data.cacheKnown ? data.cache : null,
        ttftMs: data.count ? data.ttft / data.count : null,
      })),
    };
  }
  /**
   * 按当前消息关联补入请求/操作，并始终保留最近记录及在途/不确定记录。 deferred 首屏暂缓完整统计，但返回明确标记；列表被裁剪不代表历史已被删除。
   * EN: Adds requests/operations linked to visible messages and retains recent, active and uncertain records. Deferred first pages explicitly postpone totals; trimmed lists do not imply deleted history.
   */
  conversation(run: Run, messages: ConversationMessageLinks[], deferred = false) {
    const requestIds = new Set(messages.flatMap((message) => (message.requestId ? [message.requestId] : [])));
    const calls = new Set(
      messages.flatMap((message) => [
        ...(message.calls ?? []).map((call) => call.id),
        ...(message.callId ? [message.callId] : []),
      ]),
    );
    /**
     * 为当前对话页选择关联、最近和在途/未知记录；仅未知旧状态/调用标识需展开，避免首屏读取整个历史正文。
     * EN: Selects linked, recent and active/unknown records for the conversation page, expanding only unknown legacy state/call identity to keep first-page reads lazy.
     */
    const select = (table: 'requests' | 'tool_operations', linked: Set<string>, statuses: string[]) => {
      /**
       * 只有旧记录的状态或调用标识未知时，才需要展开正文以安全筛选。 已有可用状态的旧投影不会迫使首个消息页读取所有正文。
       * EN: Only unknown legacy state or call identity needs expansion for safe filtering. Old projections with usable state do not make the first message page read every body.
       */
      const unknown = this.store.db
        .prepare(
          `SELECT id FROM ${table} WHERE run_id=? AND (COALESCE(json_extract(data,'$.readModel.status'),json_extract(data,'$.status')) IS NULL${table === 'tool_operations' && linked.size ? " OR COALESCE(json_extract(data,'$.readModel.toolCallId'),json_extract(data,'$.toolCallId')) IS NULL" : ''})`,
        )
        .all(run.id) as { id: string }[];
      for (const row of unknown) this.projections.read(table, row.id, true);
      const match =
        table === 'requests'
          ? 'id'
          : "COALESCE(json_extract(data,'$.readModel.toolCallId'),json_extract(data,'$.toolCallId'))";
      return this.store.db
        .prepare(
          `SELECT id FROM ${table} WHERE run_id=? AND ${this.projections.available(table)} AND (rowid IN (SELECT rowid FROM ${table} WHERE run_id=? ORDER BY rowid DESC LIMIT 30) OR ${match} IN (SELECT value FROM json_each(?)) OR COALESCE(json_extract(data,'$.readModel.status'),json_extract(data,'$.status')) IN (SELECT value FROM json_each(?))) ORDER BY rowid DESC`,
        )
        .all(run.id, run.id, JSON.stringify([...linked]), JSON.stringify(statuses)) as { id: string }[];
    };
    const selectedRequests = select('requests', requestIds, ['RESERVED']);
    const retainedReasoning = this.store.db
      .prepare(
        `SELECT s.request_id id FROM reasoning_streams_v1 s
      WHERE s.run_id=? AND s.complete=0 AND s.characters>0
      AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.run_id=s.run_id
        AND json_extract(m.data,'$.role')='assistant'
        AND json_extract(m.data,'$.conversationLinks.requestId')=s.request_id)
      ORDER BY s.rowid DESC LIMIT 12`,
      )
      .all(run.id) as { id: string }[];
    const selectedIds = new Set(selectedRequests.map((row) => row.id));
    for (const row of retainedReasoning)
      if (!selectedIds.has(row.id)) {
        selectedRequests.push(row);
        selectedIds.add(row.id);
      }
    const selectedOperations = select('tool_operations', calls, ['INTENT', 'UNCERTAIN']);
    const artifacts = this.store.entityPage<Artifact>('artifacts', 60, undefined, run.id);
    const requests = selectedRequests.flatMap((row) => {
      const value = this.projections.read<RequestRecord>('requests', row.id);
      return value ? [this.requestPreview(briefRequest(value))] : [];
    });
    const operations = selectedOperations.flatMap((row) => {
      const value = this.projections.read<Operation>('tool_operations', row.id);
      return value ? [briefOperation(value)] : [];
    });
    /**
     * 用量统计可能发现可见对话页以外更早的损坏请求。
     * EN: Usage may discover a damaged older request outside the visible conversation page.
     */
    const usageSummary = deferred ? undefined : this.usage(run.id);
    return {
      requests,
      operations,
      readCoverage: this.projections.coverage(undefined, run.id),
      artifacts: artifacts.items.reverse(),
      snapshots: [],
      decisions: [],
      recordsLimited: true,
      ...(deferred
        ? { summaryDeferred: true as const }
        : {
            usageSummary: usageSummary!,
            recordCounts: {
              requests: this.count('requests', run.id),
              operations: this.count('tool_operations', run.id),
              artifacts: artifacts.page.total,
            },
            recordVersions: {
              requests: this.recordVersion('requests', run.id),
              operations: this.recordVersion('tool_operations', run.id),
              artifacts: this.recordVersion('artifacts', run.id),
            },
          }),
    };
  }
  /**
   * 计算指定白名单表的全量或运行内行数，包括不可读行，确保覆盖率分母不因坏记录缩水。
   * EN: Counts rows in an allowlisted table/run including unreadable rows so coverage denominators do not shrink with damage.
   */
  private count(table: Table | 'tasks', runId?: string) {
    return Number(
      (
        this.store.db
          .prepare(`SELECT COUNT(*) n FROM ${table}${runId ? ' WHERE run_id=?' : ''}`)
          .get(...(runId ? [runId] : [])) as { n: number }
      ).n,
    );
  }
  /**
   * 按游标、搜索和归档条件读取运行小投影，保留指定/固定条目；按需要异步预热旧记录并补足坏记录造成的页空缺，检查取消并报告覆盖率。
   * EN: Reads compact run pages by cursor/search/archive with retained/pinned entries, warming legacy rows when needed and refilling gaps from unreadable rows while reporting coverage and cancellation.
   */
  async list(
    query: {
      limit: number;
      before?: string;
      query?: string;
      includeRunId?: string;
      pinned?: string[];
      retained?: string[];
      archived?: boolean;
      summary?: 'deferred';
      retryProjections?: 'true' | 'false';
    },
    signal?: AbortSignal,
  ) {
    if (query.retryProjections === 'true') await this.projections.retry();
    /**
     * 延迟首屏保持惰性；完整摘要和搜索使用可让出执行权的旧记录预热。
     * EN: Keep the deferred first page lazy; full summaries/search perform the yielding legacy warm.
     */
    if (
      query.summary !== 'deferred' ||
      query.archived !== undefined ||
      query.query?.trim() ||
      query.retryProjections === 'true'
    )
      await this.projections.warm('runs');
    const cursor = query.before
      ? (this.store.db.prepare('SELECT rowid position FROM runs WHERE id=?').get(query.before) as
          | { position: number }
          | undefined)
      : undefined;
    if (query.before && !cursor)
      throw new AppError('RECORD_CURSOR_MISSING', '会话位置已失效，请重新读取列表', false, null, 409);
    const search = query.query?.trim().toLocaleLowerCase();
    const result = search
      ? await this.store.historySearch(
          'run',
          {
            search,
            limit: query.limit,
            before: query.before,
            archived: query.archived,
            included: [
              query.includeRunId,
              ...(query.pinned ?? []).slice(0, 40),
              ...(query.retained ?? []).slice(0, 300),
            ].filter((value): value is string => Boolean(value)),
          },
          signal,
        )
      : undefined;
    const conditions: string[] = [this.projections.available('runs')];
    const parameters: (string | number)[] = [];
    if (query.archived !== undefined) {
      conditions.push(
        "COALESCE(json_extract(data,'$.readModel.archived'),json_extract(data,'$.archived'),0)=?",
      );
      parameters.push(query.archived ? 1 : 0);
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const pageConditions = [...conditions, ...(cursor ? ['rowid<?'] : [])];
    const included = new Set(
      [
        query.includeRunId,
        ...(query.pinned ?? []).slice(0, 40),
        ...(query.retained ?? []).slice(0, 300),
      ].filter(Boolean),
    );
    /**
     * 复用本批候选随行读取的小投影，搜索候选仍按 ID 读取。旧行回填可能触发其他投影更新，
     * 此后本批剩余行重新读取；补页让出执行权后也会重新查询，不跨批复用快照。
     * EN: Reuses compact projections fetched with this batch; search candidates still read by ID.
     * Legacy hydration may trigger other projection changes, so remaining rows are reread afterward.
     * Refill queries also fetch fresh projections after yielding; snapshots never cross batches.
     */
    type ListRow = { id: string; model?: string | null };
    const read = (rows: ListRow[]): RunListItem[] => {
      let refreshed = false;
      return rows.flatMap((row) => {
        if (this.projections.has('runs', row.id)) return [];
        const projection =
          !refreshed && row.model !== undefined
            ? row
            : (this.store.db
                .prepare("SELECT json_extract(data,'$.readModel') model FROM runs WHERE id=?")
                .get(row.id) as { model: string | null });
        let value: RunListItem;
        if (!projection) return [];
        if (projection.model) value = JSON.parse(projection.model) as RunListItem;
        else {
          refreshed = true;
          const run = this.projections.read<Run>('runs', row.id);
          if (!run) return [];
          this.store.refreshReadProjection('runs', run);
          value = sidebarRun(run);
        }
        return [
          search
            ? {
                ...value,
                matchesQuery: result!.ids.includes(row.id) || result!.matchedIncluded.includes(row.id),
              }
            : value,
        ];
      });
    };
    let selected: ListRow[], runs: RunListItem[];
    for (;;) {
      signal?.throwIfAborted();
      selected = result
        ? result.ids.map((id) => ({ id }))
        : (this.store.db
            .prepare(
              `SELECT id,json_extract(data,'$.readModel') model FROM runs WHERE ${pageConditions.join(' AND ')} ORDER BY rowid DESC LIMIT ?`,
            )
            .all(...parameters, ...(cursor ? [cursor.position] : []), query.limit + 1) as ListRow[]);
      runs = read(selected);
      if (runs.length === selected.length || result) break;
      /**
       * 隔离不可读行后补足有界分页，避免返回具有误导性的空页。
       * EN: Refill the bounded page after isolating unreadable rows; never return a misleading empty page.
       */
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const hasMore = result?.hasMore ?? selected.length > query.limit;
    selected.splice(query.limit);
    runs.splice(query.limit);
    for (const row of selected) included.delete(row.id);
    const extra = this.store.db
      .prepare(
        `SELECT id,json_extract(data,'$.readModel') model FROM runs WHERE id IN (SELECT value FROM json_each(?)) AND ${this.projections.available('runs')} ORDER BY rowid DESC`,
      )
      .all(JSON.stringify([...included])) as ListRow[];
    const includedRuns = read(extra);
    const total =
      result?.total ??
      Number(
        (this.store.db.prepare(`SELECT COUNT(*) n FROM runs${where}`).get(...parameters) as { n: number }).n,
      );
    const page: RecordPage = {
      total,
      limit: query.limit,
      before: query.before ?? null,
      hasMore,
      nextBefore: hasMore ? (selected.at(-1)?.id ?? null) : null,
    };
    const projectCounts: Record<string, number> = {};
    if (query.summary !== 'deferred') {
      const counts = this.store.db
        .prepare(
          `SELECT COALESCE(json_extract(data,'$.readModel.projectId'),json_extract(data,'$.projectId')) projectId,COUNT(*) n FROM runs WHERE ${this.projections.available('runs')} GROUP BY COALESCE(json_extract(data,'$.readModel.projectId'),json_extract(data,'$.projectId'))`,
        )
        .all() as { projectId: string | null; n: number }[];
      for (const row of counts) if (row.projectId) projectCounts[row.projectId] = Number(row.n);
    }
    return {
      runs,
      included: includedRuns,
      readCoverage: this.projections.coverage('runs'),
      unavailableIds: [...included].filter(
        (key): key is string => typeof key === 'string' && this.projections.has('runs', key),
      ),
      page,
      ...(query.summary === 'deferred' ? { summaryDeferred: true as const } : { projectCounts }),
    };
  }
}
/**
 * 注册运行记录、推理分页及历史查询接口，先验证父运行与游标归属；读取错误保留可诊断的不可用结果。
 * EN: Registers run-record/reasoning/history routes, validating parent/cursor ownership first and preserving diagnosable unavailable results.
 */
export function registerRunRecordRoutes(app: FastifyInstance, store: Store) {
  const projections = projectionReads(store);
  for (const collection of ['messages', 'requests'] as const) {
    app.get<{ Params: { id: string; recordId: string } }>(
      `/api/runs/:id/${collection}/:recordId/reasoning`,
      async (request) => {
        projections.require<Run>('runs', request.params.id);
        const query = z
          .object({
            offset: z.coerce.number().int().min(0).max(REASONING_DISPLAY_MAX_CHARS).default(0),
            limit: z.coerce.number().int().min(1).max(REASONING_PAGE_MAX_CHARS).default(8192),
          })
          .strict()
          .parse(request.query);
        try {
          return collection === 'messages'
            ? store.messageReasoningPage(
                request.params.id,
                request.params.recordId,
                query.offset,
                query.limit,
              )
            : store.requestReasoningPage(
                request.params.id,
                request.params.recordId,
                query.offset,
                query.limit,
              );
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            'REASONING_UNAVAILABLE',
            '思考文本暂时无法读取，原始记录已保留。',
            true,
            null,
            422,
          );
        }
      },
    );
  }
  /**
   * 为历史查询绑定请求中断与提前响应关闭的取消信号，关闭时移除请求监听。
   * EN: Binds history-read cancellation to request abort/premature response close, removing request listeners at close.
   */
  const requestSignal = (request: FastifyRequest, reply: FastifyReply) => {
    const controller = new AbortController(),
      /**
       * 中止当前历史读取控制器，停止后续批次。
       * EN: Aborts the current history reader before subsequent batches.
       */
      abort = () => controller.abort();
    request.raw.once('aborted', abort);
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abort();
      request.raw.removeListener('aborted', abort);
    });
    if (request.raw.aborted) abort();
    return controller.signal;
  };
  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/messages/search',
    async (request, reply): Promise<MessageSearchPage> => {
      /**
       * 索引查询前先验证父运行；不得接受其他运行的消息游标。
       * EN: Validate the parent before any indexed query; another Run's message cursor is never accepted.
       */
      projections.require<Run>('runs', request.params.id);
      const query = z
        .object({
          query: z.string().trim().min(1).max(200),
          limit: z.coerce.number().int().min(1).max(40).default(20),
          before: z.string().uuid().optional(),
        })
        .strict()
        .parse(request.query);
      const search = query.query.toLocaleLowerCase();
      const result = await store.historySearch(
        'message',
        {
          search,
          limit: query.limit,
          before: query.before,
          runId: request.params.id,
        },
        requestSignal(request, reply),
      );
      const selected = result.ids;
      return {
        items: selected.map((key) => {
          const message = store.require<Message>('messages', key);
          const start = Math.max(0, message.text.toLocaleLowerCase().indexOf(search) - 48);
          return {
            messageId: message.id,
            revision: message.revision,
            role: message.role,
            snippet:
              (start ? '…' : '') +
              message.text.slice(start, start + 158) +
              (message.text.length > start + 158 ? '…' : ''),
          };
        }),
        page: {
          total: result.total,
          limit: query.limit,
          before: query.before ?? null,
          hasMore: result.hasMore,
          nextBefore: result.nextBefore,
        },
      };
    },
  );
  app.get<{ Params: { id: string; recordId: string } }>(
    '/api/runs/:id/records/artifacts/:recordId/log-context',
    (request) => {
      const run = store.require<Run>('runs', request.params.id);
      const artifact = store.require<Artifact>('artifacts', z.string().uuid().parse(request.params.recordId));
      if (artifact.runId !== run.id) throw new AppError('NOT_FOUND', '记录不属于当前会话', false, null, 404);
      if (!run.contract.permissionProfile.read) return null;
      const operation = store
        .all<Operation>('tool_operations', run.id)
        .find(
          (op) =>
            op.name === 'terminal_agent' &&
            op.taskId === artifact.taskId &&
            (op.result as { transcriptArtifactId?: string } | undefined)?.transcriptArtifactId ===
              artifact.id,
        );
      return operation ? { runId: run.id, taskId: artifact.taskId } : null;
    },
  );
  app.get<{ Params: { id: string } }>('/api/runs/:id/header', (request) =>
    projections.require<Run>('runs', request.params.id),
  );
  app.get<{ Params: { id: string; kind: keyof typeof tableNames } }>(
    '/api/runs/:id/records/:kind',
    (request) => {
      projections.require<Run>('runs', request.params.id);
      const table = tableNames[z.enum(['requests', 'operations', 'artifacts']).parse(request.params.kind)];
      const query = pageQuery.parse(request.query);
      if (table !== 'artifacts') {
        projections.warmSync(table, request.params.id);
        const cursor = query.before
          ? (store.db
              .prepare(`SELECT rowid position FROM ${table} WHERE id=? AND run_id=?`)
              .get(query.before, request.params.id) as { position: number } | undefined)
          : undefined;
        if (query.before && !cursor)
          throw new AppError('RECORD_CURSOR_MISSING', '记录位置已失效，请返回首页', false, null, 409);
        const rows = store.db
          .prepare(
            `SELECT id FROM ${table} WHERE run_id=? AND ${projections.available(table)}${cursor ? ' AND rowid<?' : ''} ORDER BY rowid DESC LIMIT ?`,
          )
          .all(request.params.id, ...(cursor ? [cursor.position] : []), query.limit + 1) as { id: string }[];
        const hasMore = rows.length > query.limit,
          selected = rows.slice(0, query.limit);
        return {
          items: selected.flatMap(({ id }) => {
            const row = projections.read<any>(table, id);
            return row ? [table === 'requests' ? briefRequest(row) : briefOperation(row)] : [];
          }),
          page: {
            total: Number(
              (
                store.db
                  .prepare(
                    `SELECT COUNT(*) n FROM ${table} WHERE run_id=? AND ${projections.available(table)}`,
                  )
                  .get(request.params.id) as { n: number }
              ).n,
            ),
            limit: query.limit,
            before: query.before ?? null,
            hasMore,
            nextBefore: hasMore ? selected.at(-1)!.id : null,
          },
          readCoverage: projections.coverage(table, request.params.id),
        };
      }
      const result = store.entityPage<any>(table, query.limit, query.before, request.params.id);
      return {
        items: result.items,
        page: result.page,
      };
    },
  );
  app.get<{ Params: { id: string; kind: keyof typeof tableNames; recordId: string } }>(
    '/api/runs/:id/records/:kind/:recordId',
    (request) => {
      projections.require<Run>('runs', request.params.id);
      const table = tableNames[z.enum(['requests', 'operations', 'artifacts']).parse(request.params.kind)];
      const key = z.string().uuid().parse(request.params.recordId);
      if (!store.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND run_id=?`).get(key, request.params.id))
        throw new AppError('NOT_FOUND', '记录不属于当前会话', false, null, 404);
      const row =
        table === 'artifacts' ? store.require<any>(table, key) : projections.require<any>(table, key);
      if (row.runId !== request.params.id)
        throw new AppError('NOT_FOUND', '记录不属于当前会话', false, null, 404);
      return row;
    },
  );
}
