/**
 * 检查、分页读取和流式传输文件。
 * 提供编码识别、版本化分页及可取消资源流；末块等待版本/可选摘要核验，路径授权由上层项目或产物服务建立。
 * EN: Inspects, paginates, and streams files. Provides encoding detection, revisioned pages and cancellable streams; final bytes await version/optional hash checks while upper services establish path authorization.
 */
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
/**
 * 从文件大小、时间和设备信息计算版本，用于检测读取期间的变化。
 * EN: Derives file versions from size, timestamps, and device identity to detect changes during reads.
 */
export function fileVersion(stat: FileStat) {
  return createHash('sha256')
    .update(JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino]))
    .digest('hex');
}
/**
 * 创建带最新版本及长度的文件变化冲突，让客户端从首个字节页恢复。
 * EN: Builds a file-change conflict carrying current version/length so clients restart byte paging.
 */
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
/**
 * 以只读方式打开普通文件并核对路径；可通过 signal 取消。
 * EN: Opens regular files read-only after path validation and supports cancellation.
 */
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
/**
 * 在指定偏移读取有界字节并返回实际长度，读取前后检查取消以停止后续解码。
 * EN: Reads a bounded byte range and returns actual bytes, checking cancellation before and after I/O.
 */
async function read(handle: TextReadHandle, start: number, length: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  signal?.throwIfAborted();
  return buffer.subarray(0, bytesRead);
}
/**
 * 打开文件读取属性与最多 4096 字节前缀，并在结束后关闭句柄。
 * EN: Reads file properties and up to a 4096-byte prefix, closing the handle afterward.
 */
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
/**
 * 构造统一的文本编码错误及可操作提示，不悄悄以替代字符改写正文。
 * EN: Creates a consistent actionable encoding error rather than silently substituting source characters.
 */
function encodingError() {
  return new AppError(
    'FILE_ENCODING',
    '无法按当前编码读取文本，请选择文件实际编码；Windows 中文旧文件可尝试 GB18030 / GBK。',
  );
}
/**
 * 结合字节前缀和请求编码识别文本格式，拒绝不支持的 UTF-32。
 * EN: Detects text encoding from the byte prefix and requested encoding, rejecting unsupported UTF-32.
 */
export function resolveEncoding(prefix: Uint8Array, requested: TextFileEncoding = 'auto') {
  /**
   * 检查样本前缀是否匹配给定字节序列，用于 BOM/编码识别。
   * EN: Matches a sample prefix against supplied bytes for BOM/encoding detection.
   */
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
/**
 * 判断当前位置完整字符的字节宽度；拒绝截断的多字节序列和孤立 UTF-16 代理码元。
 * EN: Determines the width of a complete character at a position, rejecting truncated multibyte sequences and isolated UTF-16 surrogates.
 */
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

/**
 * GB18030首尾字节范围重叠，任意位置需要已知字符边界。 缓存只保存位置而非文件正文，所有缓存维度均有界。
 * EN: GB18030 lead/trail ranges overlap, so arbitrary positions need a known boundary. Cache only positions, never file contents; all cache dimensions are bounded.
 */
const checkpoints = new Map<string, number[]>();
/**
 * GB18030 首/尾字节范围重叠，不能仅看目标附近几字节猜边界；从最近已知检查点扫描。 缓存只保存版本化位置，不保存正文，并限制文件键数与每文件检查点数量。
 * EN: Because GB18030 lead/trail ranges overlap, nearby bytes alone cannot identify boundaries; scan from the nearest known checkpoint. Cache only versioned positions with bounded file keys and per-file checkpoints, never body content.
 */
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
/**
 * 将请求字节位置向后调整到完整字符边界；返回实际偏移，客户端必须沿 nextOffset 继续。
 * EN: Moves a requested byte position forward to a complete-character boundary and returns actual offsets; clients must continue from nextOffset.
 */
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
/**
 * 安全打开文件并按编码与分页参数读取文本；读取时检查文件版本。
 * EN: Safely opens files and reads encoded pages while checking the file version.
 */
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
        /**
         * 重新核对路径与打开句柄的版本；任一变化都拒绝复用当前文本分页。
         * EN: Rechecks pathname and opened-handle versions; either change invalidates current text paging.
         */
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
/**
 * 从已打开来源读取一页文本。offset/limit 都以字节计，返回文本及实际页边界；最多额外读取 四字节以保留完整字符。validate 由来源提供，在解码后再次确认版本，防止混读两版文件。
 * EN: Reads a text page from an open source. offset and limit are bytes; up to four extra bytes preserve complete characters. Source-provided validate rechecks version after decoding to prevent mixing file versions.
 */
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
/**
 * 创建有界文件流。普通资源支持单个 HTTP 字节范围；HTML/CSS 做入口 URL 改写时长度变化， 因此关闭 Range 和 Content-Length。完整不可变产物可核对 verifyHash，部分读取不声称整文件验真。
 * EN: Creates bounded file streams. Ordinary resources support one HTTP byte range; HTML/CSS surface rewriting changes length, disabling Range and Content-Length. Whole immutable artifacts may verifyHash; partial reads do not claim full-file integrity.
 */
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
    /**
     * 在请求取消时销毁资源流，阻止继续读取磁盘。
     * EN: Destroys the resource stream on cancellation to stop further disk reads.
     */
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

/**
 * 保留最后一个数据块，直到来源版本和不可变产物摘要， 通过核验，使变更中的流以显式不完整响应结束。
 * EN: Hold one final chunk until the source version (and immutable artifact digest) is checked, so a changed stream ends with an explicit incomplete response.
 */
class FileStreamGuard extends Transform {
  /**
   * 保留最后一块直到版本/摘要检查通过，校验失败时响应显式不完整，不发送看似完整的尾部。
   * EN: Retains the final chunk until version/digest verification passes; failures leave an explicitly incomplete response rather than sending an apparently complete tail.
   */
  private last: Buffer | null = null;
  private digest;
  /**
   * 创建末块保留校验流；可选摘要在逐块读取时累计，末块必须等版本和摘要核验后才放行。
   * EN: Creates a last-chunk withholding validation stream; optional hashes accumulate incrementally and final bytes wait for version/hash validation.
   */
  constructor(
    private filename: string,
    private version: string,
    private expectedHash?: string,
    private signal?: AbortSignal,
  ) {
    super();
    this.digest = expectedHash ? createHash('sha256') : null;
  }
  /**
   * 更新摘要并输出上一块，保留当前末块直到最终核验；回调推动上游背压。
   * EN: Updates the hash, emits the previous chunk and withholds the current last chunk until final validation; callback advances upstream backpressure.
   */
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.digest?.update(chunk);
    if (this.last) this.push(this.last);
    this.last = chunk;
    callback();
  }
  /**
   * 结束时检查取消、磁盘版本和可选摘要，全部通过才输出末块；失败经流回调传播。
   * EN: At EOF checks cancellation, disk version and optional digest before releasing final bytes; failures propagate via the stream callback.
   */
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

/**
 * 小状态机可跨任意数据块边界限定根相对URL的入口范围。 空白和属性即时输出，即使巨大畸形标签也只使用有界内存。
 * EN: A small state machine scopes root-relative URLs across arbitrary stream boundaries. Whitespace and attributes are emitted immediately, so even malformed huge tags use bounded memory.
 */
class ScopedResourceTransform extends Transform {
  /**
   * 小状态机跨 chunk 保存属性/引号状态；只缓存短属性名，巨大畸形标签不能无限积累正文。
   * EN: Retains attribute and quote state across chunks, caching only short attribute names so huge malformed tags cannot accumulate unbounded content.
   */
  private decoder: TextDecoder;
  private word = '';
  private wordOverflow = false;
  private state: 'none' | 'name' | 'equals' | 'open' | 'quote' | 'slash' = 'none';
  /**
   * 保存 URL 前缀与 HTML/CSS 模式并创建跨块解码器，状态机初始为空。
   * EN: Stores URL prefix and HTML/CSS mode and creates a streaming decoder with an initially empty state machine.
   */
  constructor(
    private prefix: string,
    private css: boolean,
    encoding: ResolvedTextEncoding,
  ) {
    super();
    this.decoder = new TextDecoder(encoding);
  }
  /**
   * 逐字符维护短属性名、引号和斜杠状态，只为 src/href/poster 或 CSS url 的根相对地址补前缀；协议相对 // 保持原样，状态跨块保留且缓存有界。
   * EN: Tracks short names, quotes and slashes character by character, prefixing root-relative src/href/poster or CSS url references. Protocol-relative // remains unchanged; bounded state survives chunk boundaries.
   */
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
  /**
   * 流式解码当前块并输出重写文本，保留未完成编码和属性状态；错误交回调处理。
   * EN: Streaming-decodes a chunk and emits rewritten text while retaining incomplete encoding/attribute state; errors reach the callback.
   */
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
  /**
   * 刷新解码器和重写器，补回末尾尚未判定的单斜杠；解码错误使流失败。
   * EN: Flushes decoding/rewriting and restores an unresolved trailing slash; decode failures fail the stream.
   */
  _flush(callback: (error?: Error | null, data?: string) => void) {
    try {
      callback(null, this.rewrite(this.decoder.decode()) + (this.state === 'slash' ? '/' : ''));
    } catch (error) {
      callback(error as Error);
    }
  }
}
