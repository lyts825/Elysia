/**
 * 维护存储对象引用的投影，供引用查询和维护使用。
 * EN: Maintain object-reference projections used by lookup and storage maintenance.
 *
 * 以引用投影支持对象可达性查询及清理前核对；投影更新与业务记录的关系由写入路径维护，不直接删除对象正文。
 * EN: Support reachability queries and cleanup checks through reference projections maintained by write paths, without directly deleting object contents.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

/**
 * 计算稳定字符串的SHA-256摘要，供引用投影和命令token一致性核验。
 * EN: Hash a stable string with SHA-256 for reference projections and command tokens.
 */
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const emptyHash = digest('[]');
type Source = { table: string; key: string };

/**
 * 权威正文写入会使派生引用根失效，包括其他SQLite连接的写入。
 * EN: Authoritative body writes invalidate derived reference roots, including writes from other
 * SQLite connections.
 */
export class ObjectReferenceProjection {
  private sources: Source[];
  /**
   * 注册实体、事件和命令的引用来源；触发器使正文写入立即失效旧投影。
   * expand 与 refs 由 Store 注入，让本模块只负责索引生命周期，不重定义正文或引用格式。
   * EN: Register entity, event, and command reference sources; triggers invalidate old projections on
   * body changes. Store injects expand and refs so this module manages index lifecycle without
   * redefining body or reference formats.
   */
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
  /**
   * 递归索引命令正文的字符串摘要，以便快速筛选可能引用指定标识的命令。
   * EN: Recursively index digests of strings in command bodies to quickly select commands that may
   * reference a requested identifier.
   */
  private commandTokens(commandId: string, value: unknown) {
    const tokens = new Set<string>();
    /**
     * 遍历命令正文中的字符串并存摘要，数组与对象递归，其他值不建token。
     * EN: Traverse command strings into digested tokens, recursing through arrays/objects and ignoring other values.
     */
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
  /**
   * 对引用排序后保存内容、数量与摘要，便于后续发现投影损坏。
   * EN: Sort references and persist their content, count, and digest so later reads can detect
   * projection corruption.
   */
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
  /**
   * 只展开缺失投影的来源行；写入失败保留缺失状态，回收流程不能假定这些行没有引用。
   * EN: Expand only source rows missing a projection. Failed writes remain missing; collection must
   * not assume those rows have no references.
   */
  private warm(source: Source) {
    for (const row of this.db
      .prepare(
        `SELECT s.${source.key} id,s.content FROM ${source.table} s
      WHERE NOT EXISTS(SELECT 1 FROM object_reference_projection_v1 p WHERE p.source_table=? AND p.record_id=s.${source.key})`,
      )
      .iterate(source.table) as Iterable<{ id: string; content: Uint8Array }>)
      this.write(source.table, row.id, this.expand(row.content));
  }
  /**
   * 枚举应保留的对象引用。先补齐缺失投影，再核对引用格式、数量和摘要；
   * 投影异常时从原文重建，原文不可用则停止回收，避免误删对象。
   * EN: Enumerate retained object references after warming missing projections. Validate reference
   * format, count, and digest; rebuild invalid projections from authoritative bodies and stop
   * collection if those bodies cannot be read.
   */
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
  /**
   * 按标识摘要及可选运行 ID 筛选候选命令；结果仍需调用方读取原文确认。
   * EN: Select candidate commands by identifier digests and optional run ID; callers must still
   * inspect authoritative bodies.
   */
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
      // 分批查询以限制单条 SQL 的参数数量。
      // EN: Batch queries to bound the number of SQL parameters per statement.
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
