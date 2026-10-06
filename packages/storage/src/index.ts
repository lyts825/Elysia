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
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    this.migrate();
  }
  migrate() {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if (version > 1) throw new AppError('SCHEMA_TOO_NEW', '数据库版本比应用新，请恢复相容备份');
    if (version === 1) return;
    this.tx(() => {
      for (const table of tables)
        this.db.exec(
          `CREATE TABLE ${table}(id TEXT PRIMARY KEY, run_id TEXT ${['projects', 'providers', 'runs'].includes(table) ? '' : 'REFERENCES runs(id)'}, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))); CREATE INDEX ${table}_run ON ${table}(run_id);`,
        );
      this.db.exec(
        `CREATE TABLE events(run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, event_id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, task_id TEXT, attempt_id TEXT, payload TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY(run_id, seq)); CREATE TABLE task_edges(task_id TEXT NOT NULL REFERENCES tasks(id), dependency_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(task_id, dependency_id)); CREATE TABLE commands(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL); CREATE UNIQUE INDEX attempt_active ON attempts(json_extract(data,'$.taskId')) WHERE json_extract(data,'$.status') IN ('ACTIVE','WAITING'); CREATE UNIQUE INDEX message_order ON messages(json_extract(data,'$.sessionId'),json_extract(data,'$.ordinal')); PRAGMA user_version=1;`,
      );
    });
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
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(key) as any;
    return row && this.hydrate(table, JSON.parse(row.data));
  }
  require<T>(table: Table, key: string): T {
    const value = this.get<T>(table, key);
    if (!value) throw new AppError('NOT_FOUND', `${table} 记录不存在`, false, null, 404);
    return value;
  }
  all<T>(table: Table, runId?: string): T[] {
    return (
      runId
        ? this.db.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid`).all(runId)
        : this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all()
    ).map((r: any) => this.hydrate(table, JSON.parse(r.data)));
  }
  private hydrate(table: Table, entity: any) {
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
      stored.contentRef = this.object(
        stable({
          text: stored.text,
          calls: stored.calls,
          callId: stored.callId,
          reasoningContent: stored.reasoningContent,
        }),
      ).objectRef;
      if (stored.native) stored.providerNativeRef = this.object(stable(stored.native)).objectRef;
      for (const key of ['text', 'calls', 'callId', 'reasoningContent', 'native']) delete stored[key];
      Object.assign(next, { contentRef: stored.contentRef, providerNativeRef: stored.providerNativeRef });
    }
    this.db
      .prepare(
        `INSERT INTO ${table}(id,run_id,revision,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,revision=excluded.revision,data=excluded.data`,
      )
      .run(next.id, next.runId ?? null, next.revision, stable(stored));
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
    const serialized = stable(payload);
    const persistedPayload =
      Buffer.byteLength(serialized) > 32768
        ? stable({ externalPayloadRef: this.object(serialized).objectRef })
        : serialized;
    this.db
      .prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)')
      .run(runId, seq, e.eventId, type, taskId, attemptId, persistedPayload, e.occurredAt);
    return e;
  }
  events(runId: string, after = 0): Event[] {
    return this.db
      .prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 1000')
      .all(runId, after)
      .map((r: any) => ({
        runId: r.run_id,
        seq: r.seq,
        eventId: r.event_id,
        type: r.type,
        taskId: r.task_id,
        attemptId: r.attempt_id,
        payload: this.eventPayload(r.payload),
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
        return JSON.parse(old.result);
      }
      const result = fn();
      this.db.prepare('INSERT INTO commands VALUES(?,?,?)').run(commandId, fingerprint, stable(result));
      return result;
    });
  }
  object(content: string | Buffer): { hash: string; objectRef: string } {
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
    if (!/^objects[\\/][a-f0-9]{2}[\\/][a-f0-9]{64}$/.test(ref))
      throw new AppError('INVALID_OBJECT', '无效对象引用');
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
