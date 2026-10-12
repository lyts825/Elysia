import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { AppError, type Artifact, type Run } from '../../../packages/contracts/src/index.js';
import type {
  ProjectDeliveryBundlePlan,
  ProjectDeliveryManifest,
} from '../../../packages/contracts/src/project-delivery.js';
import type { SourceArtifact } from '../../../packages/contracts/src/workflow.js';
import { hash, stable, type Store } from '../../../packages/storage/src/index.js';
import { ArtifactPreviewService } from './artifact-preview.js';
import { projectDeliveryMarkdown } from './project-delivery-export.js';

export const PROJECT_DELIVERY_BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
const maxFiles = 800;
type PlanFile = ProjectDeliveryBundlePlan['files'][number];
type Selection = { file: PlanFile; frozen: SourceArtifact };
type Document = { path: string; bytes: Buffer };
const tooLarge = () =>
  new AppError(
    'PROJECT_BUNDLE_TOO_LARGE',
    '完整文件包超过 64 MiB 上限，请减少所选产物后创建新清单',
    false,
    null,
    413,
  );

// Paths are generated, never taken from objectRef, source or user-supplied directories.
function safeName(name: string) {
  let base = (name.split(/[\\/]/).at(-1) ?? '').replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_');
  base = [...base]
    .slice(0, 100)
    .join('')
    .replace(/[. ]+$/g, '');
  if (!base || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base)) base = '_' + base;
  return base;
}
function selections(manifest: ProjectDeliveryManifest): Selection[] {
  if (manifest.version !== 1 || !Array.isArray(manifest.items) || manifest.items.length > 40)
    throw new AppError('PROJECT_BUNDLE_MANIFEST', '冻结清单格式不可导出', false, null, 422);
  const result: Selection[] = [];
  for (const [itemIndex, item] of manifest.items.entries()) {
    if (!Array.isArray(item.artifacts) || item.artifacts.length > 20)
      throw new AppError('PROJECT_BUNDLE_MANIFEST', '冻结清单产物数量不可导出', false, null, 422);
    for (const [artifactIndex, frozen] of item.artifacts.entries()) {
      if (typeof frozen.name !== 'string' || !/^[a-f0-9]{64}$/.test(frozen.hash))
        throw new AppError('PROJECT_BUNDLE_MANIFEST', '冻结产物元数据不可导出', false, null, 422);
      result.push({
        frozen,
        file: {
          itemId: item.item.id,
          runId: item.run.id,
          artifactId: frozen.id,
          name: frozen.name,
          hash: frozen.hash,
          path: `files/${String(itemIndex + 1).padStart(3, '0')}/${String(artifactIndex + 1).padStart(3, '0')}-${safeName(frozen.name)}`,
          size: null,
          state: 'unavailable',
        },
      });
    }
  }
  if (result.length > maxFiles) throw tooLarge();
  return result;
}
function source(store: Store, projectId: string, selected: Selection) {
  const run = store.get<Run>('runs', selected.file.runId);
  if (!run) throw new AppError('PROJECT_BUNDLE_MISSING', '原任务已删除', false, null, 404);
  if (run.projectId !== projectId || run.kind !== 'task' || (run.execution?.kind ?? 'native') !== 'native')
    throw new AppError('PROJECT_BUNDLE_SCOPE', '原任务不属于此项目的原生交付', false, null, 409);
  const current = store.get<Artifact>('artifacts', selected.frozen.id);
  if (!current) throw new AppError('PROJECT_BUNDLE_MISSING', '所选产物记录已删除', false, null, 404);
  if (current.runId !== run.id)
    throw new AppError('PROJECT_BUNDLE_SCOPE', '产物归属与冻结记录不一致', false, null, 409);
  for (const key of ['id', 'name', 'version', 'hash', 'mediaType', 'verified'] as const)
    if (current[key] !== selected.frozen[key])
      throw new AppError(
        'PROJECT_BUNDLE_CHANGED',
        '产物元数据已变化，不能用当前内容替代冻结来源',
        false,
        null,
        409,
      );
  return current;
}
function failure(error: unknown): { state: PlanFile['state']; reason: string } {
  const code = (error as { code?: string })?.code;
  if (['ENOENT', 'OBJECT_NOT_FOUND', 'PROJECT_BUNDLE_MISSING'].includes(code ?? ''))
    return { state: 'missing', reason: '冻结来源或对象正文已缺失' };
  if (['PROJECT_BUNDLE_CHANGED', 'FILE_CHANGED'].includes(code ?? ''))
    return { state: 'changed', reason: '冻结来源已变化，不能替换为最新内容' };
  if (['ARTIFACT_SIZE_LIMIT', 'PROJECT_BUNDLE_TOO_LARGE'].includes(code ?? ''))
    return { state: 'too_large', reason: '产物或完整文件包超过 64 MiB 上限' };
  return { state: 'unavailable', reason: '来源归属、对象引用或正文完整性核验失败' };
}
function documents(manifest: ProjectDeliveryManifest, files: PlanFile[]): Document[] {
  const docs = [
    { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
    { path: 'manifest.md', bytes: Buffer.from(projectDeliveryMarkdown(manifest)) },
    {
      path: 'README.md',
      bytes: Buffer.from(
        [
          '# 项目文件交付包',
          '本包按冻结清单导出所选产物的原始字节，可复制到其他位置并使用标准 ZIP 工具解压读取。',
          'manifest.json / manifest.md 是原有不可变元数据清单；文件正文位于 files/，原始名称与安全相对路径的对应关系见 bundle-index.json。',
          '仅包含清单明确选择的文件，不自动补齐依赖，不保证网站、应用或绝对路径引用在新位置可运行。',
          'SHA256SUMS.txt 为包内文件的 SHA-256 校验索引（索引本身不自校验）；可在解压目录用 sha256sum -c SHA256SUMS.txt 核对，或使用支持 SHA-256 的工具。',
          '冻结清单哈希按删除 hash 字段后的稳定键序列化计算，与 manifest.json 的文件字节哈希不同。',
          '本包仅表示所列字节与冻结元数据一致，不替代人工验收，不写入新的成功交付记录，也不承诺服务端永久保留来源正文。',
          `清单 ID：${manifest.id}\n冻结清单 SHA-256：${manifest.hash}`,
          '',
        ].join('\n\n'),
      ),
    },
  ];
  const entries = [
    ...files.map((file) => ({
      path: file.path,
      size: file.size!,
      sha256: file.hash,
      itemId: file.itemId,
      runId: file.runId,
      artifactId: file.artifactId,
      originalName: file.name,
    })),
    ...docs.map((doc) => ({ path: doc.path, size: doc.bytes.length, sha256: hash(doc.bytes) })),
  ];
  const index = Buffer.from(
    JSON.stringify(
      {
        version: 1,
        format: 'zip-store',
        manifestId: manifest.id,
        manifestHash: manifest.hash,
        files: entries,
      },
      null,
      2,
    ) + '\n',
  );
  docs.push({ path: 'bundle-index.json', bytes: index });
  const sums =
    [...entries.map((entry) => `${entry.sha256}  ${entry.path}`), `${hash(index)}  bundle-index.json`].join(
      '\n',
    ) + '\n';
  docs.push({ path: 'SHA256SUMS.txt', bytes: Buffer.from(sums) });
  return docs;
}
const zipOverhead = (name: string) => 30 + 16 + 46 + 2 * Buffer.byteLength(name);
function archiveSize(files: PlanFile[], docs: Document[]) {
  return (
    22 +
    files.reduce((sum, file) => sum + file.size! + zipOverhead(file.path), 0) +
    docs.reduce((sum, doc) => sum + doc.bytes.length + zipOverhead(doc.path), 0)
  );
}

// Standard ZIP STORE with data descriptors. Only 64 KiB stream chunks and a
// bounded central directory are held in memory; no external archiver is needed.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
class ZipWriter {
  offset = 0;
  private entries: Buffer[] = [];
  constructor(
    private handle: FileHandle,
    private signal: AbortSignal,
  ) {}
  private async write(bytes: Buffer) {
    if (this.offset + bytes.length > PROJECT_DELIVERY_BUNDLE_MAX_BYTES) throw tooLarge();
    let at = 0;
    while (at < bytes.length) {
      this.signal.throwIfAborted();
      const { bytesWritten } = await this.handle.write(bytes, at, bytes.length - at, this.offset);
      if (!bytesWritten) throw new Error('ZIP write made no progress');
      at += bytesWritten;
      this.offset += bytesWritten;
    }
  }
  async add(name: string, stream: AsyncIterable<Buffer>, expectedSize: number, expectedHash: string) {
    const filename = Buffer.from(name),
      start = this.offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x808, 6);
    local.writeUInt16LE(33, 12);
    local.writeUInt16LE(filename.length, 26);
    await this.write(local);
    await this.write(filename);
    let size = 0,
      crc = 0xffffffff;
    const digest = createHash('sha256');
    for await (const chunk of stream) {
      this.signal.throwIfAborted();
      size += chunk.length;
      if (size > expectedSize) throw new AppError('OBJECT_CORRUPT', '产物正文大小已变化');
      digest.update(chunk);
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
      await this.write(chunk);
    }
    if (size !== expectedSize || digest.digest('hex') !== expectedHash)
      throw new AppError('OBJECT_CORRUPT', '产物正文与冻结 SHA-256 不一致');
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x808, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(start, 42);
    filename.copy(central, 46);
    this.entries.push(central);
  }
  async finish() {
    const start = this.offset;
    for (const entry of this.entries) await this.write(entry);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    await this.handle.sync();
  }
}

export class ProjectDeliveryBundleService {
  private previews: ArtifactPreviewService;
  private lifetime = new AbortController();
  private active = 0;
  private jobs = new Set<Promise<void>>();
  constructor(private store: Store) {
    this.previews = new ArtifactPreviewService(store);
  }
  private acquire(signal?: AbortSignal) {
    this.lifetime.signal.throwIfAborted();
    if (this.active >= 2)
      throw new AppError('PROJECT_BUNDLE_BUSY', '正在核验或下载其他文件包，请稍后重试', true, null, 429);
    this.active++;
    let resolve!: () => void,
      released = false;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    this.jobs.add(done);
    return {
      signal: AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
      release: () => {
        if (!released) {
          released = true;
          this.active--;
          this.jobs.delete(done);
          resolve();
        }
      },
    };
  }
  private async consume(
    selected: Selection,
    manifest: ProjectDeliveryManifest,
    signal: AbortSignal,
    zip?: ZipWriter,
    remaining = PROJECT_DELIVERY_BUNDLE_MAX_BYTES,
  ) {
    const resource = await this.previews.resource(source(this.store, manifest.projectId, selected), {
      signal,
      maxBytes: remaining,
    });
    // ZIP header writes can yield before iteration attaches its error listener.
    const closed = finished(resource.stream).catch(() => {});
    selected.file.size = resource.size;
    try {
      if (zip) await zip.add(selected.file.path, resource.stream, resource.size, selected.frozen.hash);
      else {
        const digest = createHash('sha256');
        let size = 0;
        for await (const chunk of resource.stream) {
          signal.throwIfAborted();
          size += chunk.length;
          if (size > resource.size || size > remaining)
            throw new AppError('OBJECT_CORRUPT', '产物正文大小不一致');
          digest.update(chunk);
        }
        if (size !== resource.size || digest.digest('hex') !== selected.frozen.hash)
          throw new AppError('OBJECT_CORRUPT', '产物正文与冻结 SHA-256 不一致');
      }
      signal.throwIfAborted();
      source(this.store, manifest.projectId, selected);
      selected.file.state = 'ready';
    } finally {
      resource.stream.destroy();
      await closed;
    }
  }
  async plan(manifest: ProjectDeliveryManifest, signal?: AbortSignal): Promise<ProjectDeliveryBundlePlan> {
    const job = this.acquire(signal);
    try {
      const selected = selections(manifest),
        issues: ProjectDeliveryBundlePlan['issues'] = [];
      let totalBytes = 0;
      for (const row of selected) {
        job.signal.throwIfAborted();
        try {
          await this.consume(
            row,
            manifest,
            job.signal,
            undefined,
            PROJECT_DELIVERY_BUNDLE_MAX_BYTES - totalBytes,
          );
        } catch (error) {
          job.signal.throwIfAborted();
          Object.assign(row.file, failure(error));
          const size = (error as AppError)?.details as { size?: number } | null;
          if (Number.isSafeInteger(size?.size) && size!.size! >= 0) row.file.size = size!.size!;
        }
        totalBytes += row.file.size ?? 0;
      }
      for (const row of selected.filter((row) => row.file.state === 'ready')) {
        try {
          source(this.store, manifest.projectId, row);
        } catch (error) {
          Object.assign(row.file, failure(error));
        }
      }
      if (!selected.length)
        issues.push({
          code: 'PROJECT_BUNDLE_EMPTY',
          message: '清单未选择产物，仅包含元数据；可下载现有 JSON / Markdown 清单',
        });
      const files = selected.map((row) => row.file);
      let archiveBytes: number | null = null;
      if (files.length && files.every((file) => file.state === 'ready')) {
        archiveBytes = archiveSize(files, documents(manifest, files));
        if (archiveBytes > PROJECT_DELIVERY_BUNDLE_MAX_BYTES)
          issues.push({ code: 'PROJECT_BUNDLE_TOO_LARGE', message: tooLarge().message });
      }
      if (files.some((file) => file.state !== 'ready'))
        issues.push({
          code: 'PROJECT_BUNDLE_SOURCES',
          message: '存在缺失、变化、超限或未通过完整性核验的来源，不能生成完整文件包',
        });
      return {
        projectId: manifest.projectId,
        manifestId: manifest.id,
        manifestHash: manifest.hash,
        format: 'zip',
        fileCount: files.length,
        totalBytes,
        archiveBytes,
        maxBytes: PROJECT_DELIVERY_BUNDLE_MAX_BYTES,
        canDownload: files.length > 0 && !issues.length,
        files,
        issues,
      };
    } finally {
      job.release();
    }
  }
  async bundle(manifest: ProjectDeliveryManifest, signal?: AbortSignal) {
    const job = this.acquire(signal);
    let directory: string | undefined, handle: FileHandle | undefined, stream: Readable | undefined;
    let disposing: Promise<void> | undefined;
    const dispose = () =>
      (disposing ??= (async () => {
        if (stream) {
          stream.destroy();
          await finished(stream).catch(() => {});
        }
        try {
          await handle?.close();
        } finally {
          handle = undefined;
          if (directory) await fs.rm(directory, { recursive: true, force: true });
        }
      })().finally(job.release));
    try {
      const selected = selections(manifest);
      if (!selected.length)
        throw new AppError(
          'PROJECT_BUNDLE_EMPTY',
          '清单未选择产物，请下载 JSON / Markdown 元数据清单',
          false,
          null,
          422,
        );
      job.signal.throwIfAborted();
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'elysia-delivery-bundle-'));
      const filename = path.join(directory, 'delivery.zip');
      handle = await fs.open(filename, 'wx', 0o600);
      const zip = new ZipWriter(handle, job.signal);
      for (const row of selected) {
        job.signal.throwIfAborted();
        await this.consume(row, manifest, job.signal, zip, PROJECT_DELIVERY_BUNDLE_MAX_BYTES - zip.offset);
      }
      const files = selected.map((row) => row.file),
        docs = documents(manifest, files);
      if (archiveSize(files, docs) > PROJECT_DELIVERY_BUNDLE_MAX_BYTES) throw tooLarge();
      for (const doc of docs)
        await zip.add(doc.path, Readable.from([doc.bytes]), doc.bytes.length, hash(doc.bytes));
      for (const row of selected) source(this.store, manifest.projectId, row);
      await zip.finish();
      job.signal.throwIfAborted();
      await handle.close();
      handle = undefined;
      stream = createReadStream(filename, { highWaterMark: 64 * 1024 });
      const abort = () => {
        void dispose().catch(() => {});
      };
      job.signal.addEventListener('abort', abort, { once: true });
      stream.once('close', () => {
        job.signal.removeEventListener('abort', abort);
        void dispose().catch(() => {});
      });
      if (job.signal.aborted) {
        await dispose();
        job.signal.throwIfAborted();
      }
      return { stream, size: zip.offset, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
  async close() {
    this.lifetime.abort();
    await Promise.allSettled(this.jobs);
    await this.previews.close();
  }
}

/** The caller binds the export to the exact manifest they reviewed. */
export function assertBundleManifest(manifest: ProjectDeliveryManifest, expectedHash: string) {
  const { hash: actual, ...body } = manifest;
  if (actual !== expectedHash || hash(stable(body)) !== actual)
    throw new AppError(
      'PROJECT_BUNDLE_MANIFEST_CHANGED',
      '冻结清单与当前选择不一致，请重新读取',
      false,
      null,
      409,
    );
}
