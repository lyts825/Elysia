/** 汇总工作台范围内的数据并注册接口。 */
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
// JSON escaping can use six bytes for each character in a 200,000-character draft.
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

export function workbenchScope(store: Store) {
  // Store.directory is already resolved with realpathSync, including directory links.
  const directory = path.normalize(path.resolve(store.directory));
  return hash(`workbench:v1:${process.platform === 'win32' ? directory.toLowerCase() : directory}`);
}
export function registerWorkbench(app: FastifyInstance, store: Store) {
  const scope = workbenchScope(store);
  // Older application versions and management deletes invalidate the derived sizes too.
  for (const action of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    const row = action === 'DELETE' ? 'OLD' : 'NEW';
    store.db.exec(
      `CREATE TRIGGER IF NOT EXISTS workbench_index_${action.toLowerCase()} AFTER ${action} ON storage_meta WHEN ${row}.key LIKE 'workbench:v1:%' BEGIN DELETE FROM storage_meta WHERE key='workbench-index:v1:' || substr(${row}.key,14); END;`,
    );
  }
  const exists = ({ table, id }: { table: 'projects' | 'runs'; id: string }) =>
    !!store.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id);
  const rows = () =>
    store.db.prepare('SELECT key FROM storage_meta WHERE key LIKE ? ORDER BY key').all(prefix + '%') as {
      key: string;
    }[];
  const prune = (entries: { key: string }[]) =>
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
  const read = (key: string) =>
    decode(store.db.prepare('SELECT key,value FROM storage_meta WHERE key=?').get(key) as Row);
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
  const totalBytes = (saved: { key: string }[]) => {
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
        /* Rebuild redundant metadata from the preserved entry. */
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
