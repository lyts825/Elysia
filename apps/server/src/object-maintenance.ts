import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hash, now, tables, STORAGE_SCHEMA_VERSION } from '../../../packages/storage/src/index.js';
import { VERSION } from '../../../packages/contracts/src/index.js';
import {
  assertDirectory,
  assertSurfacePath,
  surfaceDirectory,
  type Selection,
  type Surface,
} from './maintenance-storage.js';

const objectPattern = /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const candidateSchema = z
  .object({
    ref: z.string().regex(objectPattern),
    bytes: z.number().int().nonnegative(),
    identity: digest,
  })
  .strict();
export const ObjectCleanupPlan = z
  .object({
    kind: z.literal('elysia-object-cleanup'),
    format: z.literal(1),
    appVersion: z.string(),
    createdAt: z.string().datetime(),
    scope: digest,
    surfaces: z
      .array(
        z
          .object({
            surface: z.enum(['native', 'terminal']),
            database: digest,
            candidates: z.array(candidateSchema).max(1000),
            candidateBytes: z.number().int().nonnegative(),
            truncated: z.boolean(),
            retained: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();
type Candidate = z.infer<typeof candidateSchema>;
type Plan = z.infer<typeof ObjectCleanupPlan>;

function identity(file: string, database = false) {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    throw new Error('对象维护不能处理链接或特殊文件');
  return hash(database ? `${stat.dev}:${stat.ino}` : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`);
}

// Retain every object-looking string, including objects referenced by retained historical
// snapshots and compressed text. This deliberately errs on the side of keeping extra files.
function references(value: unknown, retained: Set<string>) {
  if (typeof value === 'string') {
    const ref = value.replaceAll('\\', '/');
    if (objectPattern.test(ref)) retained.add(ref);
  } else if (Array.isArray(value)) {
    for (const item of value) references(item, retained);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) references(item, retained);
  }
}

function readReferences(directory: string) {
  const filename = path.join(directory, 'state.db');
  const databaseIdentity = identity(filename, true);
  const database = new DatabaseSync(filename, { readOnly: true });
  const retained = new Set<string>();
  try {
    const version = Number((database.prepare('PRAGMA user_version').get() as any).user_version);
    if (version !== STORAGE_SCHEMA_VERSION) throw new Error('对象维护要求当前数据格式，请先执行 db:migrate');
    const check = database.prepare('PRAGMA quick_check').all() as any[];
    if (check.length !== 1 || check[0].quick_check !== 'ok') throw new Error('数据库完整性检查失败');
    for (const table of [...tables, 'events', 'commands']) {
      for (const row of database.prepare(`SELECT content FROM ${table}`).iterate() as Iterable<{
        content: Uint8Array;
      }>)
        references(JSON.parse(gunzipSync(row.content).toString('utf8')), retained);
    }
    for (const row of database.prepare('SELECT key,value FROM storage_meta').iterate() as Iterable<{
      key: string;
      value: string;
    }>) {
      let value: unknown;
      try {
        value = JSON.parse(row.value);
      } catch {
        if (row.key === 'local-agents:v1') throw new Error('本机代理库引用记录损坏，不能清理');
        continue;
      }
      references(value, retained);
    }
    for (const row of database
      .prepare('SELECT ref,hash,raw_size,content FROM compressed_objects')
      .iterate() as Iterable<{ ref: string; hash: string; raw_size: number; content: Uint8Array }>) {
      const bytes = gunzipSync(row.content);
      if (hash(bytes) !== row.hash || bytes.length !== row.raw_size)
        throw new Error('压缩对象校验失败，不能清理');
      references(row.ref, retained);
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        continue;
      }
      references(value, retained);
    }
    return { retained, database: databaseIdentity };
  } finally {
    database.close();
  }
}

function checkedObject(directory: string, ref: string): Candidate | undefined {
  if (!objectPattern.test(ref)) throw new Error('无效对象路径');
  const [, prefix, name] = ref.split('/');
  if (name.slice(0, 2) !== prefix) throw new Error('对象目录与哈希不一致');
  const root = path.join(directory, 'objects');
  for (const parent of [root, path.join(root, prefix)]) {
    if (!existsSync(parent)) return;
    assertDirectory(parent);
    if (realpathSync(parent) !== parent) throw new Error('对象目录不能经过链接');
  }
  const filename = path.join(directory, ref);
  if (!existsSync(filename)) return;
  const before = identity(filename);
  const stat = lstatSync(filename);
  const file = openSync(filename, 'r');
  const checksum = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let length: number;
    while ((length = readSync(file, buffer, 0, buffer.length, null)))
      checksum.update(buffer.subarray(0, length));
  } finally {
    closeSync(file);
  }
  if (checksum.digest('hex') !== name || identity(filename) !== before)
    throw new Error('对象内容或身份已变化');
  return { ref, bytes: stat.size, identity: before };
}

// Call only while holding both service locks. The CLI acquires them before reaching here.
export function createObjectCleanupPlan(directory: string, selection: Selection): Plan {
  directory = realpathSync(directory);
  const surfaces: Surface[] =
    selection === 'all'
      ? (['native', 'terminal'] as const).filter((surface) =>
          existsSync(path.join(surfaceDirectory(directory, surface), 'state.db')),
        )
      : [selection];
  if (!surfaces.length) throw new Error('未找到可维护的数据库');
  const result: Plan['surfaces'] = [];
  for (const surface of surfaces) {
    assertSurfacePath(directory, surface);
    const target = surfaceDirectory(directory, surface);
    const state = readReferences(target);
    const root = path.join(target, 'objects');
    const candidates: Candidate[] = [];
    let retained = 0,
      skipped = 0,
      truncated = false;
    if (existsSync(root)) {
      assertDirectory(root);
      for (const prefix of readdirSync(root).sort()) {
        const prefixPath = path.join(root, prefix),
          stat = lstatSync(prefixPath);
        if (!/^[a-f0-9]{2}$/.test(prefix) || !stat.isDirectory() || stat.isSymbolicLink()) {
          skipped++;
          continue;
        }
        for (const name of readdirSync(prefixPath).sort()) {
          const ref = `objects/${prefix}/${name}`;
          if (!/^[a-f0-9]{64}$/.test(name) || !name.startsWith(prefix)) {
            skipped++;
            continue;
          }
          if (state.retained.has(ref)) {
            retained++;
            continue;
          }
          if (candidates.length >= 1000) {
            truncated = true;
            continue;
          }
          try {
            const item = checkedObject(target, ref);
            if (item) candidates.push(item);
          } catch {
            skipped++;
          }
        }
      }
    }
    result.push({
      surface,
      database: state.database,
      candidates,
      candidateBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
      truncated,
      retained,
      skipped,
    });
  }
  return {
    kind: 'elysia-object-cleanup',
    format: 1,
    appVersion: VERSION,
    createdAt: now(),
    scope: hash(directory),
    surfaces: result,
  };
}

// A plan is an explicit selection, not authority to delete arbitrary paths. Recheck all
// selected objects and the complete live reference set before the first unlink.
export function executeObjectCleanup(directory: string, supplied: unknown, selection: Selection) {
  directory = realpathSync(directory);
  const plan = ObjectCleanupPlan.parse(supplied);
  if (plan.scope !== hash(directory)) throw new Error('维护计划属于另一数据目录');
  const surfaces = new Set<Surface>();
  const selected: { surface: Surface; target: string; candidate: Candidate }[] = [];
  let alreadyMissing = 0;
  for (const entry of plan.surfaces) {
    if (surfaces.has(entry.surface) || (selection !== 'all' && selection !== entry.surface))
      throw new Error('维护计划与所选入口不一致');
    surfaces.add(entry.surface);
    assertSurfacePath(directory, entry.surface);
    const target = surfaceDirectory(directory, entry.surface),
      state = readReferences(target);
    if (state.database !== entry.database) throw new Error('数据库已被替换，请重新预览');
    const seen = new Set<string>();
    for (const candidate of entry.candidates) {
      if (seen.has(candidate.ref)) throw new Error('维护计划包含重复对象');
      seen.add(candidate.ref);
      if (state.retained.has(candidate.ref)) throw new Error('对象已有引用，请重新预览');
      const current = checkedObject(target, candidate.ref);
      if (!current) {
        alreadyMissing++;
        continue;
      }
      if (current.identity !== candidate.identity || current.bytes !== candidate.bytes)
        throw new Error('对象已变化，请重新预览');
      selected.push({ surface: entry.surface, target, candidate });
    }
  }
  let deleted = 0,
    freedBytes = 0;
  for (const { target, candidate } of selected) {
    // Revalidate identity/content immediately before deleting this exact regular file.
    const current = checkedObject(target, candidate.ref);
    if (!current || current.identity !== candidate.identity)
      throw new Error('对象在清理期间发生变化，停止处理');
    unlinkSync(path.join(target, candidate.ref));
    deleted++;
    freedBytes += candidate.bytes;
  }
  return { deleted, freedBytes, alreadyMissing, surfaces: [...surfaces] };
}
