import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  AppError,
  ContextRuntimeMetrics,
  type Entity,
  type Event,
  type Run,
  type Task,
  type Message,
  type RequestRecord,
} from '../../contracts/src/index.js';
import { SearchWork, searchCancelled } from './search-work.js';
import { REQUEST_STREAM_FORMAT, RequestStreams } from './request-stream.js';
import { projectionReads } from './projection-reads.js';
import { ExecutionRecovery, initializeExecutionRecovery } from './execution-recovery.js';
import { publishFileObject } from './file-objects.js';
import { ObjectReferenceProjection } from './object-reference-projection.js';
import {
  ArtifactDeliveryMetadataReads,
  serializeDeliveryArtifactMetadata,
} from './artifact-delivery-metadata.js';
export type ConversationMessageLinks = {
  requestId?: string;
  callId?: string;
  calls?: { id: string }[];
};
function conversationLinks(message: ConversationMessageLinks): ConversationMessageLinks {
  return {
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(message.callId ? { callId: message.callId } : {}),
    ...(message.calls?.length ? { calls: message.calls.map((call) => ({ id: call.id })) } : {}),
  };
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const STORAGE_SCHEMA_VERSION = 8;
export const STORAGE_MIN_READER_VERSION = '1.10.0';
export type RequestLedgerRow = Pick<
  RequestRecord,
  | 'id'
  | 'revision'
  | 'runId'
  | 'taskId'
  | 'attemptId'
  | 'logicalId'
  | 'providerId'
  | 'status'
  | 'startedAt'
  | 'reservedTokens'
  | 'reservedCost'
> & {
  account?: string;
  priceCurrency?: string;
  providerKind?: string;
  authMode?: string;
  model?: string;
  providerLabel?: string;
  usage: Pick<
    NonNullable<RequestRecord['usage']>,
    'inputTotal' | 'outputTotal' | 'cost' | 'cacheRead' | 'ttftMs'
  > | null;
};
function ledgerProjection(entity: RequestRecord): RequestLedgerRow {
  return {
    id: entity.id,
    revision: entity.revision,
    runId: entity.runId,
    taskId: entity.taskId,
    attemptId: entity.attemptId,
    logicalId: entity.logicalId,
    providerId: entity.providerId,
    status: entity.status,
    startedAt: entity.startedAt,
    reservedTokens: entity.reservedTokens,
    reservedCost: entity.reservedCost,
    account: entity.providerBinding?.account,
    priceCurrency: entity.providerBinding?.prices?.currency,
    providerKind: entity.providerBinding?.kind,
    authMode: entity.providerBinding ? (entity.providerBinding.authMode ?? 'apiKey') : undefined,
    model: entity.providerBinding?.model,
    providerLabel: entity.providerBinding?.label,
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
}
export function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function dataDirectory() {
  return path.resolve(
    process.env.ELYSIA_DATA_DIR ||
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Elysia'),
  );
}
export const tables = [
  'project_spaces',
  'projects',
  'providers',
  'runs',
  'tasks',
  'agents',
  'attempts',
  'messages',
  'snapshots',
  'artifacts',
  'requests',
  'tool_operations',
  'checkpoints',
  'decisions',
  'inbox',
] as const;
export type Table = (typeof tables)[number];
const unscopedTables = new Set<Table>(['project_spaces', 'projects', 'providers', 'runs']);
const legacyObjectPattern = /^objects[\\/][a-f0-9]{2}[\\/][a-f0-9]{64}$/;
const sqliteObjectPattern = /^sqlite:[a-f0-9]{64}$/;
const compress = (value: unknown) => gzipSync(Buffer.from(stable(value)), { level: 6 });
const expand = (value: Uint8Array) => JSON.parse(gunzipSync(value).toString('utf8'));
function rateResumeAt(task: Task) {
  const value =
    task.rateLimit === undefined
      ? (task.result as { resumeAt?: unknown } | undefined)?.resumeAt
      : task.rateLimit?.resumeAt;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function projection(table: Table, entity: any) {
  const readModel =
    table === 'runs'
      ? {
          id: entity.id,
          revision: entity.revision,
          title: entity.title,
          objective: entity.objective.slice(0, 240),
          kind: entity.kind,
          projectId: entity.projectId,
          rootTaskId: entity.rootTaskId,
          status: entity.status,
          reason: entity.reason,
          archived: entity.archived,
          createdAt: entity.createdAt,
          ...(entity.execution?.kind === 'docker-agent' ? { execution: { kind: 'docker-agent' } } : {}),
        }
      : table === 'tasks'
        ? {
            status: entity.status,
            waitReason: entity.waitReason,
            parentTaskId: entity.parentTaskId,
            waitingFor: entity.waitingFor,
            dependencyNeedsDecision:
              entity.waitReason === 'dependency_failed'
                ? entity.dependencyBlock?.causes.length !== 0
                : undefined,
            rateResumeAt: rateResumeAt(entity),
          }
        : table === 'tool_operations'
          ? { taskId: entity.taskId, toolCallId: entity.toolCallId, name: entity.name, status: entity.status }
          : table === 'requests'
            ? {
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
              }
            : undefined;
  return stable({
    id: entity.id,
    runId: entity.runId,
    revision: entity.revision,
    ...(['runs', 'tasks', 'requests', 'tool_operations', 'inbox'].includes(table)
      ? { status: entity.status }
      : {}),
    ...(table === 'tasks'
      ? {
          schedulerVersion: 1,
          deliverySemanticHash: hash(
            stable({
              id: entity.id,
              status: entity.status,
              deliverables: entity.spec?.deliverables,
              acceptanceCriteria: entity.spec?.acceptanceCriteria,
              result: entity.result ?? null,
            }),
          ),
        }
      : {}),
    ...(table === 'artifacts'
      ? {
          deliverySemanticHash: hash(serializeDeliveryArtifactMetadata(entity)),
        }
      : {}),
    ...(table === 'runs' ? { archived: entity.archived } : {}),
    ...(table === 'runs' ? { sourceRunId: entity.source?.runId } : {}),
    ...(table === 'runs'
      ? {
          deliveryProjectionVersion: 1,
          deliveryReview: entity.deliveryReview
            ? {
                decision: entity.deliveryReview.decision,
                fingerprint: entity.deliveryReview.fingerprint,
                reviewedAt: entity.deliveryReview.reviewedAt,
              }
            : null,
        }
      : {}),
    ...(table === 'requests'
      ? {
          requestLedgerVersion: 2,
          requestLedger: ledgerProjection(entity),
          partialStreamRef:
            typeof entity.manifest?.partialStreamRef === 'string' ? entity.manifest.partialStreamRef : null,
        }
      : {}),
    ...(table === 'attempts' ? { taskId: entity.taskId, status: entity.status } : {}),
    ...(table === 'messages'
      ? {
          sessionId: entity.sessionId,
          ordinal: entity.ordinal,
          conversationLinks: conversationLinks(entity),
        }
      : {}),
    ...(readModel ? { readModelVersion: 1, readModel } : {}),
  });
}
function objectRefs(value: unknown, refs = new Set<string>(), field = ''): Set<string> {
  if (
    typeof value === 'string' &&
    /Ref$/.test(field) &&
    (sqliteObjectPattern.test(value) || legacyObjectPattern.test(value))
  )
    refs.add(value);
  else if (Array.isArray(value)) for (const item of value) objectRefs(item, refs, field);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) objectRefs(item, refs, key);
  return refs;
}
function references(value: unknown, identifiers: Set<string>): boolean {
  if (typeof value === 'string') return identifiers.has(value);
  if (Array.isArray(value)) return value.some((item) => references(item, identifiers));
  return Boolean(
    value && typeof value === 'object' && Object.values(value).some((item) => references(item, identifiers)),
  );
}
export class Store {
  readonly recovery: ExecutionRecovery;
  db: DatabaseSync;
  directory: string;
  private depth = 0;
  private searchWork = new SearchWork();
  private requestStreams: RequestStreams;
  private artifactDeliveryReads: ArtifactDeliveryMetadataReads;
  private objectReferences?: ObjectReferenceProjection;
  private requestReadProjectionUpdate?: ReturnType<DatabaseSync['prepare']>;
  private closeHooks = new Set<() => void>();
  private closed = false;
  constructor(directory = dataDirectory()) {
    mkdirSync(directory, { recursive: true });
    this.directory = realpathSync(directory);
    for (const d of ['objects', 'workspaces', 'logs'])
      mkdirSync(path.join(this.directory, d), { recursive: true });
    this.db = new DatabaseSync(path.join(this.directory, 'state.db'));
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;',
    );
    try {
      this.migrate();
      this.artifactDeliveryReads = new ArtifactDeliveryMetadataReads(
        this.db,
        (key) => this.require('artifacts', key),
        (artifact) => this.refreshReadProjection('artifacts', artifact),
      );
      this.recovery = new ExecutionRecovery(this);
      this.requestStreams = new RequestStreams(this.db);
      this.objectReferences = new ObjectReferenceProjection(this.db, tables, expand, objectRefs);
      // Raw repairs invalidate the derived log pointer without rewriting request/usage projections.
      this.db.exec(`CREATE TABLE IF NOT EXISTS request_log_pointer_dirty_v1(
        record_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE);
        CREATE TRIGGER IF NOT EXISTS request_log_pointer_insert AFTER INSERT ON requests
        BEGIN INSERT INTO request_log_pointer_dirty_v1 SELECT NEW.id
          WHERE NOT EXISTS(SELECT 1 FROM request_log_pointer_dirty_v1 WHERE record_id=NEW.id); END;
        CREATE TRIGGER IF NOT EXISTS request_log_pointer_update AFTER UPDATE ON requests
        WHEN NEW.content IS NOT OLD.content OR CASE WHEN json_valid(NEW.data) AND json_valid(OLD.data) THEN
          json_extract(NEW.data,'$.partialStreamRef') IS NOT json_extract(OLD.data,'$.partialStreamRef') OR
          json_type(NEW.data,'$.partialStreamRef') IS NOT json_type(OLD.data,'$.partialStreamRef') ELSE 1 END
        BEGIN INSERT INTO request_log_pointer_dirty_v1 SELECT NEW.id
          WHERE NOT EXISTS(SELECT 1 FROM request_log_pointer_dirty_v1 WHERE record_id=NEW.id); END;`);
      this.historySearchSchema();
      for (const table of ['runs', 'tasks', 'inbox', 'requests', 'tool_operations', 'attempts'])
        this.db.exec(`CREATE INDEX IF NOT EXISTS scheduler_${table}_state ON ${table}(
          COALESCE(json_extract(data,'$.status'),json_extract(data,'$.readModel.status')));`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS scheduler_inbox_pending ON inbox(run_id)
        WHERE json_extract(data,'$.status') IS NULL OR json_extract(data,'$.status')='PENDING';`);
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS context_event_preview ON events(run_id,task_id,type,seq DESC);',
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS messages_run_session ON messages(run_id,json_extract(data,'$.sessionId'));",
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  migrate() {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if (version > STORAGE_SCHEMA_VERSION)
      throw new AppError('SCHEMA_TOO_NEW', '数据库版本比应用新，请使用相容应用或恢复升级前备份');
    if (version < 3)
      this.tx(() => {
        this.db.exec(
          `CREATE TABLE compressed_objects(ref TEXT PRIMARY KEY, hash TEXT NOT NULL, raw_size INTEGER NOT NULL, content BLOB NOT NULL); CREATE TABLE storage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`,
        );
        if (version === 0) {
          for (const table of tables)
            this.db.exec(
              `CREATE TABLE ${table}(id TEXT PRIMARY KEY, run_id TEXT ${unscopedTables.has(table) ? '' : 'REFERENCES runs(id)'}, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), content BLOB NOT NULL); CREATE INDEX ${table}_run ON ${table}(run_id);`,
            );
          this.db.exec(
            `CREATE TABLE events(run_id TEXT NOT NULL REFERENCES runs(id),seq INTEGER NOT NULL,event_id TEXT UNIQUE NOT NULL,type TEXT NOT NULL,task_id TEXT,attempt_id TEXT,payload TEXT NOT NULL,occurred_at TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(run_id,seq)); CREATE TABLE task_edges(task_id TEXT NOT NULL REFERENCES tasks(id),dependency_id TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(task_id,dependency_id)); CREATE TABLE commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,content BLOB NOT NULL,run_refs TEXT NOT NULL); CREATE UNIQUE INDEX attempt_active ON attempts(json_extract(data,'$.taskId')) WHERE json_extract(data,'$.status') IN ('ACTIVE','WAITING'); CREATE UNIQUE INDEX message_order ON messages(json_extract(data,'$.sessionId'),json_extract(data,'$.ordinal'));`,
          );
        } else {
          this.db.exec(
            `CREATE TABLE project_spaces(id TEXT PRIMARY KEY,run_id TEXT,revision INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),content BLOB NOT NULL); CREATE INDEX project_spaces_run ON project_spaces(run_id); ALTER TABLE events ADD COLUMN content BLOB; ALTER TABLE commands ADD COLUMN content BLOB; ALTER TABLE commands ADD COLUMN run_refs TEXT NOT NULL DEFAULT '[]';`,
          );
          for (const table of tables.filter((t) => t !== 'project_spaces'))
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN content BLOB;`);
          const imported = new Set<string>();
          const migratedStreams = new Set<string>();
          const importRefs = (value: unknown) => {
            for (const ref of objectRefs(value)) {
              if (!legacyObjectPattern.test(ref) || imported.has(ref)) continue;
              const bytes = this.readObject(ref);
              let parsed: unknown;
              try {
                parsed = JSON.parse(bytes.toString('utf8'));
              } catch {
                continue;
              }
              imported.add(ref);
              this.db
                .prepare('INSERT OR IGNORE INTO compressed_objects VALUES(?,?,?,?)')
                .run(ref, hash(bytes), bytes.length, gzipSync(bytes, { level: 6 }));
              importRefs(parsed);
            }
          };
          for (const table of tables.filter((t) => t !== 'project_spaces')) {
            for (const row of this.db.prepare(`SELECT id,data FROM ${table} ORDER BY rowid`).all() as any[]) {
              const raw = JSON.parse(row.data);
              importRefs(raw);
              const entity = this.hydrate(table, raw);
              if (table === 'messages') {
                delete entity.contentRef;
                delete entity.providerNativeRef;
              }
              const legacyStream =
                table === 'requests'
                  ? typeof entity.manifest?.partialStreamRef === 'string'
                    ? entity.manifest.partialStreamRef
                    : /^[a-f0-9-]+$/.test(entity.id)
                      ? path.join('logs', entity.id + '.stream.jsonl')
                      : null
                  : null;
              if (legacyStream) {
                const ref = legacyStream as string;
                const file = path.resolve(this.directory, ref),
                  logsRoot = path.resolve(this.directory, 'logs');
                if (
                  !/^logs[\\/][a-f0-9-]+\.stream\.jsonl$/.test(ref) ||
                  !file.startsWith(logsRoot + path.sep)
                )
                  throw new AppError('INVALID_OBJECT', '旧对话流日志越界');
                if (existsSync(file)) {
                  if (!realpathSync(file).startsWith(realpathSync(logsRoot) + path.sep))
                    throw new AppError('INVALID_OBJECT', '旧对话流日志越界');
                  const rawStream = readFileSync(file, 'utf8');
                  const fragments: string[] = [];
                  for (const line of rawStream.split(/\r?\n/).filter(Boolean)) {
                    try {
                      const item = JSON.parse(line);
                      if (typeof item.text === 'string' && item.completed === false)
                        fragments.push(item.text);
                    } catch {
                      /* Preserve an interrupted last fragment verbatim below. */
                    }
                  }
                  entity.manifest ??= {};
                  entity.manifest.partialText = fragments.join('');
                  entity.manifest.migratedStream = { format: 'jsonl', content: rawStream };
                  entity.manifest.partialStreamRef = null;
                  migratedStreams.add(ref);
                }
              }
              this.db
                .prepare(`UPDATE ${table} SET data=?,content=? WHERE id=?`)
                .run(projection(table, entity), compress(entity), row.id);
            }
          }
          for (const row of this.db.prepare('SELECT event_id,payload FROM events').all() as any[]) {
            importRefs(JSON.parse(row.payload));
            const payload = this.eventPayload(row.payload);
            importRefs(payload);
            this.db
              .prepare('UPDATE events SET payload=?,content=? WHERE event_id=?')
              .run('{}', compress(payload), row.event_id);
          }
          for (const row of this.db.prepare('SELECT id,result FROM commands').all() as any[]) {
            const result = JSON.parse(row.result);
            importRefs(result);
            this.db
              .prepare('UPDATE commands SET result=?,content=?,run_refs=? WHERE id=?')
              .run('{}', compress(result), stable(this.commandRunRefs(undefined, result)), row.id);
          }
          this.db
            .prepare('INSERT INTO storage_meta VALUES(?,?)')
            .run('migration_cleanup', stable({ objects: [...imported], streams: [...migratedStreams] }));
        }
        this.put('project_spaces', { id: 'default', revision: 0, name: '项目', protected: true });
        if (
          (this.db.prepare('PRAGMA integrity_check').get() as any).integrity_check !== 'ok' ||
          this.db.prepare('PRAGMA foreign_key_check').all().length
        )
          throw new AppError('DATABASE_CORRUPT', '数据库迁移完整性检查失败');
        this.db.exec('PRAGMA user_version=3;');
      });
    if (version < 4)
      this.tx(() => {
        // These chunks are authoritative content. Version 4 prevents pre-chunk readers
        // from silently treating the empty compatibility field as a complete response.
        new RequestStreams(this.db);
        for (const table of ['requests', 'runs'] as const) {
          const update = this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`);
          for (const row of this.db
            .prepare(`SELECT id,revision,data,content FROM ${table}`)
            .iterate() as Iterable<any>) {
            const entity = row.content ? expand(row.content) : JSON.parse(row.data);
            entity.revision = row.revision;
            update.run(projection(table, entity), row.id);
          }
        }
        this.db.exec(`
        CREATE INDEX request_ledger_account_time ON requests(json_extract(data,'$.requestLedger.account'),json_extract(data,'$.requestLedger.startedAt'));
        CREATE INDEX request_ledger_task ON requests(run_id,json_extract(data,'$.requestLedger.taskId'));
        CREATE INDEX request_ledger_logical ON requests(run_id,json_extract(data,'$.requestLedger.logicalId'),json_extract(data,'$.requestLedger.attemptId'));
        CREATE INDEX run_source_parent ON runs(json_extract(data,'$.sourceRunId'));
        PRAGMA user_version=4;
      `);
      });
    if (version < 5)
      this.tx(() => {
        initializeExecutionRecovery(this.db);
        this.db.exec('PRAGMA user_version=5;');
      });
    if (version < 6)
      this.tx(() => {
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS project_delivery_manifests_v1(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,title TEXT NOT NULL,created_at TEXT NOT NULL,item_count INTEGER NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
          CREATE INDEX IF NOT EXISTS project_delivery_manifests_project ON project_delivery_manifests_v1(project_id);
          CREATE TABLE project_delivery_archives_v1(
            manifest_id TEXT PRIMARY KEY REFERENCES project_delivery_manifests_v1(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            manifest_hash TEXT NOT NULL,object_ref TEXT NOT NULL,object_hash TEXT NOT NULL,
            size INTEGER NOT NULL CHECK(size >= 22 AND size <= 67108864),
            file_count INTEGER NOT NULL CHECK(file_count >= 1 AND file_count <= 800),saved_at TEXT NOT NULL);
          CREATE INDEX project_delivery_archives_project ON project_delivery_archives_v1(project_id);
          PRAGMA user_version=6;`);
      });
    // v7 makes project capability restrictions and approved context checkpoints mandatory.
    // Older clients must not open this store and silently ignore these execution boundaries.
    if (version < 7) this.tx(() => this.db.exec('PRAGMA user_version=7;'));
    // Scheduled execution must not be reopened by clients that ignore its frozen configuration.
    if (version < 8) this.tx(() => this.db.exec('PRAGMA user_version=8;'));
    // Reclaim old plaintext pages after the atomic schema/content migration. A pending marker
    // lets reopening finish cleanup safely if the process was interrupted after COMMIT.
    const pending = this.db
      .prepare("SELECT value FROM storage_meta WHERE key='migration_cleanup'")
      .get() as any;
    if (pending) {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
      const cleanup = JSON.parse(pending.value) as { objects: string[]; streams: string[] };
      for (const ref of cleanup.objects) {
        const file = path.resolve(this.directory, ref);
        const objectRoot = path.resolve(this.directory, 'objects');
        if (!legacyObjectPattern.test(ref) || !file.startsWith(objectRoot + path.sep))
          throw new AppError('INVALID_OBJECT', '迁移清理对象越界');
        if (existsSync(file)) {
          if (hash(readFileSync(file)) !== path.basename(ref))
            throw new AppError('OBJECT_CORRUPT', '迁移清理对象哈希不匹配');
          rmSync(file);
        }
      }
      for (const ref of cleanup.streams) {
        const file = path.resolve(this.directory, ref),
          logsRoot = path.resolve(this.directory, 'logs');
        if (!/^logs[\\/][a-f0-9-]+\.stream\.jsonl$/.test(ref) || !file.startsWith(logsRoot + path.sep))
          throw new AppError('INVALID_OBJECT', '迁移清理日志越界');
        if (existsSync(file)) rmSync(file);
      }
      this.db.prepare("DELETE FROM storage_meta WHERE key='migration_cleanup'").run();
    }
  }
  tx<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }
  get<T>(table: Table, key: string): T | undefined {
    const row = this.db.prepare(`SELECT data,content FROM ${table} WHERE id=?`).get(key) as any;
    return row && this.decodeRow(table, row);
  }
  getExecutionHold(runId: string) {
    return this.recovery.get(runId);
  }
  require<T>(table: Table, key: string): T {
    const value = this.get<T>(table, key);
    if (!value) throw new AppError('NOT_FOUND', `${table} 记录不存在`, false, null, 404);
    return value;
  }
  all<T>(table: Table, runId?: string): T[] {
    return (
      runId
        ? this.db.prepare(`SELECT data,content FROM ${table} WHERE run_id=? ORDER BY rowid`).all(runId)
        : this.db.prepare(`SELECT data,content FROM ${table} ORDER BY rowid`).all()
    ).map((r: any) => this.decodeRow(table, r));
  }
  /** Full delivery identity needs all metadata, never all compressed artifact bodies. */
  artifactDeliveryMetadata(runId: string) {
    return this.tx(() => this.artifactDeliveryReads.read(runId));
  }
  artifactDeliveryWarmBatch(runId: string, limit = 32) {
    return this.tx(() => this.artifactDeliveryReads.warmBatch(runId, limit));
  }
  /** Budget and scheduling reads never expand request manifests or stream text. */
  requestLedger(
    filters: {
      runId?: string;
      taskId?: string;
      account?: string;
      since?: number;
      logicalId?: string;
      attemptId?: string;
    } = {},
  ): RequestLedgerRow[] {
    const conditions: string[] = [],
      values: (string | number)[] = [];
    for (const key of ['runId', 'taskId', 'account', 'logicalId', 'attemptId'] as const) {
      if (filters[key] === undefined) continue;
      conditions.push(key === 'runId' ? 'run_id=?' : `json_extract(data,'$.requestLedger.${key}')=?`);
      values.push(filters[key]!);
    }
    if (filters.since !== undefined) {
      conditions.push("json_extract(data,'$.requestLedger.startedAt')>?");
      values.push(filters.since);
    }
    return (
      this.db
        .prepare(
          `SELECT data,revision FROM requests ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY rowid`,
        )
        .all(...values) as { data: string; revision: number }[]
    ).map((row) => ({ ...JSON.parse(row.data).requestLedger, revision: row.revision }));
  }
  latestTaskRequest(runId: string, taskId: string): RequestRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT data,content FROM requests WHERE run_id=? AND json_extract(data,'$.requestLedger.taskId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(runId, taskId) as any;
    return row ? this.decodeRow('requests', row) : undefined;
  }
  sessionMessages(runId: string, sessionId: string): Message[] {
    return (
      this.db
        .prepare(
          "SELECT data,content FROM messages WHERE run_id=? AND json_extract(data,'$.sessionId')=? ORDER BY rowid",
        )
        .all(runId, sessionId) as any[]
    ).map((row) => this.decodeRow('messages', row));
  }
  sessionMessageCount(runId: string, sessionId: string): number {
    return Number(
      this.db
        .prepare("SELECT count(*) total FROM messages WHERE run_id=? AND json_extract(data,'$.sessionId')=?")
        .get(runId, sessionId)?.total ?? 0,
    );
  }
  runRevisions(sourceRunId: string, limit = 20, before?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 40)
      throw new AppError('PAGE_LIMIT', '修订分页数量无效');
    let cursor: number | undefined;
    if (before) {
      const row = this.db
        .prepare("SELECT rowid ordinal FROM runs WHERE id=? AND json_extract(data,'$.sourceRunId')=?")
        .get(before, sourceRunId) as { ordinal: number } | undefined;
      if (!row) throw new AppError('PAGE_CURSOR', '修订分页已变化，请重新读取', false, null, 409);
      cursor = row.ordinal;
    }
    const total = Number(
      this.db
        .prepare("SELECT count(*) total FROM runs WHERE json_extract(data,'$.sourceRunId')=?")
        .get(sourceRunId)?.total ?? 0,
    );
    const rows = this.db
      .prepare(
        `SELECT id,data,content FROM runs WHERE json_extract(data,'$.sourceRunId')=? ${cursor === undefined ? '' : 'AND rowid<?'} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(sourceRunId, ...(cursor === undefined ? [] : [cursor]), limit + 1) as any[];
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => this.decodeRow('runs', row) as Run),
      page: {
        limit,
        before: before ?? null,
        total,
        hasMore: rows.length > limit,
        nextBefore: rows.length > limit ? selected.at(-1).id : null,
      },
    };
  }
  /** Read one request without expanding its in-flight stream. */
  requestMetadata(key: string): RequestRecord {
    const row = this.db.prepare('SELECT data,content FROM requests WHERE id=?').get(key) as any;
    if (!row) throw new AppError('NOT_FOUND', 'requests 记录不存在', false, null, 404);
    return this.decodeRow('requests', row, false);
  }
  startRequestStream(key: string) {
    this.tx(() => {
      const request = this.require<RequestRecord>('requests', key);
      if (request.status !== 'RESERVED') throw new AppError('REQUEST_STREAM_CLOSED', '模型请求已结束');
      this.requestStreams.start(key);
      this.put('requests', {
        ...request,
        manifest: {
          ...request.manifest,
          partialText: '',
          partialStreamRef: null,
          partialTextStorage: REQUEST_STREAM_FORMAT,
        },
      });
    });
  }
  appendRequestText(key: string, text: string, expectedOffset: number) {
    this.tx(() => this.requestStreams.append(key, text, expectedOffset));
  }
  private historySearchSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_search_v1(
        kind TEXT NOT NULL,record_id TEXT NOT NULL,run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,normalized TEXT NOT NULL,
        PRIMARY KEY(kind,record_id)
      );
      CREATE INDEX IF NOT EXISTS history_search_run ON history_search_v1(kind,run_id);
      CREATE TABLE IF NOT EXISTS history_search_pending_v2(
        kind TEXT NOT NULL,record_id TEXT NOT NULL,run_id TEXT NOT NULL,
        PRIMARY KEY(kind,record_id)
      );
      CREATE INDEX IF NOT EXISTS history_search_pending_scope ON history_search_pending_v2(kind,run_id);
      CREATE TABLE IF NOT EXISTS history_search_epochs_v2(
        kind TEXT NOT NULL,scope TEXT NOT NULL,revision INTEGER NOT NULL,
        PRIMARY KEY(kind,scope)
      );
    `);
    for (const table of ['runs', 'messages'] as const) {
      const kind = table === 'runs' ? 'run' : 'message';
      const scope = table === 'runs' ? "'global'" : 'NEW.run_id';
      const oldScope = table === 'runs' ? "'global'" : 'OLD.run_id';
      const enqueue = `INSERT INTO history_search_pending_v2(kind,record_id,run_id)
        VALUES('${kind}',NEW.id,${table === 'runs' ? 'NEW.id' : 'NEW.run_id'})
        ON CONFLICT(kind,record_id) DO UPDATE SET run_id=excluded.run_id;
        INSERT INTO history_search_epochs_v2(kind,scope,revision) VALUES('${kind}',${scope},1)
        ON CONFLICT(kind,scope) DO UPDATE SET revision=revision+1;`;
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS history_search_${table}_update AFTER UPDATE ON ${table}
        WHEN NEW.revision IS NOT OLD.revision OR NEW.content IS NOT OLD.content
          OR (NEW.content IS NULL AND NEW.data IS NOT OLD.data)
        BEGIN DELETE FROM history_search_v1 WHERE kind='${kind}' AND record_id=NEW.id; END;
        CREATE TRIGGER IF NOT EXISTS history_search_${table}_delete AFTER DELETE ON ${table}
        BEGIN DELETE FROM history_search_v1 WHERE kind='${kind}' AND record_id=OLD.id; END;
        CREATE TRIGGER IF NOT EXISTS history_search_${table}_queue_insert AFTER INSERT ON ${table}
        BEGIN ${enqueue} END;
        CREATE TRIGGER IF NOT EXISTS history_search_${table}_queue_update AFTER UPDATE ON ${table}
        WHEN NEW.revision IS NOT OLD.revision OR NEW.content IS NOT OLD.content
          OR (NEW.content IS NULL AND NEW.data IS NOT OLD.data)
        BEGIN ${enqueue}
          ${table === 'messages' ? `INSERT INTO history_search_epochs_v2(kind,scope,revision) SELECT 'message',OLD.run_id,1 WHERE OLD.run_id IS NOT NEW.run_id ON CONFLICT(kind,scope) DO UPDATE SET revision=revision+1;` : ''}
        END;
        CREATE TRIGGER IF NOT EXISTS history_search_${table}_queue_delete AFTER DELETE ON ${table}
        BEGIN DELETE FROM history_search_pending_v2 WHERE kind='${kind}' AND record_id=OLD.id;
          INSERT INTO history_search_epochs_v2(kind,scope,revision) VALUES('${kind}',${oldScope},1)
          ON CONFLICT(kind,scope) DO UPDATE SET revision=revision+1;
          ${table === 'runs' ? "DELETE FROM history_search_epochs_v2 WHERE kind='message' AND scope=OLD.id; DELETE FROM storage_meta WHERE key IN ('history-search-bootstrap:message:'||OLD.id,'history-search-progress:message:'||OLD.id);" : ''}
        END;
      `);
    }
  }
  private historySearchProjection(table: 'runs' | 'messages', entity: Run | Message) {
    const isRun = table === 'runs';
    const text = isRun ? `${(entity as Run).title} ${(entity as Run).objective}` : (entity as Message).text;
    const result = this.db
      .prepare(
        `
      INSERT INTO history_search_v1(kind,record_id,run_id,revision,normalized)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ${table} WHERE id=? AND revision=?)
      ON CONFLICT(kind,record_id) DO UPDATE SET
        run_id=excluded.run_id,revision=excluded.revision,normalized=excluded.normalized
    `,
      )
      .run(
        isRun ? 'run' : 'message',
        entity.id,
        isRun ? entity.id : entity.runId!,
        entity.revision,
        text.toLocaleLowerCase(),
        entity.id,
        entity.revision,
      );
    if (result.changes)
      this.db
        .prepare('DELETE FROM history_search_pending_v2 WHERE kind=? AND record_id=?')
        .run(isRun ? 'run' : 'message', entity.id);
  }
  /** Missing legacy indexes are populated only by an explicit search, in yielding small batches. */
  async ensureHistorySearch(kind: 'run' | 'message', runId?: string, signal?: AbortSignal): Promise<number> {
    const table = kind === 'run' ? 'runs' : 'messages';
    const reads = kind === 'run' ? projectionReads(this) : undefined;
    return this.searchWork.run(
      `warm:${kind}:${runId ?? 'global'}`,
      async (workSignal) => {
        const marker = `history-search-bootstrap:${kind}:${runId ?? 'global'}`;
        const progress = `history-search-progress:${kind}:${runId ?? 'global'}`;
        if (!this.db.prepare('SELECT 1 FROM storage_meta WHERE key=?').get(marker)) {
          let position = Number(
            (
              this.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(progress) as
                | { value: string }
                | undefined
            )?.value ?? 0,
          );
          for (;;) {
            searchCancelled(workSignal);
            const rows = this.db
              .prepare(
                `SELECT e.id,e.rowid position,s.record_id indexed_id FROM ${table} e
            LEFT JOIN history_search_v1 s ON s.kind=? AND s.record_id=e.id AND s.revision=e.revision
            WHERE e.rowid>? ${runId ? 'AND e.run_id=?' : ''} ORDER BY e.rowid LIMIT 32`,
              )
              .all(kind, position, ...(runId ? [runId] : [])) as {
              id: string;
              position: number;
              indexed_id: string | null;
            }[];
            if (!rows.length) break;
            for (const row of rows)
              if (!row.indexed_id) {
                const entity = reads
                  ? reads.read<Run>('runs', row.id)
                  : this.get<Message>('messages', row.id);
                if (entity) {
                  this.historySearchProjection(table, entity);
                  this.refreshReadProjection(table, entity);
                }
              }
            position = rows.at(-1)!.position;
            this.db
              .prepare('INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)')
              .run(progress, String(position));
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          this.tx(() => {
            this.db.prepare('INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)').run(marker, '1');
            this.db.prepare('DELETE FROM storage_meta WHERE key=?').run(progress);
          });
        }
        for (;;) {
          searchCancelled(workSignal);
          const pending = this.db
            .prepare(
              `SELECT record_id id FROM history_search_pending_v2 WHERE kind=? ${runId ? 'AND run_id=?' : ''} LIMIT 32`,
            )
            .all(kind, ...(runId ? [runId] : [])) as { id: string }[];
          if (!pending.length) {
            const ready = this.tx(() =>
              this.db
                .prepare(
                  `SELECT 1 FROM history_search_pending_v2 WHERE kind=? ${runId ? 'AND run_id=?' : ''} LIMIT 1`,
                )
                .get(kind, ...(runId ? [runId] : []))
                ? undefined
                : this.historySearchEpoch(kind, runId),
            );
            if (ready !== undefined) return ready;
            continue;
          }
          for (const row of pending) {
            const entity = reads ? reads.read<Run>('runs', row.id) : this.get<Message>('messages', row.id);
            if (entity) this.historySearchProjection(table, entity);
            else
              this.db
                .prepare('DELETE FROM history_search_pending_v2 WHERE kind=? AND record_id=?')
                .run(kind, row.id);
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      },
      signal,
    );
  }
  private historySearchEpoch(kind: 'run' | 'message', runId?: string) {
    return Number(
      (
        this.db
          .prepare('SELECT revision FROM history_search_epochs_v2 WHERE kind=? AND scope=?')
          .get(kind, runId ?? 'global') as { revision: number } | undefined
      )?.revision ?? 0,
    );
  }
  /** Exact Unicode substring search with bounded result memory and yielding scans. */
  async historySearch(
    kind: 'run' | 'message',
    query: {
      search: string;
      limit: number;
      before?: string;
      runId?: string;
      archived?: boolean;
      included?: string[];
    },
    signal?: AbortSignal,
  ) {
    return this.searchWork.run(
      `search:${kind}:${stable(query)}`,
      async (workSignal) => {
        const table = kind === 'run' ? 'runs' : 'messages';
        for (let attempt = 0; attempt < 3; attempt++) {
          const epoch = await this.ensureHistorySearch(kind, query.runId, workSignal);
          searchCancelled(workSignal);
          if (epoch !== this.historySearchEpoch(kind, query.runId)) continue;
          const cursor = query.before
            ? (this.db
                .prepare(
                  `SELECT rowid position FROM ${table} WHERE id=? ${query.runId ? 'AND run_id=?' : ''}`,
                )
                .get(query.before, ...(query.runId ? [query.runId] : [])) as { position: number } | undefined)
            : undefined;
          if (query.before && !cursor)
            throw new AppError(
              kind === 'run' ? 'RECORD_CURSOR_MISSING' : 'MESSAGE_CURSOR_MISSING',
              '搜索位置已失效，请重新搜索',
              false,
              null,
              409,
            );
          const included = new Set(query.included ?? []),
            matchedIncluded: string[] = [],
            ids: string[] = [];
          let total = 0,
            position = Number.MAX_SAFE_INTEGER,
            changed = false;
          for (;;) {
            searchCancelled(workSignal);
            const rows = this.db
              .prepare(
                `SELECT e.id,e.rowid position,instr(s.normalized,?) matched,
            ${kind === 'run' ? "COALESCE(json_extract(e.data,'$.readModel.archived'),json_extract(e.data,'$.archived'),0)" : '0'} archived
            FROM ${table} e JOIN history_search_v1 s ON s.kind=? AND s.record_id=e.id AND s.revision=e.revision
            WHERE e.rowid<? ${query.runId ? 'AND e.run_id=?' : ''} ORDER BY e.rowid DESC LIMIT 32`,
              )
              .all(query.search, kind, position, ...(query.runId ? [query.runId] : [])) as {
              id: string;
              position: number;
              matched: number;
              archived: number;
            }[];
            for (const row of rows)
              if (row.matched) {
                if (included.has(row.id)) matchedIncluded.push(row.id);
                if (query.archived === undefined || Boolean(row.archived) === query.archived) {
                  total++;
                  if ((!cursor || row.position < cursor.position) && ids.length <= query.limit)
                    ids.push(row.id);
                }
              }
            if (!rows.length) break;
            position = rows.at(-1)!.position;
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (epoch !== this.historySearchEpoch(kind, query.runId)) {
              changed = true;
              break;
            }
          }
          if (changed || epoch !== this.historySearchEpoch(kind, query.runId)) continue;
          const hasMore = ids.length > query.limit;
          ids.splice(query.limit);
          return { ids, total, matchedIncluded, hasMore, nextBefore: hasMore ? (ids.at(-1) ?? null) : null };
        }
        throw new AppError('SEARCH_CHANGED', '搜索期间记录持续更新，请重试', true, null, 409);
      },
      signal,
    );
  }
  /** Upgrade redundant read metadata without changing compressed business content or revision. */
  refreshReadProjection(
    table: 'runs' | 'tasks' | 'artifacts' | 'requests' | 'tool_operations' | 'messages' | 'inbox',
    entity: Entity,
  ) {
    const refresh = () => {
      // Full server schemas make compiling this guarded request update expensive per legacy row.
      // SQLite still reevaluates bindings and recompiles the statement after schema changes.
      const update =
        table === 'requests'
          ? (this.requestReadProjectionUpdate ??= this.db.prepare(
              'UPDATE requests SET data=? WHERE id=? AND revision=? AND content IS NOT NULL',
            ))
          : this.db.prepare(`UPDATE ${table} SET data=? WHERE id=? AND revision=? AND content IS NOT NULL`);
      const updated = update.run(projection(table, entity), entity.id, entity.revision);
      if (table === 'artifacts' && updated.changes)
        this.artifactDeliveryReads.write(entity as import('../../contracts/src/index.js').Artifact);
    };
    return table === 'artifacts' ? this.tx(refresh) : refresh();
  }
  /** Filter redundant state before expanding bodies. Legacy projections are warmed once. */
  stateCandidates<T extends Entity>(
    table: 'runs' | 'tasks' | 'requests' | 'tool_operations' | 'inbox',
    statuses: string[],
    options: {
      runId?: string;
      exclude?: boolean;
      unarchived?: boolean;
      waitReasons?: string[];
      resumeBefore?: number;
      excludeRunIds?: readonly string[];
      excludeExecutionHolds?: boolean;
    } = {},
  ): T[] {
    if (!statuses.length) return [];
    const state = `COALESCE(json_extract(data,'$.status'),json_extract(data,'$.readModel.status'))`;
    const clauses = [
      ...(options.excludeExecutionHolds
        ? [
            `NOT EXISTS(SELECT 1 FROM execution_holds_v1 h WHERE h.run_id=${table === 'runs' ? 'runs.id' : `${table}.run_id`})`,
          ]
        : []),
      `(${state} IS NULL OR ${state} ${options.exclude ? 'NOT ' : ''}IN (${statuses.map(() => '?').join(',')}))`,
      ...(options.runId ? ['run_id=?'] : []),
      ...(options.unarchived
        ? [`COALESCE(json_extract(data,'$.archived'),json_extract(data,'$.readModel.archived'),0)=0`]
        : []),
      ...(table === 'tasks' && options.waitReasons?.length
        ? [
            `(COALESCE(json_extract(data,'$.readModel.waitReason'),json_extract(data,'$.waitReason')) IS NULL OR COALESCE(json_extract(data,'$.readModel.waitReason'),json_extract(data,'$.waitReason')) IN (${options.waitReasons.map(() => '?').join(',')}))`,
          ]
        : []),
      ...(table === 'tasks' && options.resumeBefore !== undefined
        ? [
            `(json_extract(data,'$.schedulerVersion') IS NOT 1 OR json_extract(data,'$.readModel.rateResumeAt')<=?)`,
          ]
        : []),
      ...(options.excludeRunIds?.length
        ? [`${table === 'runs' ? 'id' : 'run_id'} NOT IN (SELECT value FROM json_each(?))`]
        : []),
    ];
    const rows = this.db
      .prepare(`SELECT id,data,content FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY rowid`)
      .all(
        ...statuses,
        ...(options.runId ? [options.runId] : []),
        ...(table === 'tasks' ? (options.waitReasons ?? []) : []),
        ...(table === 'tasks' && options.resumeBefore !== undefined ? [options.resumeBefore] : []),
        ...(options.excludeRunIds?.length ? [JSON.stringify(options.excludeRunIds)] : []),
      ) as {
      id: string;
      data: string;
      content: Uint8Array;
    }[];
    const wanted = new Set(statuses);
    return rows.flatMap((row) => {
      const metadata = JSON.parse(row.data);
      const entity = this.decodeRow(table, row) as T & {
        status?: string;
        archived?: boolean;
      };
      if (metadata.status === undefined || (table === 'tasks' && metadata.schedulerVersion !== 1))
        this.refreshReadProjection(table, entity);
      return (options.exclude ? !wanted.has(entity.status || '') : wanted.has(entity.status || '')) &&
        (!options.unarchived || !entity.archived) &&
        (table !== 'tasks' ||
          !options.waitReasons?.length ||
          options.waitReasons.includes((entity as unknown as Task).waitReason || ''))
        ? [entity]
        : [];
    });
  }
  schedulerCandidates(): { runs: Run[]; tasks: Task[] } {
    return {
      runs: this.stateCandidates<Run>('runs', ['DONE', 'CANCELLED'], { exclude: true, unarchived: true }),
      tasks: this.stateCandidates<Task>('tasks', ['READY']),
    };
  }
  /** Pick maintenance work from redundant metadata before expanding any idle history. */
  schedulerRunCandidates(at = Date.now(), excludeRunIds: readonly string[] = []): Run[] {
    const status = (alias: string) =>
      `COALESCE(json_extract(${alias}.data,'$.status'),json_extract(${alias}.data,'$.readModel.status'))`;
    const reason =
      "COALESCE(json_extract(t.data,'$.readModel.waitReason'),json_extract(t.data,'$.waitReason'))";
    const waitingFor =
      "COALESCE(json_extract(t.data,'$.readModel.waitingFor'),json_extract(t.data,'$.waitingFor'))";
    const needsDecision = (alias: string) =>
      `(${status(alias)} IN ('FAILED','CANCELLED') OR (${status(alias)}='WAITING' AND
        (COALESCE(json_extract(${alias}.data,'$.readModel.waitReason'),json_extract(${alias}.data,'$.waitReason'))='no_progress' OR
          (COALESCE(json_extract(${alias}.data,'$.readModel.waitReason'),json_extract(${alias}.data,'$.waitReason'))='dependency_failed' AND
            json_extract(${alias}.data,'$.readModel.dependencyNeedsDecision') IS NOT 0))))`;
    const rows = this.db
      .prepare(
        `SELECT r.id,json_extract(r.data,'$.readModelVersion') projection_version FROM runs r WHERE
        NOT EXISTS(SELECT 1 FROM execution_holds_v1 h WHERE h.run_id=r.id) AND
        COALESCE(json_extract(r.data,'$.archived'),json_extract(r.data,'$.readModel.archived'),0)=0
        AND (${status('r')} IS NULL OR (${status('r')} NOT IN ('DONE','CANCELLED') AND (
          (${status('r')} IN ('READY','RUNNING') AND EXISTS(SELECT 1 FROM tasks t WHERE t.run_id=r.id
            AND (${status('t')} IS NULL OR ${status('t')} IN ('READY','RUNNING','VERIFYING'))))
          OR EXISTS(SELECT 1 FROM inbox i WHERE i.run_id=r.id AND (json_extract(i.data,'$.status') IS NULL OR json_extract(i.data,'$.status')='PENDING'))
          OR EXISTS(SELECT 1 FROM tasks t JOIN task_edges e ON e.task_id=t.id JOIN tasks d ON d.id=e.dependency_id
            WHERE t.run_id=r.id AND ${status('t')}='READY' AND ${needsDecision('d')})
          OR EXISTS(SELECT 1 FROM tasks t WHERE t.run_id=r.id AND (
            ${status('t')} IS NULL OR (${status('t')}='WAITING' AND (
              (${reason}='children' AND (json_extract(t.data,'$.schedulerVersion') IS NOT 1 OR
                EXISTS(SELECT 1 FROM json_each(${waitingFor}) w JOIN tasks c ON c.id=w.value WHERE ${needsDecision('c')}) OR
                NOT EXISTS(SELECT 1 FROM json_each(${waitingFor}) w LEFT JOIN tasks c ON c.id=w.value
                  WHERE c.id IS NULL OR ${status('c')} IS NULL OR ${status('c')} NOT IN ('DONE','FAILED','CANCELLED'))))
              OR (${reason}='dependency_failed' AND NOT EXISTS(
                SELECT 1 FROM task_edges e LEFT JOIN tasks d ON d.id=e.dependency_id
                WHERE e.task_id=t.id AND (d.id IS NULL OR ${status('d')} IS NULL OR ${status('d')}<>'DONE')))
              OR (${reason}='rate_limit' AND (json_extract(t.data,'$.schedulerVersion') IS NOT 1
                OR json_extract(t.data,'$.readModel.rateResumeAt')<=?))
              OR (${reason} IS NULL AND json_extract(t.data,'$.schedulerVersion') IS NOT 1)
            )) OR (${status('t')}='READY' AND (
              json_extract(t.data,'$.readModel.rateResumeAt')<=? OR
              (json_extract(t.data,'$.schedulerVersion') IS NOT 1 AND
                COALESCE(json_extract(r.data,'$.readModel.reason'),json_extract(r.data,'$.reason'))='rate_limit')
            ))
          ))
        ))) ${excludeRunIds.length ? 'AND r.id NOT IN (SELECT value FROM json_each(?))' : ''} ORDER BY r.rowid`,
      )
      .all(at, at, ...(excludeRunIds.length ? [JSON.stringify(excludeRunIds)] : [])) as {
      id: string;
      projection_version: number | null;
    }[];
    return rows.flatMap(({ id: key, projection_version }) => {
      const run = this.get<Run>('runs', key);
      if (!run) return [];
      if (projection_version !== 1) this.refreshReadProjection('runs', run);
      return !run.archived && !['DONE', 'CANCELLED'].includes(run.status) ? [run] : [];
    });
  }
  hasPendingInbox(runId: string) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM inbox WHERE run_id=? AND (json_extract(data,'$.status') IS NULL OR json_extract(data,'$.status')='PENDING') LIMIT 1",
        )
        .get(runId),
    );
  }
  /** Return only real message links within this Run, never retained message bodies. */
  messageConversationLinks(runId: string, identifiers: string[]): ConversationMessageLinks[] {
    if (identifiers.length > 240) throw new AppError('MESSAGE_LINK_LIMIT', '消息关联读取数量无效');
    if (!identifiers.length) return [];
    const rows = this.db
      .prepare(
        "SELECT id,json_extract(data,'$.conversationLinks') links FROM messages WHERE run_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY rowid",
      )
      .all(runId, JSON.stringify(identifiers)) as { id: string; links: string | null }[];
    return rows.map((row) => {
      if (row.links) return JSON.parse(row.links) as ConversationMessageLinks;
      const message = this.require<Message>('messages', row.id);
      this.refreshReadProjection('messages', message);
      return conversationLinks(message);
    });
  }
  messagePage<T>(runId: string, limit: number, before?: string) {
    let boundary: number | undefined;
    if (before) {
      const row = this.db
        .prepare('SELECT rowid position FROM messages WHERE id=? AND run_id=?')
        .get(before, runId) as { position: number } | undefined;
      if (!row)
        throw new AppError('MESSAGE_CURSOR_MISSING', '历史位置已失效，请返回最新消息', false, null, 409);
      boundary = Number(row.position);
    }
    const rows = this.db
      .prepare(
        `SELECT id,data,content FROM messages WHERE run_id=? ${boundary === undefined ? '' : 'AND rowid<?'} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...(boundary === undefined ? [runId, limit + 1] : [runId, boundary, limit + 1])) as {
      id: string;
      data: string;
      content?: Uint8Array;
    }[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit).reverse();
    return {
      messages: selected.map((row) => {
        const metadata = JSON.parse(row.data);
        const message = this.decodeRow('messages', row) as Message;
        if (!metadata.conversationLinks) this.refreshReadProjection('messages', message);
        return message as T;
      }),
      messagePage: { hasMore, nextBefore: hasMore ? selected[0]?.id : null, before: before ?? null, limit },
    };
  }
  messageAroundPage<T>(runId: string, limit: number, anchor: string) {
    const target = this.db
      .prepare('SELECT rowid position FROM messages WHERE id=? AND run_id=?')
      .get(anchor, runId) as { position: number } | undefined;
    if (!target) throw new AppError('MESSAGE_CURSOR_MISSING', '目标消息已失效，请重新搜索', false, null, 409);
    const newer = this.db
      .prepare('SELECT id FROM messages WHERE run_id=? AND rowid>? ORDER BY rowid LIMIT ?')
      .all(runId, target.position, Math.floor(limit / 2) + 1) as { id: string }[];
    const before = newer[Math.floor(limit / 2)]?.id;
    const result = this.messagePage<T>(runId, limit, before);
    return {
      ...result,
      messagePage: { ...result.messagePage, anchorMessageId: anchor, hasNewer: Boolean(before) },
    };
  }
  entityPage<T>(
    table: 'requests' | 'tool_operations' | 'artifacts' | 'runs',
    limit: number,
    before?: string,
    runId?: string,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 160)
      throw new AppError('RECORD_PAGE_LIMIT', '记录分页数量无效');
    let boundary: number | undefined;
    if (before) {
      const cursor = this.db
        .prepare(`SELECT rowid position FROM ${table} WHERE id=?${runId ? ' AND run_id=?' : ''}`)
        .get(...(runId ? [before, runId] : [before])) as { position: number } | undefined;
      if (!cursor)
        throw new AppError('RECORD_CURSOR_MISSING', '记录位置已失效，请返回最新', false, null, 409);
      boundary = Number(cursor.position);
    }
    const conditions = [...(runId ? ['run_id=?'] : []), ...(boundary === undefined ? [] : ['rowid<?'])];
    const rows = this.db
      .prepare(
        `SELECT id,data,content FROM ${table}${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...(runId ? [runId] : []), ...(boundary === undefined ? [] : [boundary]), limit + 1) as {
      id: string;
      data: string;
      content?: Uint8Array;
    }[];
    const selected = rows.slice(0, limit);
    const total = Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) n FROM ${table}${runId ? ' WHERE run_id=?' : ''}`)
          .get(...(runId ? [runId] : [])) as { n: number }
      ).n,
    );
    return {
      items: selected.map((row) => this.decodeRow(table, row) as T),
      page: {
        total,
        limit,
        before: before ?? null,
        hasMore: rows.length > limit,
        nextBefore: rows.length > limit ? (selected.at(-1)?.id ?? null) : null,
      },
    };
  }
  private decodeRow(table: Table, row: { data: string; content?: Uint8Array }, includeStream = true) {
    const metadata = JSON.parse(row.data);
    const entity = row.content ? expand(row.content) : metadata;
    // Stream appends update only the SQL metadata revision; it remains authoritative on every read path.
    entity.revision = metadata.revision;
    return this.hydrate(table, entity, includeStream);
  }
  private hydrate(table: Table, entity: any, includeStream = true) {
    // Legacy classification is ignored; execution directory and baseline references are retained.
    if (table === 'projects') {
      delete entity.mode;
      entity.spaceId ??= 'default';
      entity.archived ??= false;
    }
    if (table === 'tasks' && entity.spec) delete entity.spec.mode;
    if (table === 'runs') {
      entity.kind ??= 'task';
      entity.planMode ??= entity.kind !== 'chat';
      entity.title ??= entity.objective;
      entity.archived ??= false;
      if (entity.contract) delete entity.contract.mode;
      for (const task of entity.plan?.tasks ?? []) delete task.mode;
    }
    if (table === 'messages') {
      if (entity.contentRef) Object.assign(entity, JSON.parse(this.readObject(entity.contentRef).toString()));
      if (entity.providerNativeRef)
        entity.native = JSON.parse(this.readObject(entity.providerNativeRef).toString());
    }
    if (table === 'requests' && entity.manifest?.partialTextStorage === REQUEST_STREAM_FORMAT)
      entity.manifest.partialText = includeStream ? this.requestStreams.read(entity.id) : '';
    return entity;
  }
  put<T extends Entity>(table: Table, entity: T, expectedRevision?: number): T {
    const previous =
      table === 'requests'
        ? (this.db.prepare('SELECT revision FROM requests WHERE id=?').get(entity.id) as
            | { revision: number }
            | undefined)
        : this.get<Entity>(table, entity.id);
    if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision)
      throw new AppError(
        'REVISION_CONFLICT',
        '记录已更新，请刷新后重试',
        false,
        { currentRevision: previous?.revision },
        409,
      );
    const next = { ...entity, revision: (previous?.revision ?? 0) + 1 };
    const stored: any = { ...next };
    let clearStream = false;
    if (table === 'requests' && stored.manifest?.partialTextStorage === REQUEST_STREAM_FORMAT) {
      stored.manifest = { ...stored.manifest };
      if (stored.manifest.partialText === null) {
        clearStream = true;
        delete stored.manifest.partialTextStorage;
        (next as any).manifest = stored.manifest;
      } else stored.manifest.partialText = '';
    }
    if (table === 'messages') {
      delete stored.contentRef;
      delete stored.providerNativeRef;
      delete (next as any).contentRef;
      delete (next as any).providerNativeRef;
    }
    const save = () => {
      this.db
        .prepare(
          `INSERT INTO ${table}(id,run_id,revision,data,content) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,revision=excluded.revision,data=excluded.data,content=excluded.content`,
        )
        .run(next.id, next.runId ?? null, next.revision, projection(table, stored), compress(stored));
      this.objectReferences?.write(table, next.id, stored);
      if (table === 'requests')
        this.db.prepare('DELETE FROM request_log_pointer_dirty_v1 WHERE record_id=?').run(next.id);
      if (table === 'artifacts') this.artifactDeliveryReads.write(stored);
      if (clearStream) this.requestStreams.clear(entity.id);
      if (table === 'runs' || table === 'messages')
        this.historySearchProjection(table, next as unknown as Run | Message);
      return next;
    };
    return this.tx(save);
  }
  event(
    runId: string,
    type: string,
    payload: unknown,
    taskId: string | null = null,
    attemptId: string | null = null,
  ): Event {
    const seq = Number(
      (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM events WHERE run_id=?').get(runId) as any).n,
    );
    const e = { runId, seq, eventId: id(), type, taskId, attemptId, payload, occurredAt: now() };
    const metrics = type === 'context.updated' ? ContextRuntimeMetrics.safeParse(payload) : undefined;
    const preview = metrics?.success ? stable({ contextPreviewVersion: 1, metrics: metrics.data }) : '{}';
    this.tx(() => {
      this.db
        .prepare(
          'INSERT INTO events(run_id,seq,event_id,type,task_id,attempt_id,payload,occurred_at,content) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          runId,
          seq,
          e.eventId,
          type,
          taskId,
          attemptId,
          Buffer.byteLength(preview) <= 16384 ? preview : '{}',
          e.occurredAt,
          compress(payload),
        );
      this.objectReferences?.write('events', e.eventId, payload);
    });
    return e;
  }
  events(runId: string, after = 0, filter: { taskId?: string; type?: string; limit?: number } = {}): Event[] {
    const conditions = ['run_id=?', 'seq>?'];
    const bindings: (string | number)[] = [runId, after];
    if (filter.taskId !== undefined) {
      conditions.push('task_id=?');
      bindings.push(filter.taskId);
    }
    if (filter.type !== undefined) {
      conditions.push('type=?');
      bindings.push(filter.type);
    }
    const limit = filter.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new AppError('EVENT_RANGE', '事件读取范围无效');
    return this.db
      .prepare(`SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY seq LIMIT ?`)
      .all(...bindings, limit)
      .map((r: any) => ({
        runId: r.run_id,
        seq: r.seq,
        eventId: r.event_id,
        type: r.type,
        taskId: r.task_id,
        attemptId: r.attempt_id,
        payload: r.content ? expand(r.content) : this.eventPayload(r.payload),
        occurredAt: r.occurred_at,
      }));
  }
  /** SSE notifications have a fixed batch and bounded decompression; full bodies stay in record reads. */
  eventNotifications(runId: string, after: number): Event[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 32')
      .all(runId, after) as any[];
    return rows.map((row) => {
      let payload: unknown;
      let type = row.type;
      try {
        if (row.content)
          payload = JSON.parse(gunzipSync(row.content, { maxOutputLength: 48 * 1024 }).toString('utf8'));
        else {
          if (Buffer.byteLength(row.payload) > 48 * 1024)
            throw Object.assign(new Error('Large notification'), { code: 'ERR_BUFFER_TOO_LARGE' });
          payload = JSON.parse(row.payload);
          if (payload && typeof payload === 'object' && 'externalPayloadRef' in payload)
            throw Object.assign(new Error('Legacy external notification'), { code: 'ERR_BUFFER_TOO_LARGE' });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE') throw error;
        type = 'run.updated';
        payload = { detailsOmitted: true, eventType: row.type };
      }
      return {
        runId: row.run_id,
        seq: row.seq,
        eventId: row.event_id,
        type,
        taskId: row.task_id,
        attemptId: row.attempt_id,
        payload,
        occurredAt: row.occurred_at,
      };
    });
  }
  private eventPayload(value: string) {
    const payload = JSON.parse(value);
    return payload && Object.keys(payload).length === 1 && typeof payload.externalPayloadRef === 'string'
      ? JSON.parse(this.readObject(payload.externalPayloadRef).toString())
      : payload;
  }
  command<T>(commandId: string, payload: unknown, fn: () => T): T {
    const fingerprint = hash(stable(payload));
    return this.tx(() => {
      const old = this.db.prepare('SELECT * FROM commands WHERE id=?').get(commandId) as any;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new AppError('COMMAND_REUSED', 'commandId 已用于不同请求', false, null, 409);
        return old.content ? expand(old.content) : JSON.parse(old.result);
      }
      const result = fn();
      this.db
        .prepare('INSERT INTO commands(id,fingerprint,result,content,run_refs) VALUES(?,?,?,?,?)')
        .run(commandId, fingerprint, '{}', compress(result), stable(this.commandRunRefs(payload, result)));
      this.objectReferences?.write('commands', commandId, result);
      return result;
    });
  }
  private commandRunRefs(payload: unknown, result: unknown) {
    const refs = new Set<string>();
    const visit = (value: any) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.runId === 'string') refs.add(value.runId);
      if (typeof value.id === 'string' && typeof value.rootTaskId === 'string') refs.add(value.id);
      if (typeof value.route === 'string') {
        const match = /^(?:\/terminal)?\/api\/runs\/([^/?]+)/.exec(value.route);
        if (match) refs.add(decodeURIComponent(match[1]));
      }
      for (const nested of Object.values(value)) visit(nested);
    };
    visit(payload);
    visit(result);
    return [...refs];
  }
  delete(table: Table, key: string) {
    if (table === 'runs') throw new AppError('DELETE_RUN_REQUIRED', '请使用 deleteRun 删除对话及其关联记录');
    const entity = this.get<any>(table, key);
    if (!entity) return;
    if (table === 'project_spaces' && (key === 'default' || entity.protected))
      throw new AppError('SPACE_PROTECTED', '初始项目空间不能删除或合并');
    if (table === 'project_spaces' && this.all<any>('projects').some((p) => p.spaceId === key))
      throw new AppError('SPACE_NOT_EMPTY', '请先移动或删除空间内的项目');
    if (table === 'projects' && this.all<any>('runs').some((run) => run.projectId === key))
      throw new AppError('PROJECT_NOT_EMPTY', '请先删除项目内的对话');
    this.tx(() => {
      this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(key);
      if (table === 'projects') {
        for (const draftKey of [
          `draft:setup:project:${key}`,
          `draft:project-board:${key}`,
          `draft:project-intelligence:${key}`,
          `draft:project-schedules:${key}`,
        ])
          for (const prefix of ['workbench:v1:', 'workbench-index:v1:'])
            this.db.prepare('DELETE FROM storage_meta WHERE key=?').run(prefix + draftKey);
        for (const prefix of [
          'project-intelligence:v1:',
          'project-memories:v1:',
          'project-model-routing:v1:',
          'project-schedules:v1:',
        ])
          this.db.prepare('DELETE FROM storage_meta WHERE key=?').run(prefix + key);
      }
      this.deleteCommands(new Set([key]));
      this.collectObjects();
    });
  }
  deleteRun(runId: string) {
    const run = this.get<any>('runs', runId);
    if (!run) return;
    const identifiers = new Set<string>([runId]);
    const streams: string[] = [];
    this.tx(() => {
      // Only selected legacy/invalidated pointers need their authoritative body expanded.
      for (const row of this.db
        .prepare(
          `SELECT content FROM requests WHERE run_id=? AND (json_type(data,'$.partialStreamRef') IS NULL OR
            EXISTS(SELECT 1 FROM request_log_pointer_dirty_v1 WHERE record_id=requests.id))`,
        )
        .iterate(runId) as Iterable<{ content: Uint8Array }>) {
        const ref = expand(row.content)?.manifest?.partialStreamRef;
        if (typeof ref === 'string') streams.push(ref);
      }
      for (const table of tables.filter((t) => !unscopedTables.has(t))) {
        for (const row of this.db
          .prepare(
            `SELECT id${
              table === 'requests'
                ? ",CASE WHEN NOT EXISTS(SELECT 1 FROM request_log_pointer_dirty_v1 WHERE record_id=requests.id) THEN json_extract(data,'$.partialStreamRef') END partialStreamRef"
                : ''
            } FROM ${table} WHERE run_id=?`,
          )
          .all(runId) as { id: string; partialStreamRef?: unknown }[]) {
          identifiers.add(row.id);
          if (table === 'requests' && typeof row.partialStreamRef === 'string')
            streams.push(row.partialStreamRef);
        }
      }
      this.db
        .prepare(
          'DELETE FROM task_edges WHERE task_id IN (SELECT id FROM tasks WHERE run_id=?) OR dependency_id IN (SELECT id FROM tasks WHERE run_id=?)',
        )
        .run(runId, runId);
      this.db.prepare('DELETE FROM events WHERE run_id=?').run(runId);
      for (const table of tables.filter((t) => !unscopedTables.has(t)))
        this.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(runId);
      this.deleteCommands(identifiers, runId);
      for (const key of identifiers) {
        this.db.prepare('DELETE FROM storage_meta WHERE key=?').run(`terminal-session:${key}`);
        this.db.prepare('DELETE FROM storage_meta WHERE key=?').run(`terminal-runtime:${key}`);
        this.db.prepare('DELETE FROM storage_meta WHERE key=?').run(`task-working-state:v1:${runId}:${key}`);
      }
      const runCacheKeys = new Set([
        `draft:run:${runId}`,
        `pinned:run:${runId}`,
        `unread:run:${runId}`,
        `draft:terminal-continuation:${runId}`,
        `draft:terminal-communication:${runId}`,
        `draft:terminal-resolution:${runId}`,
        `draft:terminal-send:${runId}`,
        `draft:handoff:${runId}`,
        `draft:delivery-review:${runId}`,
        `draft:source-resolutions:${runId}`,
      ]);
      for (const row of this.db
        .prepare("SELECT key FROM storage_meta WHERE key LIKE 'workbench:v1:%'")
        .all() as { key: string }[]) {
        const cacheKey = row.key.slice('workbench:v1:'.length);
        if (
          runCacheKeys.has(cacheKey) ||
          cacheKey.startsWith(`draft:terminal-recovery:${runId}:`) ||
          cacheKey.startsWith(`draft:working-state:${runId}:`)
        ) {
          this.db.prepare('DELETE FROM storage_meta WHERE key=?').run(row.key);
          this.db.prepare('DELETE FROM storage_meta WHERE key=?').run(`workbench-index:v1:${cacheKey}`);
        }
      }
      this.db.prepare('DELETE FROM runs WHERE id=?').run(runId);
      this.collectObjects();
    });
    for (const ref of streams) {
      const file = path.resolve(this.directory, ref);
      if (
        /^logs[\\/][a-f0-9-]+\.stream\.jsonl$/.test(ref) &&
        file.startsWith(path.resolve(this.directory, 'logs') + path.sep) &&
        existsSync(file)
      )
        rmSync(file);
    }
  }
  private deleteCommands(identifiers: Set<string>, runId?: string) {
    const candidates = this.objectReferences?.commandCandidates(identifiers, runId);
    const rows = candidates
      ? [...candidates].map((key) =>
          this.db.prepare('SELECT id,result,content,run_refs FROM commands WHERE id=?').get(key),
        )
      : this.db.prepare('SELECT id,result,content,run_refs FROM commands').all();
    for (const row of rows as any[]) {
      const result = row.content ? expand(row.content) : JSON.parse(row.result);
      if ((runId && JSON.parse(row.run_refs).includes(runId)) || references(result, identifiers))
        this.db.prepare('DELETE FROM commands WHERE id=?').run(row.id);
    }
  }
  private collectObjects() {
    const retained = this.objectReferences?.roots() ?? new Set<string>();
    const library = this.db.prepare("SELECT value FROM storage_meta WHERE key='local-agents:v1'").get() as
      | { value: string }
      | undefined;
    if (library) objectRefs(JSON.parse(library.value), retained);
    if (!this.objectReferences)
      for (const table of tables)
        for (const row of this.db.prepare(`SELECT content FROM ${table}`).all() as any[])
          objectRefs(expand(row.content), retained);
    if (!this.objectReferences)
      for (const row of this.db
        .prepare('SELECT content FROM events UNION ALL SELECT content FROM commands')
        .all() as any[])
        objectRefs(expand(row.content), retained);
    for (const row of this.db.prepare('SELECT object_ref FROM project_delivery_archives_v1').all() as {
      object_ref: string;
    }[])
      objectRefs(row.object_ref, retained, 'objectRef');
    const queue = [...retained];
    for (let i = 0; i < queue.length; i++) {
      const row = this.db
        .prepare('SELECT hash,raw_size,content FROM compressed_objects WHERE ref=?')
        .get(queue[i]) as any;
      if (!row) {
        if (sqliteObjectPattern.test(queue[i]))
          throw new AppError('OBJECT_NOT_FOUND', '引用对象缺失，已停止回收');
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = gunzipSync(row.content);
      } catch {
        throw new AppError('OBJECT_CORRUPT', '引用对象正文损坏，已停止回收');
      }
      const digest = hash(bytes);
      if (
        bytes.length !== row.raw_size ||
        digest !== row.hash ||
        digest !== (sqliteObjectPattern.test(queue[i]) ? queue[i].slice(7) : path.basename(queue[i]))
      )
        throw new AppError('OBJECT_CORRUPT', '引用对象完整性检查失败，已停止回收');
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        continue;
      }
      for (const ref of objectRefs(value))
        if (!retained.has(ref)) {
          retained.add(ref);
          queue.push(ref);
        }
    }
    for (const row of this.db.prepare('SELECT ref FROM compressed_objects').all() as any[])
      if (!retained.has(row.ref)) this.db.prepare('DELETE FROM compressed_objects WHERE ref=?').run(row.ref);
  }
  object(content: string | Buffer): { hash: string; objectRef: string } {
    if (typeof content === 'string') {
      const bytes = Buffer.from(content),
        digest = hash(bytes),
        ref = 'sqlite:' + digest;
      this.db
        .prepare('INSERT OR IGNORE INTO compressed_objects VALUES(?,?,?,?)')
        .run(ref, digest, bytes.length, gzipSync(bytes, { level: 6 }));
      return { hash: digest, objectRef: ref };
    }
    const digest = hash(content),
      ref = path.join('objects', digest.slice(0, 2), digest);
    const target = path.join(this.directory, ref);
    mkdirSync(path.dirname(target), { recursive: true });
    if (!existsSync(target)) {
      const tmp = target + '.' + id() + '.tmp';
      writeFileSync(tmp, content, { flag: 'wx' });
      renameSync(tmp, target);
    }
    return { hash: digest, objectRef: ref };
  }
  publishFileObject(source: string, expected: { hash: string; size: number }, signal?: AbortSignal) {
    return publishFileObject(this.directory, source, expected, signal);
  }
  readObject(ref: string): Buffer {
    if (!legacyObjectPattern.test(ref) && !sqliteObjectPattern.test(ref))
      throw new AppError('INVALID_OBJECT', '无效对象引用');
    const compressed = this.db
      .prepare('SELECT hash,raw_size,content FROM compressed_objects WHERE ref=?')
      .get(ref) as any;
    if (compressed) {
      const data = gunzipSync(compressed.content);
      if (data.length !== compressed.raw_size || hash(data) !== compressed.hash)
        throw new AppError('OBJECT_CORRUPT', '对象哈希不匹配');
      return data;
    }
    if (sqliteObjectPattern.test(ref))
      throw new AppError('OBJECT_NOT_FOUND', '压缩对象不存在', false, null, 404);
    const file = path.join(this.directory, ref),
      real = realpathSync(file),
      root = realpathSync(path.join(this.directory, 'objects'));
    if (!real.startsWith(root + path.sep)) throw new AppError('INVALID_OBJECT', '对象越界');
    const data = readFileSync(real);
    if (hash(data) !== path.basename(ref)) throw new AppError('OBJECT_CORRUPT', '对象哈希不匹配');
    return data;
  }
  onClose(hook: () => void) {
    if (this.closed) {
      hook();
      return () => {};
    }
    this.closeHooks.add(hook);
    return () => {
      this.closeHooks.delete(hook);
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    let failure: unknown;
    for (const hook of this.closeHooks) {
      try {
        hook();
      } catch (error) {
        failure ??= error;
      }
    }
    this.closeHooks.clear();
    this.requestReadProjectionUpdate = undefined;
    try {
      this.searchWork.close();
    } finally {
      this.db.close();
    }
    if (failure) throw failure;
  }
}
export function acquireLock(directory: string) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'service.lock');
  const token = id();
  if (existsSync(file)) {
    let previous: any;
    try {
      previous = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new AppError('LOCK_UNCERTAIN', '服务锁损坏，请核验后移走 service.lock');
    }
    let alive = true;
    try {
      process.kill(previous.pid, 0);
    } catch (e: any) {
      if (e.code === 'ESRCH') alive = false;
    }
    if (alive) throw new AppError('SERVICE_RUNNING', `数据目录已被进程 ${previous.pid} 锁定`);
    rmSync(file);
  }
  writeFileSync(file, stable({ pid: process.pid, token, startedAt: now() }), { flag: 'wx', mode: 0o600 });
  return () => {
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).token === token) rmSync(file);
  };
}
