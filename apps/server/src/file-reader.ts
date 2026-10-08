import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { AppError, invariant } from '../../../packages/contracts/src/index.js';
import {
  LEGACY_TEXT_BYTES,
  TEXT_PAGE_BYTES,
  type ResolvedTextEncoding,
  type TextFileEncoding,
  type TextFilePage,
  type TextPageOptions,
} from '../../../packages/contracts/src/files.js';

export type FileStat = Stats;
export type TextReadHandle = { read: FileHandle['read']; stat: () => Promise<Stats> };
export function fileVersion(stat: FileStat) {
  return createHash('sha256')
    .update(JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino]))
    .digest('hex');
}
function changed(stat: FileStat, version = fileVersion(stat)) {
  return new AppError(
    'FILE_CHANGED',
    '文件已改变，请重新从第一页读取。',
    false,
    {
      version,
      totalBytes: stat.size,
    },
    409,
  );
}
export async function openFile(filename: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    invariant(stat.isFile(), 'FILE_NOT_FILE', '此路径不是普通文件');
    invariant(Number.isSafeInteger(stat.size), 'FILE_SIZE', '文件大小超出安全读取范围');
    invariant(!(await fs.lstat(filename)).isSymbolicLink(), 'FILE_LINK', '预览不跟随符号链接');
    const real = await fs.realpath(filename),
      lexical = path.resolve(filename);
    invariant(
      process.platform === 'win32' ? real.toLowerCase() === lexical.toLowerCase() : real === lexical,
      'FILE_LINK',
      '文件路径在读取时变成了符号链接',
    );
    if (fileVersion(await fs.stat(filename)) !== fileVersion(stat)) throw changed(await fs.stat(filename));
    signal?.throwIfAborted();
    return { handle, stat, version: fileVersion(stat) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function read(handle: TextReadHandle, start: number, length: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  signal?.throwIfAborted();
  return buffer.subarray(0, bytesRead);
}
export async function inspectFile(filename: string, signal?: AbortSignal) {
  const opened = await openFile(filename, signal);
  try {
    return {
      stat: opened.stat,
      version: opened.version,
      prefix: await read(opened.handle, 0, Math.min(4096, opened.stat.size), signal),
    };
  } finally {
    await opened.handle.close();
  }
}
function encodingError() {
  return new AppError(
    'FILE_ENCODING',
    '无法按当前编码读取文本，请选择文件实际编码；Windows 中文旧文件可尝试 GB18030 / GBK。',
  );
}
export function resolveEncoding(prefix: Uint8Array, requested: TextFileEncoding = 'auto') {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => prefix[index] === byte);
  if (starts(0xff, 0xfe, 0, 0) || starts(0, 0, 0xfe, 0xff))
    throw new AppError('FILE_ENCODING', '暂不支持 UTF-32 文本预览，请将文件另存为 UTF-8 后重试。');
  const bom: ResolvedTextEncoding | undefined = starts(0xef, 0xbb, 0xbf)
    ? 'utf-8'
    : starts(0xff, 0xfe)
      ? 'utf-16le'
      : starts(0xfe, 0xff)
        ? 'utf-16be'
        : undefined;
  if (bom && requested !== 'auto' && requested !== bom)
    throw new AppError('FILE_ENCODING', '所选编码与文件 BOM 不一致，请选择自动或对应的 Unicode 编码。');
  return {
    encoding: requested === 'auto' ? bom || 'utf-8' : requested,
    encodingSource:
      requested === 'auto' ? (bom ? ('bom' as const) : ('default' as const)) : ('manual' as const),
  };
}
function width(bytes: Uint8Array, index: number, encoding: ResolvedTextEncoding) {
  const first = bytes[index];
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    if (index + 1 >= bytes.length) throw encodingError();
    const unit = encoding === 'utf-16le' ? first | (bytes[index + 1] << 8) : (first << 8) | bytes[index + 1];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 3 >= bytes.length) throw encodingError();
      const next =
        encoding === 'utf-16le'
          ? bytes[index + 2] | (bytes[index + 3] << 8)
          : (bytes[index + 2] << 8) | bytes[index + 3];
      if (next < 0xdc00 || next > 0xdfff) throw encodingError();
      return 4;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw encodingError();
    return 2;
  }
  if (first < 0x80) return 1;
  if (encoding === 'gb18030') {
    if (first < 0x81 || first > 0xfe || index + 1 >= bytes.length) throw encodingError();
    const second = bytes[index + 1];
    if (second >= 0x30 && second <= 0x39) {
      if (
        index + 3 >= bytes.length ||
        bytes[index + 2] < 0x81 ||
        bytes[index + 2] > 0xfe ||
        bytes[index + 3] < 0x30 ||
        bytes[index + 3] > 0x39
      )
        throw encodingError();
      return 4;
    }
    if (second < 0x40 || second === 0x7f || second > 0xfe) throw encodingError();
    return 2;
  }
  const length =
    first >= 0xc2 && first <= 0xdf
      ? 2
      : first >= 0xe0 && first <= 0xef
        ? 3
        : first >= 0xf0 && first <= 0xf4
          ? 4
          : 0;
  if (!length || index + length > bytes.length) throw encodingError();
  for (let i = 1; i < length; i++)
    if (bytes[index + i] < 0x80 || bytes[index + i] > 0xbf) throw encodingError();
  return length;
}

// GB18030 lead/trail ranges overlap, so arbitrary positions need a known boundary.
// Cache only positions, never file contents; all cache dimensions are bounded.
const checkpoints = new Map<string, number[]>();
async function gbBoundary(
  handle: TextReadHandle,
  key: string,
  target: number,
  size: number,
  signal?: AbortSignal,
) {
  let points = checkpoints.get(key);
  if (!points) {
    points = [0];
    if (checkpoints.size >= 16) checkpoints.delete(checkpoints.keys().next().value!);
    checkpoints.set(key, points);
  } else {
    checkpoints.delete(key);
    checkpoints.set(key, points);
  }
  let position = points.reduce((best, value) => (value <= target && value > best ? value : best), 0);
  let recorded = position;
  while (position < target) {
    const bytes = await read(handle, position, Math.min(64 * 1024 + 4, size - position), signal);
    if (!bytes.length) throw changed(await handle.stat());
    let index = 0;
    while (index < bytes.length && index < 64 * 1024 && position + index < target)
      index += width(bytes, index, 'gb18030');
    position += index;
    if (position - recorded >= 1024 * 1024 || position >= target) {
      if (!points.includes(position)) points.push(position);
      if (points.length > 4096) points.splice(1, points.length - 4096);
      recorded = position;
    }
  }
  return position;
}
async function boundary(
  handle: TextReadHandle,
  encoding: ResolvedTextEncoding,
  requested: number,
  size: number,
  key: string,
  signal?: AbortSignal,
) {
  if (!requested || requested === size) return requested;
  if (encoding === 'gb18030') return gbBoundary(handle, key, requested, size, signal);
  let position = requested;
  if (encoding.startsWith('utf-16')) {
    position = Math.min(size, Math.ceil(position / 2) * 2);
    const bytes = await read(handle, position, Math.min(2, size - position), signal);
    if (bytes.length === 2) {
      const unit = encoding === 'utf-16le' ? bytes[0] | (bytes[1] << 8) : (bytes[0] << 8) | bytes[1];
      if (unit >= 0xdc00 && unit <= 0xdfff) position += 2;
    }
  } else {
    const bytes = await read(handle, position, Math.min(4, size - position), signal);
    let index = 0;
    while (index < bytes.length && (bytes[index] & 0xc0) === 0x80) index++;
    position += index;
  }
  return position;
}
export async function readTextPage(
  filename: string,
  requestedEncoding: TextFileEncoding = 'auto',
  options: TextPageOptions = {},
) {
  const opened = await openFile(filename, options.signal);
  try {
    return await readTextSource(
      {
        ...opened,
        key: filename + ':' + opened.version,
        validate: async () => {
          const current = await fs.stat(filename);
          if (
            fileVersion(current) !== opened.version ||
            fileVersion(await opened.handle.stat()) !== opened.version
          )
            throw changed(current);
        },
      },
      requestedEncoding,
      options,
    );
  } finally {
    await opened.handle.close();
  }
}
export async function readTextSource(
  opened: {
    handle: TextReadHandle;
    stat: FileStat;
    version: string;
    key: string;
    validate: () => Promise<void>;
  },
  requestedEncoding: TextFileEncoding = 'auto',
  options: TextPageOptions = {},
) {
  const { handle, stat, version } = opened;
  if (options.version && options.version !== version) throw changed(stat, version);
  const requestedOffset = options.offset ?? 0;
  invariant(
    Number.isSafeInteger(requestedOffset) && requestedOffset >= 0,
    'FILE_OFFSET',
    '读取位置必须为非负整数字节',
  );
  if (requestedOffset > stat.size)
    throw new AppError('FILE_OFFSET', '读取位置超出文件大小', false, { totalBytes: stat.size }, 416);
  if (options.limit !== undefined)
    invariant(
      Number.isSafeInteger(options.limit) && options.limit > 0 && options.limit <= TEXT_PAGE_BYTES,
      'FILE_LIMIT',
      '单页最多读取 256 KiB',
    );
  const resolved = resolveEncoding(
    await read(handle, 0, Math.min(stat.size, 4), options.signal),
    requestedEncoding,
  );
  const limit =
    options.offset === undefined && options.limit === undefined && stat.size <= LEGACY_TEXT_BYTES
      ? LEGACY_TEXT_BYTES
      : (options.limit ?? TEXT_PAGE_BYTES);
  const offset = await boundary(
    handle,
    resolved.encoding,
    requestedOffset,
    stat.size,
    opened.key,
    options.signal,
  );
  const bytes = await read(handle, offset, Math.min(limit + 4, stat.size - offset), options.signal);
  let end = 0;
  while (end < bytes.length && end < limit) {
    const count = width(bytes, end, resolved.encoding);
    if (end && end + count > limit) break;
    end += count;
  }
  let text: string;
  try {
    text = new TextDecoder(resolved.encoding, { fatal: true, ignoreBOM: offset !== 0 }).decode(
      bytes.subarray(0, end),
    );
  } catch {
    throw encodingError();
  }
  await opened.validate();
  options.signal?.throwIfAborted();
  const endOffset = offset + end;
  const page: TextFilePage = {
    requestedOffset,
    offset,
    endOffset,
    nextOffset: endOffset < stat.size ? endOffset : null,
    totalBytes: stat.size,
    version,
    paged: offset !== 0 || endOffset < stat.size,
  };
  return { text, ...resolved, page, bytes: bytes.subarray(0, end) };
}

export type FileResource = {
  stream: Readable;
  mediaType: string;
  version: string;
  size: number;
  status: 200 | 206;
  contentRange?: string;
  contentLength?: number;
  acceptRanges: boolean;
};
export async function streamFile(
  filename: string,
  mediaType: string,
  options: {
    range?: string;
    version?: string;
    signal?: AbortSignal;
    rewritePrefix?: string;
    verifyHash?: string;
  } = {},
): Promise<FileResource> {
  const opened = await openFile(filename, options.signal);
  try {
    if (options.version && options.version !== opened.version) throw changed(opened.stat);
    const rewrite = !!options.rewritePrefix && ['text/html', 'text/css'].includes(mediaType.split(';')[0]);
    let start = 0,
      end = opened.stat.size - 1,
      status: 200 | 206 = 200;
    if (options.range && !rewrite && opened.stat.size > 0) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(options.range);
      if (!match || (!match[1] && !match[2]))
        throw new AppError(
          'FILE_RANGE',
          '仅支持一个有效字节范围',
          false,
          { totalBytes: opened.stat.size },
          416,
        );
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
      } else {
        const tail = Number(match[2]);
        start = Math.max(0, opened.stat.size - tail);
      }
      if (![start, end].every(Number.isSafeInteger) || start < 0 || start >= opened.stat.size || end < start)
        throw new AppError(
          'FILE_RANGE',
          '字节范围超出文件大小',
          false,
          { totalBytes: opened.stat.size },
          416,
        );
      end = Math.min(end, opened.stat.size - 1);
      status = 206;
    }
    const prefix = rewrite
      ? await read(opened.handle, 0, Math.min(4, opened.stat.size), options.signal)
      : null;
    const transform = rewrite
      ? new ScopedResourceTransform(
          options.rewritePrefix!,
          mediaType.split(';')[0] === 'text/css',
          resolveEncoding(prefix!).encoding,
        )
      : null;
    const source = opened.handle.createReadStream({
      start,
      ...(end >= 0 ? { end } : {}),
      highWaterMark: 64 * 1024,
      autoClose: true,
    });
    const guard = new FileStreamGuard(
      filename,
      opened.version,
      status === 200 ? options.verifyHash : undefined,
      options.signal,
    );
    source.on('error', (error) => guard.destroy(error));
    guard.once('close', () => source.destroy());
    let stream: Readable = source.pipe(guard);
    if (transform) {
      guard.on('error', (error) => transform.destroy(error));
      transform.on('close', () => guard.destroy());
      stream = guard.pipe(transform);
      mediaType += '; charset=utf-8';
    }
    const abort = () => {
      stream.destroy();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    stream.once('close', () => options.signal?.removeEventListener('abort', abort));
    if (options.signal?.aborted) {
      stream.destroy();
      options.signal.throwIfAborted();
    }
    return {
      stream,
      mediaType,
      version: opened.version,
      size: opened.stat.size,
      status,
      ...(status === 206 ? { contentRange: `bytes ${start}-${end}/${opened.stat.size}` } : {}),
      ...(!rewrite ? { contentLength: opened.stat.size ? end - start + 1 : 0 } : {}),
      acceptRanges: !rewrite,
    };
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

// Hold one final chunk until the source version (and immutable artifact digest)
// is checked, so a changed stream ends with an explicit incomplete response.
class FileStreamGuard extends Transform {
  private last: Buffer | null = null;
  private digest;
  constructor(
    private filename: string,
    private version: string,
    private expectedHash?: string,
    private signal?: AbortSignal,
  ) {
    super();
    this.digest = expectedHash ? createHash('sha256') : null;
  }
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.digest?.update(chunk);
    if (this.last) this.push(this.last);
    this.last = chunk;
    callback();
  }
  _flush(callback: (error?: Error | null) => void) {
    fs.stat(this.filename)
      .then((stat) => {
        this.signal?.throwIfAborted();
        if (fileVersion(stat) !== this.version) throw changed(stat);
        if (this.digest && this.digest.digest('hex') !== this.expectedHash)
          throw new AppError('OBJECT_CORRUPT', '对象哈希不匹配');
        if (this.last) this.push(this.last);
        this.last = null;
        callback();
      })
      .catch((error) => callback(error));
  }
}

// A small state machine scopes root-relative URLs across arbitrary stream boundaries.
// Whitespace and attributes are emitted immediately, so even malformed huge tags use bounded memory.
class ScopedResourceTransform extends Transform {
  private decoder: TextDecoder;
  private word = '';
  private wordOverflow = false;
  private state: 'none' | 'name' | 'equals' | 'open' | 'quote' | 'slash' = 'none';
  constructor(
    private prefix: string,
    private css: boolean,
    encoding: ResolvedTextEncoding,
  ) {
    super();
    this.decoder = new TextDecoder(encoding);
  }
  private rewrite(text: string) {
    let output = '';
    for (const character of text) {
      let emit = character;
      const previous = this.state;
      if (previous === 'slash') {
        emit = character === '/' ? '//' : this.prefix + character;
        this.state = 'none';
      } else if (previous === 'quote') {
        this.state = character === '/' ? 'slash' : 'none';
        if (this.state === 'slash') emit = '';
      } else if (previous === 'equals' || previous === 'open') {
        if (/\s/.test(character)) {
        } else if (character === '"' || character === "'") this.state = 'quote';
        else if (this.css && character === '/') {
          this.state = 'slash';
          emit = '';
        } else this.state = 'none';
      } else if (previous === 'name') {
        if (/\s/.test(character) && !this.css) {
        } else if (!this.css && character === '=') this.state = 'equals';
        else if (this.css && character === '(') this.state = 'open';
        else this.state = 'none';
      }
      if (/[\w]/.test(character)) {
        if (this.word.length < 6 && !this.wordOverflow) this.word += character.toLowerCase();
        else this.wordOverflow = true;
      } else {
        const match =
          !this.wordOverflow &&
          (this.css ? this.word === 'url' : ['src', 'href', 'poster'].includes(this.word));
        if (match && previous === 'none') {
          if (!this.css && /\s/.test(character)) this.state = 'name';
          else if (!this.css && character === '=') this.state = 'equals';
          else if (this.css && character === '(') this.state = 'open';
        }
        this.word = '';
        this.wordOverflow = false;
      }
      output += emit;
    }
    return output;
  }
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: string) => void,
  ) {
    try {
      callback(null, this.rewrite(this.decoder.decode(chunk, { stream: true })));
    } catch (error) {
      callback(error as Error);
    }
  }
  _flush(callback: (error?: Error | null, data?: string) => void) {
    try {
      callback(null, this.rewrite(this.decoder.decode()) + (this.state === 'slash' ? '/' : ''));
    } catch (error) {
      callback(error as Error);
    }
  }
}
