/**
 * 计算文件的 SHA-256 摘要，供桌面端完整性检查使用。
 * EN: Compute file SHA-256 digests for desktop integrity checks.
 *
 * 通过固定大小缓冲区同步分块读取，避免整文件驻留内存；调用方提供预期摘要并决定完整性失败时的处置。
 * EN: Read synchronously in fixed-size chunks rather than retaining entire files; callers own expected digests and integrity-failure handling.
 */
const fs = require('node:fs');
const { createHash } = require('node:crypto');
let sharedBuffer;

/**
 * 以固定大小缓冲区同步读取文件，返回小写十六进制 SHA-256。
 * EN: Read a file synchronously through a fixed-size buffer and return its lowercase hexadecimal
 * SHA-256 digest.
 */
function sha256File(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    // 摘要计算为同步过程，顺序处理文件时可以复用同一个有界缓冲区。
    // EN: Hashing is synchronous, so sequential files can reuse one bounded buffer.
    const buffer = (sharedBuffer ??= Buffer.allocUnsafe(1024 * 1024));
    const hash = createHash('sha256');
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = { sha256File };
