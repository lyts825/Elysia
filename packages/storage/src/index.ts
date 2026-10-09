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
import { AppError, type Entity, type Event } from '../../contracts/src/index.js';
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
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
function projection(table: Table, entity: any) {
  return stable({
    id: entity.id,
    runId: entity.runId,
    revision: entity.revision,
    ...(table === 'attempts' ? { taskId: entity.taskId, status: entity.status } : {}),
    ...(table === 'messages' ? { sessionId: entity.sessionId, ordinal: entity.ordinal } : {}),
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
  db: DatabaseSync;
  directory: string;
  private depth = 0;
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
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  migrate() {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if (version > 3) throw new AppError('SCHEMA_TOO_NEW', '数据库版本比应用新，请恢复相容备份');
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
    return row && this.hydrate(table, row.content ? expand(row.content) : JSON.parse(row.data));
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
    ).map((r: any) => this.hydrate(table, r.content ? expand(r.content) : JSON.parse(r.data)));
  }
  private hydrate(table: Table, entity: any) {
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
    return entity;
  }
  put<T extends Entity>(table: Table, entity: T, expectedRevision?: number): T {
    const previous = this.get<Entity>(table, entity.id);
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
    if (table === 'messages') {
      delete stored.contentRef;
      delete stored.providerNativeRef;
      delete (next as any).contentRef;
      delete (next as any).providerNativeRef;
    }
    this.db
      .prepare(
        `INSERT INTO ${table}(id,run_id,revision,data,content) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,revision=excluded.revision,data=excluded.data,content=excluded.content`,
      )
      .run(next.id, next.runId ?? null, next.revision, projection(table, stored), compress(stored));
    return next;
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
    this.db
      .prepare(
        'INSERT INTO events(run_id,seq,event_id,type,task_id,attempt_id,payload,occurred_at,content) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(runId, seq, e.eventId, type, taskId, attemptId, '{}', e.occurredAt, compress(payload));
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
        const match = /^\/api\/runs\/([^/?]+)/.exec(value.route);
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
      for (const table of tables.filter((t) => !unscopedTables.has(t))) {
        for (const row of this.all<any>(table, runId)) {
          identifiers.add(row.id);
          if (table === 'requests' && typeof row.manifest?.partialStreamRef === 'string')
            streams.push(row.manifest.partialStreamRef);
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
    for (const row of this.db.prepare('SELECT id,result,content,run_refs FROM commands').all() as any[]) {
      const result = row.content ? expand(row.content) : JSON.parse(row.result);
      if ((runId && JSON.parse(row.run_refs).includes(runId)) || references(result, identifiers))
        this.db.prepare('DELETE FROM commands WHERE id=?').run(row.id);
    }
  }
  private collectObjects() {
    const retained = new Set<string>();
    for (const table of tables)
      for (const row of this.db.prepare(`SELECT content FROM ${table}`).all() as any[])
        objectRefs(expand(row.content), retained);
    for (const row of this.db
      .prepare('SELECT content FROM events UNION ALL SELECT content FROM commands')
      .all() as any[])
      objectRefs(expand(row.content), retained);
    const queue = [...retained];
    for (let i = 0; i < queue.length; i++) {
      const row = this.db.prepare('SELECT content FROM compressed_objects WHERE ref=?').get(queue[i]) as any;
      if (!row) continue;
      let value: unknown;
      try {
        value = JSON.parse(gunzipSync(row.content).toString('utf8'));
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
  close() {
    this.db.close();
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
