/**
 * 维护终端备份的索引。
 * 维护非秘密小索引、目录戳和分页版本，变化/选中才加载完整清单；删除墓碑胜过迟到扫描，目录存在不证明可恢复或可删除。
 * EN: Maintains the terminal backup index. Maintains nonsecret indexes/stamps/page versions, loading manifests on change/selection; tombstones outrank late scans and existence proves neither restore nor deletion eligibility.
 */
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import { AppError } from '../../../packages/contracts/src/index.js';
import {
  TerminalBackupHistoryItem,
  TerminalBackupPage,
} from '../../../packages/contracts/src/terminal-maintenance.js';
import { type Store, hash, stable } from '../../../packages/storage/src/index.js';
const prefix = 'terminal-maintenance:backup-index:',
  versionKey = 'terminal-maintenance:backup-index-revision';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const entrySchema = z
  .object({
    owner: z.string().regex(/^[a-f0-9]{32}$/),
    view: TerminalBackupHistoryItem,
    status: z.enum(['present', 'invalid', 'deleted']),
    stamp: z.string(),
  })
  .strict();
interface Options {
  signal?: AbortSignal;
}
/**
 * 采用小型非秘密读取索引；仅在变更或选中时加载完整会话/工作区清单。 维护终端备份历史索引，关联所有者和磁盘快照状态。
 * EN: Small nonsecret read index. Full session/workspace manifests are loaded only when changed or selected. Maintains backup history indexing with owner and disk-snapshot state.
 */
export class TerminalBackupIndex {
  /**
   * 绑定存储、当前 owner 及安全目录/清单读取能力，索引不持有完整私有会话正文。
   * EN: Binds Store, owner and safe directory/manifest readers without retaining full private session bodies in the index.
   */
  constructor(
    private store: Store,
    private owner: string,
    private resolve: (id: string | undefined, options: Options) => Promise<string>,
    private load: (id: string, options: Options) => Promise<TerminalBackupHistoryItem>,
  ) {}
  /**
   * 在目录索引处理边界检查调用方取消。
   * EN: Checks caller cancellation at index-processing boundaries.
   */
  private check(options: Options) {
    options.signal?.throwIfAborted();
  }
  /**
   * 读取持久全局备份索引版本，首次未建立时返回零。
   * EN: Reads the persistent global backup-index revision, defaulting to zero before initialization.
   */
  private version() {
    const row = this.store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(versionKey) as
      | { value: string }
      | undefined;
    return Number(row?.value ?? 0);
  }
  /**
   * 内容真正变化时在同一事务写索引和全局版本，分页游标据此识别目录变化。
   * EN: Writes changed index content and global revision in one transaction so page cursors detect catalog changes.
   */
  private write(id: string, value: z.infer<typeof entrySchema>) {
    const current = this.store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(prefix + id) as
        | { value: string }
        | undefined,
      serialized = stable(value);
    if (current?.value === serialized) return;
    this.store.tx(() => {
      this.store.db
        .prepare(
          'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(prefix + id, serialized);
      this.store.db
        .prepare(
          'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(versionKey, String(this.version() + 1));
    });
  }
  /**
   * 读取并严格校验单份索引的格式和 owner；不存在返回 undefined，未知格式/归属保留原文并抛冲突。
   * EN: Reads and validates one index entry's schema/owner; absent returns undefined, while unknown ownership/format remains preserved and throws conflict.
   */
  private entry(id: string) {
    const row = this.store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(prefix + id) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      const value = entrySchema.safeParse(JSON.parse(row.value));
      if (value.success && value.data.owner === this.owner) return value.data;
    } catch {}
    throw new AppError(
      'TERMINAL_BACKUP_INDEX_UNKNOWN',
      '快照索引归属或格式无法确认，内容保留，请检查数据维护记录',
      false,
      null,
      409,
    );
  }
  /**
   * 已逻辑删除的备份不能因扫描迟到结果重新出现，删除墓碑优先于旧读取。
   * EN: Logical-deletion tombstones outrank late scans so a deleted backup cannot reappear.
   */
  record(view: TerminalBackupHistoryItem, stamp: string) {
    if (this.entry(view.id)?.status === 'deleted') return;
    this.write(view.id, { owner: this.owner, view, status: 'present', stamp });
  }
  /**
   * 将已有索引改为 deleted 墓碑，并通过统一 write 推进目录版本，防止迟到扫描重新展示。
   * EN: Marks existing entries as deleted tombstones through versioned write, preventing late scans from resurrecting them.
   */
  deleted(id: string) {
    const entry = this.entry(id);
    if (entry) this.write(id, { ...entry, status: 'deleted' });
  }
  /**
   * 检查可核验索引是否为删除墓碑，不以磁盘目录是否存在代替逻辑状态。
   * EN: Checks verified logical deletion state rather than inferring it from directory existence.
   */
  isDeleted(id: string) {
    return this.entry(id)?.status === 'deleted';
  }
  /**
   * 扫描备份目录的轻量文件戳；只在戳变化或缺少有效索引时加载完整清单。 当前无法核验或已消失的条目标为 invalid，不以目录存在直接证明它可恢复或可删除。
   * EN: Scans lightweight directory stamps and loads manifests only for changed stamps or invalid/missing indexes. Unverifiable or missing entries become invalid; directory existence alone proves neither restoration nor deletion eligibility.
   */
  async refresh(options: Options = {}) {
    this.check(options);
    const root = await this.resolve(undefined, options);
    let handle: Dir | undefined;
    try {
      handle = await fs.opendir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const seen = new Set<string>();
    try {
      while (handle) {
        this.check(options);
        const name = await handle.read();
        if (!name) break;
        if (!UUID.test(name.name)) continue;
        if (seen.size >= 20000)
          throw new AppError('TERMINAL_BACKUP_LIMIT', '快照目录超出扫描上限，请缩小范围', false, null, 409);
        seen.add(name.name);
        const current = this.entry(name.name);
        if (current?.status === 'deleted') continue;
        try {
          const filename = await this.resolve(name.name, options),
            stat = await fs.lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw Error();
          const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          if (!current || current.status !== 'present' || current.stamp !== stamp) {
            const view = await this.load(name.name, options);
            this.check(options);
            this.record(view, stamp);
          }
        } catch (error) {
          this.check(options);
          if (current && current.status !== 'invalid')
            this.write(name.name, { ...current, status: 'invalid' });
        }
        await turn();
        this.check(options);
      }
    } finally {
      await handle?.close();
    }
    if (
      this.store.db
        .prepare('SELECT key FROM storage_meta WHERE key LIKE ? AND NOT json_valid(value) LIMIT 1')
        .get(prefix + '%')
    )
      throw new AppError('TERMINAL_BACKUP_INDEX_UNKNOWN', '快照索引格式无法确认，内容保留', false, null, 409);
    const missing = this.store.db
      .prepare(
        "SELECT key,value FROM storage_meta WHERE key LIKE ? AND json_extract(value,'$.status')='present'",
      )
      .all(prefix + '%') as { key: string; value: string }[];
    for (const row of missing) {
      this.check(options);
      const id = row.key.slice(prefix.length);
      if (!seen.has(id)) {
        const value = entrySchema.safeParse(JSON.parse(row.value));
        if (value.success && value.data.owner === this.owner)
          this.write(id, { ...value.data, status: 'invalid' });
      }
      await turn();
    }
  }
  /**
   * 刷新索引后按创建时间和 ID 稳定倒序分页。游标绑定索引版本和搜索词， 目录或查询变化时要求回到最新页，防止将两次结果集拼成看似完整的历史。
   * EN: After refresh, pages stably by creation time and ID descending. Cursors bind index revision and search text; catalog/query changes require the latest page to avoid combining different result sets.
   */
  async page(input: unknown, options: Options = {}) {
    const query = z
      .object({
        query: z.string().trim().max(200).default(''),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().max(2000).optional(),
      })
      .strict()
      .parse(input);
    await this.refresh(options);
    this.check(options);
    const revision = hash(stable({ owner: this.owner, revision: this.version() })),
      queryHash = hash(query.query),
      cursorSchema = z
        .object({
          revision: z.string(),
          queryHash: z.string(),
          createdAt: z.string().datetime(),
          id: z.string().uuid(),
        })
        .strict();
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      try {
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
      } catch {
        throw new AppError('TERMINAL_BACKUP_CURSOR', '快照页游标无效，请返回最新', false, null, 400);
      }
      if (cursor.revision !== revision || cursor.queryHash !== queryHash)
        throw new AppError('TERMINAL_BACKUP_STALE', '快照目录已变化，请返回最新页', false, null, 409);
    }
    const match =
      "key LIKE ? AND json_extract(value,'$.owner')=? AND json_extract(value,'$.status')='present' AND instr(lower(json_extract(value,'$.view.title')||' '||json_extract(value,'$.view.runId')||' '||json_extract(value,'$.view.taskId')||' '||json_extract(value,'$.view.id')||' '||json_extract(value,'$.view.createdAt')),lower(?))>0";
    const values = [prefix + '%', this.owner, query.query];
    const total = Number(
      (
        this.store.db.prepare(`SELECT count(*) AS count FROM storage_meta WHERE ${match}`).get(...values) as {
          count: number;
        }
      ).count,
    );
    const tail = cursor
      ? " AND (json_extract(value,'$.view.createdAt')<? OR (json_extract(value,'$.view.createdAt')=? AND json_extract(value,'$.view.id')<?))"
      : '';
    const rows = this.store.db
      .prepare(
        `SELECT value FROM storage_meta WHERE ${match}${tail} ORDER BY json_extract(value,'$.view.createdAt') DESC,json_extract(value,'$.view.id') DESC LIMIT ?`,
      )
      .all(
        ...values,
        ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
        query.limit + 1,
      ) as { value: string }[];
    const entries = rows.map((row) => entrySchema.parse(JSON.parse(row.value)).view),
      hasMore = entries.length > query.limit,
      items = entries.slice(0, query.limit),
      last = items.at(-1);
    return TerminalBackupPage.parse({
      items,
      total,
      revision,
      page: {
        limit: query.limit,
        hasMore,
        nextCursor:
          hasMore && last
            ? Buffer.from(stable({ revision, queryHash, createdAt: last.createdAt, id: last.id })).toString(
                'base64url',
              )
            : null,
      },
    });
  }
}
