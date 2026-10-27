// 计算文件的 SHA-256 摘要，供桌面端完整性检查使用。
const fs = require('node:fs');
const { createHash } = require('node:crypto');
let sharedBuffer;

function sha256File(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    // Hashing is synchronous, so sequential files can reuse one bounded buffer.
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
