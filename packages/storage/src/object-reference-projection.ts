import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const emptyHash = digest('[]');
type Source = { table: string; key: string };

/** Derived roots are invalidated by authoritative body writes, including external SQLite writers. */
export class ObjectReferenceProjection {
  private sources: Source[];
  constructor(
    private db: DatabaseSync,
    tables: readonly string[],
    private expand: (body: Uint8Array) => unknown,
    private refs: (value: unknown) => Set<string>,
  ) {
    this.sources = [
      ...tables.map((table) => ({ table, key: 'id' })),
      { table: 'events', key: 'event_id' },
      { table: 'commands', key: 'id' },
    ];
    db.exec(`CREATE TABLE IF NOT EXISTS object_reference_projection_v1(
      source_table TEXT NOT NULL,record_id TEXT NOT NULL,refs_json TEXT NOT NULL CHECK(json_valid(refs_json)),
      refs_hash TEXT NOT NULL,ref_count INTEGER NOT NULL,PRIMARY KEY(source_table,record_id));
      CREATE TABLE IF NOT EXISTS command_reference_tokens_v1(command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
        token TEXT NOT NULL,PRIMARY KEY(command_id,token));
      CREATE INDEX IF NOT EXISTS command_reference_token ON command_reference_tokens_v1(token,command_id);
      CREATE TABLE IF NOT EXISTS command_reference_tokens_ready_v1(command_id TEXT PRIMARY KEY REFERENCES commands(id) ON DELETE CASCADE);`);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const aliases = operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW'];
      db.exec(`CREATE TRIGGER IF NOT EXISTS command_reference_tokens_${operation.toLowerCase()} AFTER ${operation} ON command_reference_tokens_v1
        BEGIN ${aliases.map((alias) => `DELETE FROM command_reference_tokens_ready_v1 WHERE command_id=${alias}.command_id;`).join(' ')} END;`);
    }
    for (const { table, key } of this.sources) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const alias = operation === 'DELETE' ? 'OLD' : 'NEW';
        db.exec(`CREATE TRIGGER IF NOT EXISTS object_reference_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
          ${operation === 'UPDATE' ? 'WHEN NEW.content IS NOT OLD.content' : ''}
          BEGIN DELETE FROM object_reference_projection_v1 WHERE source_table='${table}' AND record_id=${alias}.${key};
          ${
            table === 'commands'
              ? `DELETE FROM command_reference_tokens_v1 WHERE command_id=${alias}.${key};
            DELETE FROM command_reference_tokens_ready_v1 WHERE command_id=${alias}.${key};`
              : ''
          } END;`);
      }
    }
  }
  private commandTokens(commandId: string, value: unknown) {
    const tokens = new Set<string>();
    const visit = (item: unknown) => {
      if (typeof item === 'string') tokens.add(digest(JSON.stringify(item)));
      else if (Array.isArray(item)) for (const child of item) visit(child);
      else if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child);
    };
    visit(value);
    this.db.prepare('DELETE FROM command_reference_tokens_v1 WHERE command_id=?').run(commandId);
    const save = this.db.prepare('INSERT INTO command_reference_tokens_v1(command_id,token) VALUES(?,?)');
    for (const token of tokens) save.run(commandId, token);
    this.db.prepare('INSERT OR IGNORE INTO command_reference_tokens_ready_v1 VALUES(?)').run(commandId);
  }
  write(table: string, key: string, value: unknown) {
    const refs = [...this.refs(value)].sort(),
      json = JSON.stringify(refs);
    this.db
      .prepare(
        `INSERT INTO object_reference_projection_v1(source_table,record_id,refs_json,refs_hash,ref_count) VALUES(?,?,?,?,?)
      ON CONFLICT(source_table,record_id) DO UPDATE SET refs_json=excluded.refs_json,refs_hash=excluded.refs_hash,ref_count=excluded.ref_count`,
      )
      .run(table, key, json, digest(json), refs.length);
    if (table === 'commands') this.commandTokens(key, value);
  }
  private warm(source: Source) {
    for (const row of this.db
      .prepare(
        `SELECT s.${source.key} id,s.content FROM ${source.table} s
      WHERE NOT EXISTS(SELECT 1 FROM object_reference_projection_v1 p WHERE p.source_table=? AND p.record_id=s.${source.key})`,
      )
      .iterate(source.table) as Iterable<{ id: string; content: Uint8Array }>)
      this.write(source.table, row.id, this.expand(row.content));
  }
  roots() {
    for (const source of this.sources) this.warm(source);
    const retained = new Set<string>();
    const rows = this.db
      .prepare(
        `SELECT source_table,record_id,refs_json,refs_hash,ref_count FROM object_reference_projection_v1
      WHERE refs_json<>'[]' OR refs_hash<>? OR ref_count<>0`,
      )
      .all(emptyHash) as {
      source_table: string;
      record_id: string;
      refs_json: string;
      refs_hash: string;
      ref_count: number;
    }[];
    for (const row of rows) {
      let refs: unknown;
      try {
        refs = JSON.parse(row.refs_json);
      } catch {}
      if (
        !Array.isArray(refs) ||
        refs.some(
          (ref) =>
            typeof ref !== 'string' ||
            !/^(?:sqlite:[a-f0-9]{64}|objects[\\/][a-f0-9]{2}[\\/][a-f0-9]{64})$/.test(ref),
        ) ||
        refs.length !== row.ref_count ||
        digest(row.refs_json) !== row.refs_hash
      ) {
        const source = this.sources.find((s) => s.table === row.source_table);
        if (!source) throw new Error('对象引用投影来源无法核验，停止回收');
        const original = this.db
          .prepare(`SELECT content FROM ${source.table} WHERE ${source.key}=?`)
          .get(row.record_id) as { content: Uint8Array } | undefined;
        if (!original) throw new Error('对象引用投影原文缺失，停止回收');
        const value = this.expand(original.content);
        this.write(source.table, row.record_id, value);
        refs = [...this.refs(value)];
      }
      for (const ref of refs as string[]) retained.add(ref);
    }
    return retained;
  }
  commandCandidates(identifiers: Set<string>, runId?: string) {
    for (const row of this.db
      .prepare(
        `SELECT c.id,c.content FROM commands c
      WHERE NOT EXISTS(SELECT 1 FROM command_reference_tokens_ready_v1 p WHERE p.command_id=c.id)`,
      )
      .iterate() as Iterable<{ id: string; content: Uint8Array }>)
      this.write('commands', row.id, this.expand(row.content));
    const candidates = new Set<string>(),
      values = [...identifiers].map((value) => digest(JSON.stringify(value)));
    for (let start = 0; start < values.length; start += 500) {
      const batch = values.slice(start, start + 500);
      for (const row of this.db
        .prepare(
          `SELECT DISTINCT command_id FROM command_reference_tokens_v1 WHERE token IN (${batch.map(() => '?').join(',')})`,
        )
        .all(...batch) as { command_id: string }[])
        candidates.add(row.command_id);
    }
    if (runId)
      for (const row of this.db
        .prepare(`SELECT id FROM commands c WHERE EXISTS(SELECT 1 FROM json_each(c.run_refs) WHERE value=?)`)
        .all(runId) as { id: string }[])
        candidates.add(row.id);
    return candidates;
  }
}
