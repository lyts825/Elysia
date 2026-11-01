/**
 * 对来源插件的对象根展开有界引用闭包，文件与压缩对象均先核对完整性。
 * EN: Expand bounded automation reference closures, verifying both file and compressed objects.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { AppError } from '../../contracts/src/index.js';

const SQLITE_REF = /^sqlite:[a-f0-9]{64}$/;
const FILE_REF = /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_REFERENCES = 100_000;
const MAX_VALUES = 1_000_000;
type Options = {
  check?: () => void;
  onBytes?: (bytes: number) => void;
  onObject?: (kind: 'file' | 'sqlite') => void;
};
const problem = (code: string, message: string) => new AppError(code, message);
const samePath = (left: string, right: string) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const identity = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

/** 校验引用地址，文件目录前缀必须与完整哈希一致。 */
function checkedRef(ref: string) {
  const normalized = ref.replaceAll('\\', '/');
  if (SQLITE_REF.test(ref)) return { digest: ref.slice(7), file: false, normalized };
  if (!FILE_REF.test(normalized) || normalized.slice(8, 10) !== normalized.slice(11, 13))
    throw problem('INVALID_OBJECT', '来源引用对象地址无效，已停止回收');
  return { digest: normalized.slice(11), file: true, normalized };
}

/** 拒绝符号链接、硬链接和特殊文件，并核对解析后的真实路径。 */
function plain(filename: string, directory = false) {
  const stat = lstatSync(filename, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n) ||
    !samePath(realpathSync(filename), path.resolve(filename))
  )
    throw problem('INVALID_OBJECT', '来源引用对象路径不安全，已停止回收');
  return stat;
}

/**
 * 大二进制只按块计算摘要；JSON 候选才缓存正文，超过上限时停止而不跳过引用。
 * EN: Hash large binary files in chunks. Buffer only possible JSON and fail closed at its limit.
 */
function fileJson(directory: string, ref: string, expected: string, options: Options) {
  const filename = path.join(directory, ref);
  plain(path.join(directory, 'objects'), true);
  plain(path.dirname(filename), true);
  const before = plain(filename),
    descriptor = openSync(filename, 'r');
  try {
    if (identity(before) !== identity(fstatSync(descriptor, { bigint: true })))
      throw problem('OBJECT_CORRUPT', '来源引用对象读取前发生变化，已停止回收');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(64 * 1024);
    let chunks: Buffer[] = [],
      size = 0,
      json: boolean | undefined;
    for (;;) {
      options.check?.();
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!length) break;
      size += length;
      if (BigInt(size) > before.size) throw problem('OBJECT_CORRUPT', '来源引用对象读取时增长，已停止回收');
      const bytes = buffer.subarray(0, length);
      hash.update(bytes);
      options.onBytes?.(length);
      if (json === undefined) {
        for (const byte of bytes) {
          if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
          json = byte === 0x7b || byte === 0x5b;
          break;
        }
      }
      if (json === false) chunks = [];
      else {
        if (size > MAX_JSON_BYTES || (json && before.size > BigInt(MAX_JSON_BYTES)))
          throw problem('OBJECT_LIMIT', '来源引用 JSON 对象超过 64 MiB，已停止回收');
        chunks.push(Buffer.from(bytes));
      }
    }
    if (
      BigInt(size) !== before.size ||
      hash.digest('hex') !== expected ||
      identity(before) !== identity(fstatSync(descriptor, { bigint: true })) ||
      identity(before) !== identity(plain(filename))
    )
      throw problem('OBJECT_CORRUPT', '来源引用对象完整性未知，已停止回收');
    options.onObject?.('file');
    return json ? Buffer.concat(chunks, size) : undefined;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * 仅从来源插件根扫描，保持其它大型交付对象原有的回收行为；缺失、损坏或超限均停止。
 * EN: Traverse automation roots only, preserving existing handling of unrelated large artifacts.
 */
export function automationReferenceClosure(
  directory: string,
  database: DatabaseSync,
  roots: Iterable<string>,
  options: Options = {},
) {
  const retained = new Set<string>(),
    queue: string[] = [];
  const add = (ref: string) => {
    checkedRef(ref);
    if (retained.has(ref)) return;
    if (retained.size >= MAX_REFERENCES) throw problem('OBJECT_LIMIT', '来源引用超过 10 万条，已停止回收');
    retained.add(ref);
    queue.push(ref);
  };
  for (const ref of roots) add(ref);
  let visited = 0;
  for (let index = 0; index < queue.length; index++) {
    options.check?.();
    const ref = queue[index],
      address = checkedRef(ref);
    const row = database
      .prepare(
        `SELECT hash,raw_size,
      CASE WHEN raw_size>=0 AND raw_size<=? AND length(content)<=? THEN content END content
      FROM compressed_objects WHERE ref=?`,
      )
      .get(MAX_JSON_BYTES, MAX_JSON_BYTES, ref) as
      | { hash: string; raw_size: number; content: Uint8Array | null }
      | undefined;
    let bytes: Buffer | undefined;
    if (row) {
      if (!row.content) throw problem('OBJECT_LIMIT', '来源压缩对象超过 64 MiB，已停止回收');
      try {
        bytes = gunzipSync(row.content, { maxOutputLength: MAX_JSON_BYTES });
      } catch {
        throw problem('OBJECT_CORRUPT', '来源压缩对象无法读取，已停止回收');
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== row.raw_size || digest !== row.hash || digest !== address.digest)
        throw problem('OBJECT_CORRUPT', '来源压缩对象完整性未知，已停止回收');
      options.onBytes?.(bytes.length);
      options.onObject?.('sqlite');
    } else {
      if (!address.file) throw problem('OBJECT_NOT_FOUND', '来源引用对象缺失，已停止回收');
      bytes = fileJson(directory, address.normalized, address.digest, options);
    }
    if (!bytes) continue;
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue;
    }
    const values: { value: unknown; field: string }[] = [{ value, field: '' }];
    const append = (value: unknown, field: string) => {
      if (visited + values.length >= MAX_VALUES)
        throw problem('OBJECT_LIMIT', '来源对象引用扫描超过上限，已停止回收');
      values.push({ value, field });
    };
    while (values.length) {
      if ((visited++ & 255) === 0) options.check?.();
      if (visited > MAX_VALUES) throw problem('OBJECT_LIMIT', '来源对象引用扫描超过上限，已停止回收');
      const item = values.pop()!;
      if (typeof item.value === 'string' && /Ref$/.test(item.field)) {
        if (/^(?:sqlite:|objects[\\/])/.test(item.value)) add(item.value);
      } else if (Array.isArray(item.value)) {
        for (const child of item.value) append(child, item.field);
      } else if (item.value && typeof item.value === 'object') {
        for (const key in item.value)
          if (Object.hasOwn(item.value, key)) append((item.value as Record<string, unknown>)[key], key);
      }
    }
  }
  options.check?.();
  return retained;
}
