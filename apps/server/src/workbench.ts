import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { AppError, invariant } from '../../../packages/contracts/src/index.js';
import { hash, type Store } from '../../../packages/storage/src/index.js';

const prefix = 'workbench:v1:';
const maxEntries = 4096;
const maxTotalBytes = 16 * 1024 * 1024;
// JSON escaping can use six bytes for each character in a 200,000-character draft.
const maxEntryBytes = 2 * 1024 * 1024;
const maxEncodedBytes = Math.ceil(maxEntryBytes / 3) * 4 + 1024;
const fixedKeys = new Set([
  'draft:chat',
  'collapsed:sidebar',
  'collapsed:projects',
  'collapsed:chats',
  'collapsed:pinned',
  'settings:selected-terminal-profile',
]);
const entityKey = /^(draft:(project|run)|collapsed:project|pinned:run|unread:run):([^:\s/\\]+)$/;
const terminalSelectionKey = /^settings:selected-terminal-profile:([^:\s/\\]+)$/;
const keySchema = z
  .string()
  .max(240)
  .refine(
    (key) => fixedKeys.has(key) || entityKey.test(key) || terminalSelectionKey.test(key),
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

function reference(key: string): { table: 'projects' | 'runs'; id: string } | undefined {
  const selection = terminalSelectionKey.exec(key);
  if (selection && selection[1] !== 'home') return { table: 'projects', id: selection[1] };
  const match = entityKey.exec(key);
  if (!match) return;
  return { table: match[1].endsWith('project') ? 'projects' : 'runs', id: match[3] };
}

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

export function registerWorkbench(app: FastifyInstance, store: Store) {
  // Store.directory is already resolved with realpathSync, including directory links.
  const directory = path.normalize(path.resolve(store.directory));
  const scope = hash(`workbench:v1:${process.platform === 'win32' ? directory.toLowerCase() : directory}`);
  const exists = ({ table, id }: { table: 'projects' | 'runs'; id: string }) =>
    !!store.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id);
  const rows = () =>
    store.db
      .prepare('SELECT key,value FROM storage_meta WHERE key LIKE ? ORDER BY key')
      .all(prefix + '%') as Row[];
  const prune = (entries: Row[]) =>
    entries.filter((row) => {
      const key = row.key.slice(prefix.length);
      if (!keySchema.safeParse(key).success)
        throw new AppError('WORKBENCH_CORRUPT', '工作台缓存键损坏，已有草稿已保留', false, null, 500);
      const entity = reference(key);
      if (!entity || exists(entity)) return true;
      store.db.prepare('DELETE FROM storage_meta WHERE key=?').run(row.key);
      return false;
    });

  app.get('/api/workbench', () =>
    store.tx(() => {
      const saved = prune(rows());
      capacity(saved.length, 0);
      const entries: Record<string, Entry> = {};
      let bytes = 0;
      for (const row of saved) {
        const decoded = decode(row);
        bytes += decoded.bytes;
        capacity(saved.length, bytes);
        entries[row.key.slice(prefix.length)] = decoded.entry;
      }
      return { scope, entries };
    }),
  );

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
      const currentRevision = previous ? decode(previous).entry.revision : 0;
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
      let bytes = raw.length;
      for (const row of saved) if (row !== previous) bytes += decode(row).bytes;
      capacity(saved.length + (previous ? 0 : 1), bytes);
      const value = gzipSync(raw, { level: 6 }).toString('base64');
      store.db
        .prepare(
          'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(prefix + key, value);
      return entry;
    });
  });
}
