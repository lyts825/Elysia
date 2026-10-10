import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  type Run,
  type Operation,
  type RequestRecord,
  type Artifact,
} from '../../../packages/contracts/src/index.js';
import type { RecordPage, RunUsageSummary, RunListItem } from '../../../packages/contracts/src/run-reads.js';
import { hash, type Store, type ConversationMessageLinks } from '../../../packages/storage/src/index.js';

type Table = 'runs' | 'requests' | 'tool_operations';
type Metadata = { id: string; revision: number; rowid: number; value: any };
const tableNames = { requests: 'requests', operations: 'tool_operations', artifacts: 'artifacts' } as const;
const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(40),
    before: z.string().uuid().optional(),
  })
  .strict();
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
/** Reads small SQL projections; legacy rows warm once without expanding business bodies again. */
export class RunReads {
  constructor(private store: Store) {}
  private recordVersion(table: 'requests' | 'tool_operations' | 'artifacts', runId: string) {
    const rows = this.store.db
      .prepare(`SELECT id,revision FROM ${table} WHERE run_id=? ORDER BY rowid`)
      .all(runId);
    return hash(JSON.stringify(rows));
  }
  private warmReadModels(table: Table, runId?: string) {
    const rows = this.store.db
      .prepare(
        `SELECT id FROM ${table} WHERE (json_extract(data,'$.readModelVersion') IS NOT 1 OR json_type(data,'$.readModel') IS NOT 'object')${runId ? ' AND run_id=?' : ''}`,
      )
      .all(...(runId ? [runId] : [])) as { id: string }[];
    for (const row of rows) this.store.refreshReadProjection(table, this.store.require<any>(table, row.id));
  }
  private metadata(table: Table, runId?: string): Metadata[] {
    this.warmReadModels(table, runId);
    const rows = this.store.db
      .prepare(
        `SELECT id,revision,rowid,json_extract(data,'$.readModel') model FROM ${table}${runId ? ' WHERE run_id=?' : ''} ORDER BY rowid DESC`,
      )
      .all(...(runId ? [runId] : [])) as {
      id: string;
      revision: number;
      rowid: number;
      model: string | null;
    }[];
    return rows.map((row) => {
      const { model, ...identity } = row;
      if (model) return { ...identity, value: JSON.parse(model) };
      const entity = this.store.require<any>(table, row.id);
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
      return { ...identity, value };
    });
  }
  usage(runId: string): RunUsageSummary {
    const rows = this.metadata('requests', runId);
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
      requestCount: rows.length,
      settledCount: settled.length,
      unknownCount: rows.filter((r) => r.value.status === 'UNKNOWN').length,
      totalTokens,
      cost,
      costKnown: settled.length > 0 && settled.every((r) => typeof r.value.usage?.cost === 'number'),
      providers: [...provider].map(([providerId, data]) => ({
        providerId,
        input: data.input,
        cacheRead: data.cacheKnown ? data.cache : null,
        ttftMs: data.count ? data.ttft / data.count : null,
      })),
    };
  }
  conversation(run: Run, messages: ConversationMessageLinks[], deferred = false) {
    const requestIds = new Set(messages.flatMap((message) => (message.requestId ? [message.requestId] : [])));
    const calls = new Set(
      messages.flatMap((message) => [
        ...(message.calls ?? []).map((call) => call.id),
        ...(message.callId ? [message.callId] : []),
      ]),
    );
    const select = (table: 'requests' | 'tool_operations', linked: Set<string>, statuses: string[]) => {
      // Only unknown legacy state or call identity needs expansion for safe filtering.
      // Old projections with usable state do not make the first message page read every body.
      const unknown = this.store.db
        .prepare(
          `SELECT id FROM ${table} WHERE run_id=? AND (COALESCE(json_extract(data,'$.readModel.status'),json_extract(data,'$.status')) IS NULL${table === 'tool_operations' && linked.size ? " OR COALESCE(json_extract(data,'$.readModel.toolCallId'),json_extract(data,'$.toolCallId')) IS NULL" : ''})`,
        )
        .all(run.id) as { id: string }[];
      for (const row of unknown)
        this.store.refreshReadProjection(table, this.store.require<any>(table, row.id));
      const match =
        table === 'requests'
          ? 'id'
          : "COALESCE(json_extract(data,'$.readModel.toolCallId'),json_extract(data,'$.toolCallId'))";
      return this.store.db
        .prepare(
          `SELECT id FROM ${table} WHERE run_id=? AND (rowid IN (SELECT rowid FROM ${table} WHERE run_id=? ORDER BY rowid DESC LIMIT 30) OR ${match} IN (SELECT value FROM json_each(?)) OR COALESCE(json_extract(data,'$.readModel.status'),json_extract(data,'$.status')) IN (SELECT value FROM json_each(?))) ORDER BY rowid DESC`,
        )
        .all(run.id, run.id, JSON.stringify([...linked]), JSON.stringify(statuses)) as { id: string }[];
    };
    const selectedRequests = select('requests', requestIds, ['RESERVED']);
    const selectedOperations = select('tool_operations', calls, ['INTENT', 'UNCERTAIN']);
    const artifacts = this.store.entityPage<Artifact>('artifacts', 60, undefined, run.id);
    return {
      requests: selectedRequests.map((row) =>
        briefRequest(this.store.require<RequestRecord>('requests', row.id)),
      ),
      operations: selectedOperations.map((row) =>
        briefOperation(this.store.require<Operation>('tool_operations', row.id)),
      ),
      artifacts: artifacts.items.reverse(),
      snapshots: [],
      decisions: [],
      recordsLimited: true,
      ...(deferred
        ? { summaryDeferred: true as const }
        : {
            usageSummary: this.usage(run.id),
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
  private count(table: Table, runId?: string) {
    return Number(
      (
        this.store.db
          .prepare(`SELECT COUNT(*) n FROM ${table}${runId ? ' WHERE run_id=?' : ''}`)
          .get(...(runId ? [runId] : [])) as { n: number }
      ).n,
    );
  }
  list(query: {
    limit: number;
    before?: string;
    query?: string;
    includeRunId?: string;
    pinned?: string[];
    retained?: string[];
    archived?: boolean;
    summary?: 'deferred';
  }) {
    const cursor = query.before
      ? (this.store.db.prepare('SELECT rowid position FROM runs WHERE id=?').get(query.before) as
          | { position: number }
          | undefined)
      : undefined;
    if (query.before && !cursor)
      throw new AppError('RECORD_CURSOR_MISSING', '会话位置已失效，请重新读取列表', false, null, 409);
    const search = query.query?.trim().toLocaleLowerCase();
    if (query.archived !== undefined || query.summary !== 'deferred') this.warmReadModels('runs');
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];
    let searchMatches: Set<string> | undefined;
    if (query.archived !== undefined) {
      conditions.push(
        "COALESCE(json_extract(data,'$.readModel.archived'),json_extract(data,'$.archived'),0)=?",
      );
      parameters.push(query.archived ? 1 : 0);
    }
    if (search) {
      // Explicit search keeps matching the full objective, including text beyond the sidebar excerpt.
      const matched = this.metadata('runs').filter(
        (row) =>
          `${row.value.title} ${row.value.objective}`.toLocaleLowerCase().includes(search) ||
          this.store.require<Run>('runs', row.id).objective.toLocaleLowerCase().includes(search),
      );
      searchMatches = new Set(matched.map((row) => row.id));
      conditions.push('id IN (SELECT value FROM json_each(?))');
      parameters.push(JSON.stringify(matched.map((row) => row.id)));
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = Number(
      (this.store.db.prepare(`SELECT COUNT(*) n FROM runs${where}`).get(...parameters) as { n: number }).n,
    );
    const pageConditions = [...conditions, ...(cursor ? ['rowid<?'] : [])];
    const selected = this.store.db
      .prepare(
        `SELECT id FROM runs${pageConditions.length ? ' WHERE ' + pageConditions.join(' AND ') : ''} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...parameters, ...(cursor ? [cursor.position] : []), query.limit + 1) as { id: string }[];
    const hasMore = selected.length > query.limit;
    selected.splice(query.limit);
    const included = new Set(
      [
        query.includeRunId,
        ...(query.pinned ?? []).slice(0, 40),
        ...(query.retained ?? []).slice(0, 300),
      ].filter(Boolean),
    );
    for (const row of selected) included.delete(row.id);
    const extra = this.store.db
      .prepare('SELECT id FROM runs WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC')
      .all(JSON.stringify([...included])) as { id: string }[];
    const read = (row: { id: string }): RunListItem => {
      const projection = this.store.db
        .prepare("SELECT json_extract(data,'$.readModel') model FROM runs WHERE id=?")
        .get(row.id) as { model: string | null };
      let value: RunListItem;
      if (projection.model) value = JSON.parse(projection.model) as RunListItem;
      else {
        const run = this.store.require<Run>('runs', row.id);
        this.store.refreshReadProjection('runs', run);
        value = sidebarRun(run);
      }
      return searchMatches ? { ...value, matchesQuery: searchMatches.has(row.id) } : value;
    };
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
          "SELECT COALESCE(json_extract(data,'$.readModel.projectId'),json_extract(data,'$.projectId')) projectId,COUNT(*) n FROM runs GROUP BY COALESCE(json_extract(data,'$.readModel.projectId'),json_extract(data,'$.projectId'))",
        )
        .all() as { projectId: string | null; n: number }[];
      for (const row of counts) if (row.projectId) projectCounts[row.projectId] = Number(row.n);
    }
    return {
      runs: selected.map(read),
      included: extra.map(read),
      page,
      ...(query.summary === 'deferred' ? { summaryDeferred: true as const } : { projectCounts }),
    };
  }
}
export function registerRunRecordRoutes(app: FastifyInstance, store: Store) {
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
    store.require<Run>('runs', request.params.id),
  );
  app.get<{ Params: { id: string; kind: keyof typeof tableNames } }>(
    '/api/runs/:id/records/:kind',
    (request) => {
      store.require<Run>('runs', request.params.id);
      const table = tableNames[z.enum(['requests', 'operations', 'artifacts']).parse(request.params.kind)];
      const query = pageQuery.parse(request.query);
      const result = store.entityPage<any>(table, query.limit, query.before, request.params.id);
      return {
        items: result.items.map((row) =>
          table === 'requests' ? briefRequest(row) : table === 'tool_operations' ? briefOperation(row) : row,
        ),
        page: result.page,
      };
    },
  );
  app.get<{ Params: { id: string; kind: keyof typeof tableNames; recordId: string } }>(
    '/api/runs/:id/records/:kind/:recordId',
    (request) => {
      store.require<Run>('runs', request.params.id);
      const table = tableNames[z.enum(['requests', 'operations', 'artifacts']).parse(request.params.kind)];
      const row = store.require<any>(table, z.string().uuid().parse(request.params.recordId));
      if (row.runId !== request.params.id)
        throw new AppError('NOT_FOUND', '记录不属于当前会话', false, null, 404);
      return row;
    },
  );
}
