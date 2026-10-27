/**
 * 将文件内容安全地发布为存储对象，并核对文件状态。
 * EN: Publish file bytes as verified storage objects and check their file state.
 *
 * 文件读取、摘要和对象发布围绕同一次文件状态核对展开；源文件变化或核验失败时拒绝把本次内容当作稳定证据。
 * EN: Coordinate reading, hashing, and object publication around file-state checks, rejecting changed or unverifiable sources as stable evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../contracts/src/index.js';

const MAX_BYTES = 64 * 1024 * 1024;
/**
 * 根据平台路径大小写规则比较真实路径与预期路径。
 * EN: Compare actual and expected paths using the platform case-sensitivity rule.
 */
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/**
 * 构造统一的不安全对象路径错误，供检查点一致拒绝。
 * EN: Create the shared unsafe-object-path error used consistently by path checks.
 */
const invalid = () => new AppError('INVALID_OBJECT', '保存对象路径或文件不安全');
/**
 * 为来源文件生成含ctime的完整状态指纹，检测复制期间已观测的变化。
 * EN: Build a full source-state fingerprint including ctime to detect observed changes during copying.
 */
const version = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
// 解除发布临时硬链接会改变ctime而不改变字节，因此目标按inode、大小、mtime和完整预期SHA-256核验。
// EN: Removing the publisher temporary hard link changes ctime without changing bytes. Verify the
// target through inode, size, mtime, and the full expected SHA-256.
const byteVersion = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
/**
 * 通过 lstat 与 realpath 同时检查末端类型和整条路径，返回 bigint 文件身份供前后比较。
 * EN: Use lstat and realpath to validate both the final entry type and the complete path, returning
 * bigint file identity for before/after comparison.
 */
async function plain(filename: string, directory = false) {
  const stat = await fs.lstat(filename, { bigint: true });
  // 不跟随符号链接，并要求解析后的路径仍与传入路径一致。
  // EN: Do not follow symbolic links, and require the resolved path to remain identical to the
  // supplied absolute path.
  if (
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    !samePath(await fs.realpath(filename), path.resolve(filename))
  )
    throw invalid();
  return stat;
}
/**
 * 流式核对目标字节、长度和文件身份；读取期间内容变化或调用取消时失败。
 * EN: Stream-verify target bytes, size, and file identity. Reject detected changes during reads or
 * caller cancellation.
 */
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
 * EN: Publish the source under expected.hash as a content-addressed object, up to 64 MiB. Copy into
 * an exclusively created temporary file, verify the source, then publish through a hard link. Do not
 * overwrite an existing target; verify it instead. Close handles and remove this attempt temporary
 * file on success, failure, or cancellation.
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
    // EN: Hard-link creation does not overwrite an existing object. Recheck its bytes even when the
    // target already exists.
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
