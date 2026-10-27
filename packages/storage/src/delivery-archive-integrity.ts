// 核验交付归档所引用对象及本地路径的完整性。
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { hash, stable } from './index.js';

const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const version = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
function plain(filename: string, directory = false) {
  const stat = lstatSync(filename, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    !samePath(realpathSync(filename), path.resolve(filename))
  )
    throw new Error('保存交付包路径不是安全普通文件');
  return stat;
}

/**
 * 在发布备份或安装恢复数据前验证全部已保存交付包。
 * 逐条核对项目、冻结清单、对象引用、大小和 SHA-256；读取前后核对文件身份与时间，
 * 防止校验期间替换文件。任何一条无法证明完整时抛错，由调用方中止操作。
 */
export function validateDeliveryArchiveObjects(db: DatabaseSync, directory: string) {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_delivery_archives_v1'")
      .get()
  )
    return;
  const rows = db
    .prepare(
      `SELECT a.*,m.project_id manifest_project,m.hash frozen_hash,m.data manifest_data
    FROM project_delivery_archives_v1 a LEFT JOIN project_delivery_manifests_v1 m ON m.id=a.manifest_id`,
    )
    .iterate();
  for (const row of rows as Iterable<Record<string, any>>) {
    if (
      row.project_id !== row.manifest_project ||
      row.manifest_hash !== row.frozen_hash ||
      !/^[a-f0-9]{64}$/.test(row.object_hash) ||
      !Number.isSafeInteger(row.size) ||
      row.size < 22 ||
      row.size > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(row.file_count) ||
      row.file_count < 1 ||
      row.file_count > 800 ||
      !z.string().datetime().safeParse(row.saved_at).success
    )
      throw new Error('保存交付包记录或清单绑定无效');
    // 清单自身的冻结哈希不参与其摘要计算，并与归档记录交叉核对。
    const manifest = JSON.parse(row.manifest_data),
      { hash: frozenHash, ...snapshot } = manifest;
    if (
      manifest.id !== row.manifest_id ||
      manifest.projectId !== row.project_id ||
      frozenHash !== row.manifest_hash ||
      hash(stable(snapshot)) !== frozenHash
    )
      throw new Error('保存交付包冻结清单完整性检查失败');
    const ref = path.join('objects', row.object_hash.slice(0, 2), row.object_hash);
    if (typeof row.object_ref !== 'string' || row.object_ref.replace(/\\/g, '/') !== ref.replace(/\\/g, '/'))
      throw new Error('保存交付包对象引用无效');
    plain(path.join(directory, 'objects'), true);
    plain(path.join(directory, 'objects', row.object_hash.slice(0, 2)), true);
    const filename = path.join(directory, ref),
      before = plain(filename);
    if (before.size !== BigInt(row.size)) throw new Error('保存交付包对象大小不匹配');
    const handle = openSync(filename, 'r');
    try {
      if (version(before) !== version(fstatSync(handle, { bigint: true })))
        throw new Error('保存交付包对象发生变化');
      const digest = createHash('sha256'),
        buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      for (;;) {
        const bytes = readSync(handle, buffer, 0, buffer.length, offset);
        if (!bytes) break;
        offset += bytes;
        if (offset > row.size) throw new Error('保存交付包对象超过声明大小');
        digest.update(buffer.subarray(0, bytes));
      }
      if (
        offset !== row.size ||
        digest.digest('hex') !== row.object_hash ||
        version(before) !== version(fstatSync(handle, { bigint: true })) ||
        version(before) !== version(plain(filename))
      )
        throw new Error('保存交付包对象完整性检查失败');
    } finally {
      closeSync(handle);
    }
  }
}
