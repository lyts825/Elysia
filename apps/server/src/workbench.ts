/**
 * 汇总工作台范围内的数据并注册接口。
 * 白名单草稿/偏好采用作用域、版本和原始字节上限，大小索引可从正文重建；孤儿定向清理，损坏草稿报错保留。
 * EN: Aggregates workbench-scoped data and registers endpoints. Scopes/revisions/bounds allowlisted drafts/preferences by raw bytes with rebuildable indexes, targeted orphan cleanup and preserved damaged drafts.
 */
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { AppError, invariant } from '../../../packages/contracts/src/index.js';
import { hash, type Store } from '../../../packages/storage/src/index.js';

const prefix = 'workbench:v1:';
const indexPrefix = 'workbench-index:v1:';
const maxEntries = 4096;
const maxTotalBytes = 16 * 1024 * 1024;
/**
 * 200,000 字符草稿经 JSON 转义后，每字符最多可占六字节。
 * EN: JSON escaping can use six bytes for each character in a 200,000-character draft.
 */
const maxEntryBytes = 2 * 1024 * 1024;
const maxEncodedBytes = Math.ceil(maxEntryBytes / 3) * 4 + 1024;
const fixedKeys = new Set([
  'draft:chat',
  'draft:setup:chat',
  'collapsed:sidebar',
  'collapsed:projects',
  'collapsed:chats',
  'collapsed:pinned',
  'settings:selected-terminal-profile',
]);
const entityKey = /^(draft:(project|run)|collapsed:project|pinned:run|unread:run):([^:\s/\\]+)$/;
const terminalSelectionKey = /^settings:selected-terminal-profile:([^:\s/\\]+)$/;
const handoffDraftKey = /^draft:handoff:([^:\s/\\]+)$/;
const deliveryReviewDraftKey = /^draft:delivery-review:([^:\s/\\]+)$/;
const sourceResolutionDraftKey = /^draft:source-resolutions:([^:\s/\\]+)$/;
const projectSetupDraftKey = /^draft:setup:project:([^:\s/\\]+)$/;
const projectBoardDraftKey = /^draft:project-board:([^:\s/\\]+)$/;
const projectIntelligenceDraftKey = /^draft:project-intelligence:([^:\s/\\]+)$/;
const projectSchedulesDraftKey = /^draft:project-schedules:([^:\s/\\]+)$/;
const workingStateDraftKey = /^draft:working-state:([^:\s/\\]+):[a-f0-9-]{36}$/;
const terminalDraftKey =
  /^draft:terminal-(?:continuation|recovery|communication|send|resolution):([^:\s/\\]+)(?::[a-f0-9-]{36})?$/;
const keySchema = z
  .string()
  .max(240)
  .refine(
    (key) =>
      fixedKeys.has(key) ||
      entityKey.test(key) ||
      terminalSelectionKey.test(key) ||
      handoffDraftKey.test(key) ||
      deliveryReviewDraftKey.test(key) ||
      sourceResolutionDraftKey.test(key) ||
      projectSetupDraftKey.test(key) ||
      projectBoardDraftKey.test(key) ||
      projectIntelligenceDraftKey.test(key) ||
      projectSchedulesDraftKey.test(key) ||
      workingStateDraftKey.test(key) ||
      terminalDraftKey.test(key),
    '工作台缓存键无效',
  );
const valueSchema = z.union([z.string().max(200000), z.boolean()]);
const storedEntry = z
  .object({ value: valueSchema, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
  .strict();
const mutation = z
  .object({
    value: valueSchema,
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
type Entry = z.infer<typeof storedEntry>;
type Row = { key: string; value: string };

/**
 * 从白名单缓存键解析实体引用，用于实体删除后的定向清理，不能从任意键推导数据库表。
 * EN: Parses entity references only from allowlisted cache keys for targeted cleanup after deletion; arbitrary keys cannot name database tables.
 */
function reference(key: string): { table: 'projects' | 'runs'; id: string } | undefined {
  const schedules = projectSchedulesDraftKey.exec(key);
  if (schedules) return { table: 'projects', id: schedules[1] };
  const workingState = workingStateDraftKey.exec(key);
  if (workingState) return { table: 'runs', id: workingState[1] };
  const intelligence = projectIntelligenceDraftKey.exec(key);
  if (intelligence) return { table: 'projects', id: intelligence[1] };
  const board = projectBoardDraftKey.exec(key);
  if (board) return { table: 'projects', id: board[1] };
  const setup = projectSetupDraftKey.exec(key);
  if (setup) return { table: 'projects', id: setup[1] };
  const review = deliveryReviewDraftKey.exec(key);
  if (review) return { table: 'runs', id: review[1] };
  const resolution = sourceResolutionDraftKey.exec(key);
  if (resolution) return { table: 'runs', id: resolution[1] };
  const handoff = handoffDraftKey.exec(key);
  if (handoff) return { table: 'runs', id: handoff[1] };
  const terminalDraft = terminalDraftKey.exec(key);
  if (terminalDraft) return { table: 'runs', id: terminalDraft[1] };
  const selection = terminalSelectionKey.exec(key);
  if (selection && selection[1] !== 'home') return { table: 'projects', id: selection[1] };
  const match = entityKey.exec(key);
  if (!match) return;
  return { table: match[1].endsWith('project') ? 'projects' : 'runs', id: match[3] };
}

/**
 * 按缓存键区分草稿/模板文本与布尔偏好，模板选择另要求空值或 UUID；类型不符拒绝保存。
 * EN: Validates draft/template text versus boolean preferences by key, additionally requiring empty/UUID template selection and rejecting mismatched types.
 */
function assertValue(key: string, value: string | boolean) {
  const profile = key === 'settings:selected-terminal-profile' || terminalSelectionKey.test(key);
  const text = key.startsWith('draft:') || profile;
  invariant(
    typeof value === (text ? 'string' : 'boolean'),
    'WORKBENCH_VALUE',
    text ? '草稿和模板选择必须是文本' : '工作台显示选项必须是布尔值',
  );
  if (profile)
    invariant(
      value === '' || z.string().uuid().safeParse(value).success,
      'WORKBENCH_VALUE',
      '终端模板选择无效',
    );
}

/**
 * 校验规范 Base64、解压上限及值类型，返回实际原始字节用于容量统计。 损坏条目保留并明确报错，不能当作空草稿覆盖用户输入。
 * EN: Validates canonical Base64, decompression limits and value types and returns actual raw bytes for accounting. Damaged entries remain with explicit errors rather than overwriting drafts as empty.
 */
function decode(row: Row): { entry: Entry; bytes: number } {
  try {
    invariant(row.value.length <= maxEncodedBytes, 'WORKBENCH_CORRUPT', '工作台缓存条目过大');
    invariant(
      row.value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(row.value),
      'WORKBENCH_CORRUPT',
      '工作台缓存编码损坏',
    );
    const compressed = Buffer.from(row.value, 'base64');
    invariant(compressed.toString('base64') === row.value, 'WORKBENCH_CORRUPT', '工作台缓存编码损坏');
    const raw = gunzipSync(compressed, { maxOutputLength: maxEntryBytes });
    const entry = storedEntry.parse(JSON.parse(raw.toString('utf8')));
    assertValue(row.key.slice(prefix.length), entry.value);
    return { entry, bytes: raw.length };
  } catch {
    throw new AppError(
      'WORKBENCH_CORRUPT',
      '工作台缓存损坏，已有草稿已保留，请检查数据备份',
      false,
      null,
      500,
    );
  }
}

/**
 * 检查总条目和原始字节上限，超限返回 413 并保留已有草稿，不通过截断腾容量。
 * EN: Checks entry/raw-byte capacity and returns 413 while preserving existing drafts instead of truncating them.
 */
function capacity(count: number, bytes: number) {
  if (count > maxEntries || bytes > maxTotalBytes)
    throw new AppError(
      'WORKBENCH_CAPACITY',
      '工作台缓存已达到容量上限，请清空旧草稿或删除不再需要的项目/对话后重试；已有草稿已保留',
      false,
      { maxEntries, maxTotalBytes },
      413,
    );
}

/**
 * 按规范化的数据目录计算工作台作用域，Windows 路径比较忽略大小写。
 * EN: Derives workbench scope from the normalized data directory with case-insensitive Windows comparison.
 */
export function workbenchScope(store: Store) {
  /**
   * Store.directory 已通过 realpathSync 解析，包含目录链接。
   * EN: Store.directory is already resolved with realpathSync, including directory links.
   */
  const directory = path.normalize(path.resolve(store.directory));
  return hash(`workbench:v1:${process.platform === 'win32' ? directory.toLowerCase() : directory}`);
}
/**
 * 管理带版本的本地草稿和显示偏好。缓存键和值均受白名单及总容量限制， 保存用 expectedRevision 防止多窗口覆盖，派生大小索引在原文变化时失效并可重建。
 * EN: Manages revisioned local drafts/display preferences with allowlisted keys/values and total capacity limits. expectedRevision prevents multi-window overwrites; derived size indexes invalidate on raw changes and can be rebuilt.
 */
export function registerWorkbench(app: FastifyInstance, store: Store) {
  const scope = workbenchScope(store);
  /**
   * 旧版应用和管理删除同样会使派生大小失效。
   * EN: Older application versions and management deletes invalidate the derived sizes too.
   */
  for (const action of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    const row = action === 'DELETE' ? 'OLD' : 'NEW';
    store.db.exec(
      `CREATE TRIGGER IF NOT EXISTS workbench_index_${action.toLowerCase()} AFTER ${action} ON storage_meta WHEN ${row}.key LIKE 'workbench:v1:%' BEGIN DELETE FROM storage_meta WHERE key='workbench-index:v1:' || substr(${row}.key,14); END;`,
    );
  }
  /**
   * 通过白名单实体表和 ID 检查归属对象仍存在，不加载实体正文。
   * EN: Checks owner existence by allowlisted entity table/ID without loading bodies.
   */
  const exists = ({ table, id }: { table: 'projects' | 'runs'; id: string }) =>
    !!store.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id);
  /**
   * 按键稳定列出工作台命名空间的元数据条目，供容量和孤儿清理使用。
   * EN: Lists workbench metadata keys in stable order for capacity/orphan checks.
   */
  const rows = () =>
    store.db.prepare('SELECT key FROM storage_meta WHERE key LIKE ? ORDER BY key').all(prefix + '%') as {
      key: string;
    }[];
  /**
   * 仅删除已验证键且所属实体明确不存在的缓存及大小索引；未知格式抛错保留，避免清空用户草稿。
   * EN: Deletes cache/size indexes only for validated keys with definitely absent owners; unknown formats throw and remain preserved.
   */
  const prune = (entries: { key: string }[]) =>
    /**
     * 只移除所属项目/运行已不存在的条目；格式未知的键必须报错保留，不能无差别清空缓存。
     * EN: Removes only entries whose owning project/run no longer exists; unknown key formats error and remain instead of blanket clearing.
     */
    entries.filter((row) => {
      const key = row.key.slice(prefix.length);
      if (!keySchema.safeParse(key).success)
        throw new AppError('WORKBENCH_CORRUPT', '工作台缓存键损坏，已有草稿已保留', false, null, 500);
      const entity = reference(key);
      if (!entity || exists(entity)) return true;
      store.db.prepare('DELETE FROM storage_meta WHERE key=?').run(row.key);
      store.db.prepare('DELETE FROM storage_meta WHERE key=?').run(indexPrefix + key);
      return false;
    });
  /**
   * 读取并解码一条已定位缓存，实际字节与格式校验由 decode 统一完成。
   * EN: Reads/decodes one located cache entry through shared format and raw-byte validation.
   */
  const read = (key: string) =>
    decode(store.db.prepare('SELECT key,value FROM storage_meta WHERE key=?').get(key) as Row);
  /**
   * 保存由已解码正文证明的大小与版本冗余索引；索引键绑定原缓存键。
   * EN: Persists size/revision metadata derived from decoded bodies, keyed to the original cache entry.
   */
  const index = (key: string, decoded: { entry: Entry; bytes: number }) => {
    store.db
      .prepare(
        'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(
        indexPrefix + key.slice(prefix.length),
        JSON.stringify({ bytes: decoded.bytes, revision: decoded.entry.revision }),
      );
  };
  /**
   * 优先复用有效大小索引汇总容量；缺失或损坏时从保留正文重建，不以错误索引当零或覆盖正文。
   * EN: Totals capacity using valid size indexes, rebuilding missing/damaged metadata from retained bodies rather than treating faults as zero or overwriting content.
   */
  const totalBytes = (saved: { key: string }[]) => {
    /**
     * 可用大小索引避免每次写草稿解压全库；缺失/损坏的索引只从保留正文重建。
     * EN: Uses valid size indexes to avoid decompressing all drafts on each write; missing/damaged indexes rebuild only from retained bodies.
     */
    let total = 0;
    for (const row of saved) {
      const metadata = store.db
        .prepare('SELECT value FROM storage_meta WHERE key=?')
        .get(indexPrefix + row.key.slice(prefix.length)) as { value: string } | undefined;
      let bytes: number | undefined;
      try {
        const value = JSON.parse(metadata?.value ?? 'null');
        if (
          Number.isSafeInteger(value?.bytes) &&
          value.bytes > 0 &&
          value.bytes <= maxEntryBytes &&
          Number.isSafeInteger(value.revision) &&
          value.revision > 0
        )
          bytes = value.bytes;
      } catch {
        /**
         * 从保留的原条目重建冗余元数据。
         * EN: Rebuild redundant metadata from the preserved entry.
         */
      }
      if (bytes === undefined) {
        const decoded = read(row.key);
        index(row.key, decoded);
        bytes = decoded.bytes;
      }
      total += bytes;
    }
    return total;
  };

  app.get('/api/workbench', (request) => {
    const query = z
      .object({ view: z.literal('preferences').optional(), keys: z.string().max(15424).optional() })
      .strict()
      .parse(request.query);
    invariant(
      !query.view || query.keys === undefined,
      'WORKBENCH_READ_SELECTION',
      '请只指定一种缓存读取方式',
    );
    const keys =
      query.keys === undefined
        ? undefined
        : new Set(
            z
              .array(keySchema)
              .max(64)
              .parse(query.keys ? query.keys.split(',') : []),
          );
    return store.tx(() => {
      const saved = prune(rows());
      capacity(saved.length, 0);
      const entries: Record<string, Entry> = {};
      let bytes = 0;
      for (const row of saved) {
        const key = row.key.slice(prefix.length);
        if (query.view === 'preferences' && key.startsWith('draft:')) continue;
        if (keys && !keys.has(key)) continue;
        const decoded = read(row.key);
        index(row.key, decoded);
        bytes += decoded.bytes;
        capacity(saved.length, bytes);
        entries[row.key.slice(prefix.length)] = decoded.entry;
      }
      return { scope, entries, partial: !!query.view || keys !== undefined };
    });
  });

  app.put<{ Params: { key: string } }>('/api/workbench/:key', (request) => {
    const key = keySchema.parse(request.params.key);
    const body = mutation.parse(request.body);
    assertValue(key, body.value);
    return store.tx(() => {
      const entity = reference(key);
      if (entity && !exists(entity))
        throw new AppError('NOT_FOUND', '缓存关联的项目或对话不存在', false, null, 404);
      const saved = prune(rows());
      const previous = saved.find((row) => row.key === prefix + key);
      capacity(saved.length + (previous ? 0 : 1), 0);
      const current = previous ? read(previous.key) : undefined;
      const currentRevision = current?.entry.revision ?? 0;
      if (body.expectedRevision !== currentRevision)
        throw new AppError(
          'REVISION_CONFLICT',
          '工作台缓存已更新，请读取最新内容后重试',
          false,
          { currentRevision },
          409,
        );
      const entry = { value: body.value, revision: currentRevision + 1 };
      const raw = Buffer.from(JSON.stringify(entry));
      const bytes = raw.length + totalBytes(saved.filter((row) => row !== previous));
      capacity(saved.length + (previous ? 0 : 1), bytes);
      const value = gzipSync(raw, { level: 6 }).toString('base64');
      store.db
        .prepare(
          'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(prefix + key, value);
      index(prefix + key, { entry, bytes: raw.length });
      return entry;
    });
  });
}
