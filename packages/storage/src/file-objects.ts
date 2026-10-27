// 将文件内容安全地发布为存储对象，并核对文件状态。
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../contracts/src/index.js';

const MAX_BYTES = 64 * 1024 * 1024;
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const invalid = () => new AppError('INVALID_OBJECT', '保存对象路径或文件不安全');
const version = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
// Unlinking a publisher's temporary hard link changes ctime without changing bytes.
// The immutable target is checked by inode/size/mtime plus its full expected SHA-256.
const byteVersion = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
async function plain(filename: string, directory = false) {
  const stat = await fs.lstat(filename, { bigint: true });
  // 不跟随符号链接，并要求解析后的路径仍与传入路径一致。
  if (
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    !samePath(await fs.realpath(filename), path.resolve(filename))
  )
    throw invalid();
  return stat;
}
/** 流式核对目标字节、长度和文件身份；读取期间内容变化或调用取消时失败。 */
async function verify(filename: string, expected: { hash: string; size: number }, signal?: AbortSignal) {
  const before = await plain(filename);
  const handle = await fs.open(filename, 'r');
  try {
    if (
      before.size !== BigInt(expected.size) ||
      byteVersion(before) !== byteVersion(await handle.stat({ bigint: true }))
    )
      throw new AppError('OBJECT_CORRUPT', '保存对象大小或版本不匹配');
    const digest = createHash('sha256'),
      buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > expected.size) throw new AppError('OBJECT_CORRUPT', '保存对象超过声明大小');
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (
      offset !== expected.size ||
      digest.digest('hex') !== expected.hash ||
      byteVersion(before) !== byteVersion(await handle.stat({ bigint: true })) ||
      byteVersion(before) !== byteVersion(await plain(filename))
    )
      throw new AppError('OBJECT_CORRUPT', '保存对象完整性检查失败');
  } finally {
    await handle.close();
  }
}

/**
 * 将来源文件按 expected.hash 发布为内容寻址对象，大小上限为 64 MiB。
 * 先复制到独占临时文件并核验来源，再用硬链接发布；已有目标不会覆盖，仍需核验。
 * 无论成功、失败或取消，都关闭句柄并清理本次临时文件。
 */
export async function publishFileObject(
  directory: string,
  source: string,
  expected: { hash: string; size: number },
  signal?: AbortSignal,
): Promise<{ hash: string; objectRef: string; size: number }> {
  if (
    !/^[a-f0-9]{64}$/.test(expected.hash) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0 ||
    expected.size > MAX_BYTES
  )
    throw new AppError('OBJECT_SIZE_LIMIT', '保存对象超过 64 MiB 上限或参数无效');
  const root = path.join(directory, 'objects');
  await plain(root, true);
  const parent = path.join(root, expected.hash.slice(0, 2));
  await fs.mkdir(parent).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await plain(parent, true);
  const ref = path.join('objects', expected.hash.slice(0, 2), expected.hash);
  const target = path.join(directory, ref),
    temporary = target + '.' + randomUUID() + '.tmp';
  const before = await plain(source);
  if (before.size !== BigInt(expected.size)) throw new AppError('OBJECT_CORRUPT', '来源文件大小不匹配');
  const input = await fs.open(source, 'r');
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (version(before) !== version(await input.stat({ bigint: true }))) throw invalid();
    output = await fs.open(temporary, 'wx', 0o600);
    const digest = createHash('sha256'),
      buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      if (offset + bytesRead > expected.size) throw new AppError('OBJECT_CORRUPT', '来源文件超过声明大小');
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        signal?.throwIfAborted();
        const result = await output.write(buffer, written, bytesRead - written, offset + written);
        if (!result.bytesWritten) throw new AppError('OBJECT_WRITE_FAILED', '保存对象写入失败');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    if (
      offset !== expected.size ||
      digest.digest('hex') !== expected.hash ||
      version(before) !== version(await input.stat({ bigint: true })) ||
      version(before) !== version(await plain(source))
    )
      throw new AppError('OBJECT_CORRUPT', '来源文件完整性检查失败');
    await output.sync();
    await output.close();
    output = undefined;
    signal?.throwIfAborted();
    await plain(root, true);
    await plain(parent, true);
    // 硬链接不会覆盖已有对象；即使目标已存在，也必须重新核对内容。
    await fs.link(temporary, target).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await verify(target, expected, signal);
    return { hash: expected.hash, objectRef: ref, size: expected.size };
  } finally {
    await output?.close();
    await input.close();
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
