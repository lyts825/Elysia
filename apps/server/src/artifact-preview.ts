import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { AppError, invariant, type Artifact } from '../../../packages/contracts/src/index.js';
import {
  isBinaryFile,
  type TextFileEncoding,
  type TextPageOptions,
} from '../../../packages/contracts/src/files.js';
import type { PreviewFile } from '../../../packages/contracts/src/preview.js';
import type { Store } from '../../../packages/storage/src/index.js';
import {
  fileVersion,
  inspectFile,
  readTextPage,
  readTextSource,
  streamFile,
  type FileResource,
  type FileStat,
  type TextReadHandle,
} from './file-reader.js';

const corrupt = () => new AppError('OBJECT_CORRUPT', '对象哈希不匹配');
const cacheLimit = 16;
type CompressedRow = { hash: string; raw_size: number; compressed_size: number };

class CompressedSnapshot {
  readonly db: DatabaseSync;
  readonly row: CompressedRow;
  private active = new Set<Readable>();
  private sources = new Set<Readable>();
  private closed = false;
  onClose?: () => void;
  constructor(
    store: Store,
    readonly ref: string,
    readonly expectedHash: string,
  ) {
    this.db = new DatabaseSync(path.join(store.directory, 'state.db'), { readOnly: true });
    try {
      this.db.exec('BEGIN');
      this.row = this.db
        .prepare(
          'SELECT hash,raw_size,length(content) AS compressed_size FROM compressed_objects WHERE ref=?',
        )
        .get(ref) as CompressedRow;
      if (!this.row) throw new AppError('OBJECT_NOT_FOUND', '压缩对象不存在', false, null, 404);
      if (this.row.hash !== expectedHash || !Number.isSafeInteger(this.row.raw_size) || this.row.raw_size < 0)
        throw corrupt();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  raw(signal?: AbortSignal) {
    const db = this.db,
      ref = this.ref,
      size = this.row.compressed_size,
      snapshot = this;
    const source = Readable.from(
      (async function* () {
        for (let offset = 0; offset < size; offset += 64 * 1024) {
          if (snapshot.closed) return;
          signal?.throwIfAborted();
          const row = db
            .prepare('SELECT substr(content,?,?) AS chunk FROM compressed_objects WHERE ref=?')
            .get(offset + 1, 64 * 1024, ref) as { chunk: Uint8Array };
          if (!row?.chunk?.length) throw corrupt();
          yield Buffer.from(row.chunk);
        }
      })(),
    );
    const stream = createGunzip({ chunkSize: 64 * 1024 });
    source.on('error', (error) => stream.destroy(error));
    this.sources.add(source);
    stream.once('close', () => {
      source.destroy();
      this.active.delete(stream);
      this.sources.delete(source);
    });
    this.active.add(stream);
    const abort = () => stream.destroy(new Error('Artifact preview cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    stream.once('close', () => signal?.removeEventListener('abort', abort));
    source.pipe(stream);
    return stream;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const source of this.sources) source.destroy();
    for (const stream of this.active) stream.destroy();
    this.sources.clear();
    this.active.clear();
    this.db.close();
    this.onClose?.();
  }
}

// Random reads keep one decompressed chunk. Backward seeks restart the stream;
// forward seeks skip bytes without accumulating the preceding text.
class CompressedReader {
  private stream: Readable | null = null;
  private iterator: AsyncIterator<Buffer> | null = null;
  private chunk = Buffer.alloc(0);
  private base = 0;
  constructor(
    private snapshot: CompressedSnapshot,
    private signal?: AbortSignal,
  ) {}
  private restart() {
    this.stream?.destroy();
    this.chunk = Buffer.alloc(0);
    this.base = 0;
    this.stream = this.snapshot.raw(this.signal);
    this.iterator = this.stream[Symbol.asyncIterator]();
  }
  async readAt(offset: number, length: number) {
    this.signal?.throwIfAborted();
    if (!length) return Buffer.alloc(0);
    if (!this.iterator || offset < this.base) this.restart();
    const output = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      this.signal?.throwIfAborted();
      while (offset + filled >= this.base + this.chunk.length) {
        this.base += this.chunk.length;
        const next = await this.iterator!.next();
        if (next.done) return output.subarray(0, filled);
        this.chunk = Buffer.from(next.value);
      }
      const within = offset + filled - this.base,
        count = Math.min(this.chunk.length - within, length - filled);
      this.chunk.copy(output, filled, within, within + count);
      filled += count;
    }
    return output;
  }
  close() {
    this.stream?.destroy();
  }
}

export class ArtifactPreviewService {
  private verified = new Map<string, true>();
  private pending = new Map<string, Promise<void>>();
  private closed = false;
  private snapshots = new Set<CompressedSnapshot>();
  private lifetime = new AbortController();
  constructor(private store: Store) {}
  private compressedObject(artifact: Artifact) {
    return (
      artifact.objectRef.startsWith('sqlite:') ||
      !!this.store.db.prepare('SELECT 1 FROM compressed_objects WHERE ref=?').get(artifact.objectRef)
    );
  }
  private async verify(key: string, work: () => Promise<void>) {
    invariant(!this.closed, 'PREVIEW_CLOSED', '预览服务已关闭');
    if (this.verified.has(key)) {
      this.verified.delete(key);
      this.verified.set(key, true);
      return;
    }
    const current = this.pending.get(key);
    if (current) return current;
    const promise = work()
      .then(() => {
        if (this.closed) return;
        if (this.verified.size >= cacheLimit) this.verified.delete(this.verified.keys().next().value!);
        this.verified.set(key, true);
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
  private dbVersion() {
    const version = this.store.db.prepare('PRAGMA data_version').get() as { data_version: number };
    const changed = this.store.db.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    return `${version.data_version}:${changed.changes}`;
  }
  private async disk(artifact: Artifact, signal?: AbortSignal) {
    invariant(
      /^objects[\\/][a-f0-9]{2}[\\/][a-f0-9]{64}$/.test(artifact.objectRef),
      'INVALID_OBJECT',
      '无效对象引用',
    );
    invariant(path.basename(artifact.objectRef) === artifact.hash, 'OBJECT_CORRUPT', '对象哈希不匹配');
    const root = await fs.realpath(path.join(this.store.directory, 'objects'));
    const filename = path.join(this.store.directory, artifact.objectRef);
    for (const candidate of [path.dirname(filename), filename])
      invariant(!(await fs.lstat(candidate)).isSymbolicLink(), 'INVALID_OBJECT', '对象不能是符号链接');
    invariant((await fs.realpath(filename)).startsWith(root + path.sep), 'INVALID_OBJECT', '对象越界');
    const info = await inspectFile(filename, signal);
    await this.verify(filename + ':' + info.version + ':' + artifact.hash, async () => {
      const resource = await streamFile(filename, 'application/octet-stream', {
        version: info.version,
        signal,
      });
      const digest = createHash('sha256');
      let size = 0;
      for await (const chunk of resource.stream) {
        signal?.throwIfAborted();
        digest.update(chunk);
        size += chunk.length;
      }
      if (size !== info.stat.size || digest.digest('hex') !== artifact.hash) throw corrupt();
      if (fileVersion(await fs.stat(filename)) !== info.version)
        throw new AppError('FILE_CHANGED', '产物对象已改变，请重新读取', false, null, 409);
    });
    signal?.throwIfAborted();
    return { filename, info };
  }
  private async compressed(artifact: Artifact, signal?: AbortSignal) {
    const valid = /^sqlite:[a-f0-9]{64}$/.test(artifact.objectRef)
      ? artifact.objectRef.slice(7) === artifact.hash
      : /^objects[\\/][a-f0-9]{2}[\\/][a-f0-9]{64}$/.test(artifact.objectRef) &&
        path.basename(artifact.objectRef) === artifact.hash;
    invariant(valid, 'INVALID_OBJECT', '无效对象引用');
    const before = this.dbVersion(),
      snapshot = new CompressedSnapshot(this.store, artifact.objectRef, artifact.hash);
    this.snapshots.add(snapshot);
    snapshot.onClose = () => {
      this.snapshots.delete(snapshot);
    };
    const after = this.dbVersion();
    const key =
      artifact.objectRef +
      ':' +
      before +
      ':' +
      snapshot.row.raw_size +
      ':' +
      snapshot.row.compressed_size +
      (before === after ? '' : ':' + randomUUID());
    try {
      await this.verify(key, async () => {
        const digest = createHash('sha256');
        let size = 0;
        for await (const chunk of snapshot.raw(signal)) {
          signal?.throwIfAborted();
          size += chunk.length;
          if (size > snapshot.row.raw_size) throw corrupt();
          digest.update(chunk);
        }
        if (size !== snapshot.row.raw_size || digest.digest('hex') !== artifact.hash) throw corrupt();
      });
      signal?.throwIfAborted();
      return snapshot;
    } catch (error) {
      snapshot.close();
      throw error;
    }
  }
  async preview(
    artifact: Artifact,
    encoding: TextFileEncoding = 'auto',
    options: TextPageOptions = {},
  ): Promise<PreviewFile> {
    invariant(!this.closed, 'PREVIEW_CLOSED', '预览服务已关闭');
    options = {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal,
    };
    let snapshot: CompressedSnapshot | null = null,
      reader: CompressedReader | null = null;
    let result: Awaited<ReturnType<typeof readTextPage>> | null = null,
      prefix: Buffer;
    const canReadText = (prefix: Buffer) => {
      const unicode16 =
        encoding.startsWith('utf-16') ||
        (prefix[0] === 0xff && prefix[1] === 0xfe) ||
        (prefix[0] === 0xfe && prefix[1] === 0xff);
      return (
        !artifact.mediaType.startsWith('image/') &&
        !isBinaryFile(artifact.name, unicode16 ? new Uint8Array() : prefix)
      );
    };
    try {
      if (this.compressedObject(artifact)) {
        snapshot = await this.compressed(artifact, options.signal);
        reader = new CompressedReader(snapshot, options.signal);
        prefix = await reader.readAt(0, Math.min(4096, snapshot.row.raw_size));
        if (canReadText(prefix)) {
          const size = snapshot.row.raw_size;
          const stat = { size, mtimeMs: 0, ctimeMs: 0, dev: 0, ino: 0 } as FileStat;
          const handle = {
            stat: async () => stat,
            read: async (buffer: Buffer, offset: number, length: number, position: number) => {
              const bytes = await reader!.readAt(position, length);
              bytes.copy(buffer, offset);
              return { bytesRead: bytes.length, buffer };
            },
          } as TextReadHandle;
          result = await readTextSource(
            {
              handle,
              stat,
              version: artifact.hash,
              key: artifact.objectRef + ':' + artifact.hash,
              validate: async () => {},
            },
            encoding,
            options,
          );
        }
      } else {
        const { filename, info } = await this.disk(artifact, options.signal);
        prefix = info.prefix;
        if (canReadText(prefix))
          result = await readTextPage(filename, encoding, {
            ...options,
            version: options.version ?? info.version,
          });
      }
      const unicode16 =
        encoding.startsWith('utf-16') ||
        (prefix[0] === 0xff && prefix[1] === 0xfe) ||
        (prefix[0] === 0xfe && prefix[1] === 0xff);
      const kind: PreviewFile['kind'] = artifact.mediaType.startsWith('image/')
        ? 'image'
        : isBinaryFile(artifact.name, unicode16 ? new Uint8Array() : prefix) ||
            (result && result.text.includes('\0'))
          ? 'binary'
          : /\.(md|markdown)$/i.test(artifact.name)
            ? 'markdown'
            : /\.html?$/i.test(artifact.name)
              ? 'html'
              : 'text';
      return {
        path: artifact.name,
        text: ['image', 'binary'].includes(kind) ? null : (result?.text ?? null),
        hash: artifact.hash,
        mediaType: artifact.mediaType,
        kind,
        diff: '',
        diffTruncated: false,
        deleted: false,
        renderUrl: null,
        resourceUrl: `/api/artifacts/${artifact.id}`,
        resourceBase: null,
        page: ['image', 'binary'].includes(kind) ? null : (result?.page ?? null),
        encoding: result?.encoding ?? null,
        encodingSource: result?.encodingSource ?? null,
      };
    } finally {
      reader?.close();
      snapshot?.close();
    }
  }
  async resource(
    artifact: Artifact,
    options: { range?: string; signal?: AbortSignal } = {},
  ): Promise<FileResource> {
    invariant(!this.closed, 'PREVIEW_CLOSED', '预览服务已关闭');
    options = {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal,
    };
    if (!this.compressedObject(artifact)) {
      const { filename, info } = await this.disk(artifact, options.signal);
      return streamFile(filename, artifact.mediaType, {
        ...options,
        version: info.version,
        verifyHash: artifact.hash,
      });
    }
    const snapshot = await this.compressed(artifact, options.signal);
    try {
      // Gzip objects are streamed whole; random text access is supplied by /preview.
      const stream = snapshot.raw(options.signal);
      stream.once('close', () => snapshot.close());
      return {
        stream,
        mediaType: artifact.mediaType,
        version: artifact.hash,
        size: snapshot.row.raw_size,
        status: 200,
        contentLength: snapshot.row.raw_size,
        acceptRanges: false,
      };
    } catch (error) {
      snapshot.close();
      throw error;
    }
  }
  async close() {
    this.closed = true;
    this.lifetime.abort();
    for (const snapshot of this.snapshots) snapshot.close();
    await Promise.allSettled(this.pending.values());
    this.pending.clear();
    this.verified.clear();
    this.snapshots.clear();
  }
}
