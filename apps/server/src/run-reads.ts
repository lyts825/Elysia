import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  type Run,
  type Message,
  type Operation,
  type RequestRecord,
  type Artifact,
} from '../../../packages/contracts/src/index.js';
import type { RecordPage, RunUsageSummary, RunListItem } from '../../../packages/contracts/src/run-reads.js';
import { hash, type Store } from '../../../packages/storage/src/index.js';

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
  private metadata(table: Table, runId?: string): Metadata[] {
    const rows = this.store.db
      .prepare(
        `SELECT id,revision,rowid,data FROM ${table}${runId ? ' WHERE run_id=?' : ''} ORDER BY rowid DESC`,
      )
      .all(...(runId ? [runId] : [])) as { id: string; revision: number; rowid: number; data: string }[];
    return rows.map((row) => {
      const { data, ...identity } = row;
      const projected = JSON.parse(data);
      if (projected.readModelVersion === 1 && projected.readModel)
        return { ...identity, value: projected.readModel };
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
  conversation(run: Run, messages: Message[]) {
    const requests = this.metadata('requests', run.id),
      operations = this.metadata('tool_operations', run.id);
    const requestIds = new Set(messages.flatMap((message) => (message.requestId ? [message.requestId] : [])));
    const calls = new Set(
      messages.flatMap((message) => [
        ...(message.calls ?? []).map((call) => call.id),
        ...(message.callId ? [message.callId] : []),
      ]),
    );
    const selectedRequests = requests.filter(
      (row, index) => index < 30 || requestIds.has(row.id) || row.value.status === 'RESERVED',
    );
    const selectedOperations = operations.filter(
      (row, index) =>
        index < 30 || calls.has(row.value.toolCallId) || ['INTENT', 'UNCERTAIN'].includes(row.value.status),
    );
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
      usageSummary: this.usage(run.id),
      recordCounts: {
        requests: requests.length,
        operations: operations.length,
        artifacts: artifacts.page.total,
      },
      recordsLimited: true,
      recordVersions: {
        requests: this.recordVersion('requests', run.id),
        operations: this.recordVersion('tool_operations', run.id),
        artifacts: this.recordVersion('artifacts', run.id),
      },
    };
  }
  list(query: {
    limit: number;
    before?: string;
    query?: string;
    includeRunId?: string;
    pinned?: string[];
    archived?: boolean;
  }) {
    const all = this.metadata('runs');
    const cursor = query.before ? all.find((row) => row.id === query.before) : undefined;
    if (query.before && !cursor)
      throw new AppError('RECORD_CURSOR_MISSING', '会话位置已失效，请重新读取列表', false, null, 409);
    const search = query.query?.trim().toLocaleLowerCase();
    const matched = all.filter(
      (row) =>
        (query.archived === undefined || row.value.archived === query.archived) &&
        (!search ||
          `${row.value.title} ${row.value.objective}`.toLocaleLowerCase().includes(search) ||
          this.store.require<Run>('runs', row.id).objective.toLocaleLowerCase().includes(search)),
    );
    const candidates = matched.filter((row) => !cursor || row.rowid < cursor.rowid);
    const selected = candidates.slice(0, query.limit);
    const included = new Set([query.includeRunId, ...(query.pinned ?? []).slice(0, 40)].filter(Boolean));
    const extra = all.filter((row) => included.has(row.id) && !selected.some((item) => item.id === row.id));
    const page: RecordPage = {
      total: matched.length,
      limit: query.limit,
      before: query.before ?? null,
      hasMore: candidates.length > query.limit,
      nextBefore: candidates.length > query.limit ? (selected.at(-1)?.id ?? null) : null,
    };
    const projectCounts: Record<string, number> = {};
    for (const row of all)
      if (row.value.projectId)
        projectCounts[row.value.projectId] = (projectCounts[row.value.projectId] ?? 0) + 1;
    return {
      runs: selected.map((row) => row.value as RunListItem),
      included: extra.map((row) => row.value as RunListItem),
      page,
      projectCounts,
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
