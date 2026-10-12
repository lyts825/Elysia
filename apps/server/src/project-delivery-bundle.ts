import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { AppError, type Artifact, type Run } from '../../../packages/contracts/src/index.js';
import type {
  ProjectDeliveryBundlePlan,
  ProjectDeliveryManifest,
  ProjectDeliveryBundleJob,
} from '../../../packages/contracts/src/project-delivery.js';
import type { SourceArtifact } from '../../../packages/contracts/src/workflow.js';
import { hash, stable, type Store } from '../../../packages/storage/src/index.js';
import { ArtifactPreviewService } from './artifact-preview.js';
import { projectDeliveryMarkdown } from './project-delivery-export.js';
import { BundleJobStorage } from './project-delivery-bundle-jobs.js';
import type { ProjectDeliveryArchiveService } from './project-delivery-archive.js';

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
    private progress?: (bytes: number) => void,
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
      this.progress?.(this.offset);
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
  private temporary: BundleJobStorage;
  private tracked = new Map<
    string,
    {
      view: ProjectDeliveryBundleJob;
      sessionHash: string;
      controller: AbortController;
      work?: Promise<void>;
      disposing?: Promise<void>;
      timer?: ReturnType<typeof setTimeout>;
      bundle?: Awaited<ReturnType<ProjectDeliveryBundleService['bundle']>>;
    }
  >();
  private work = new Set<Promise<void>>();
  constructor(
    private store: Store,
    private archives?: ProjectDeliveryArchiveService,
  ) {
    this.previews = new ArtifactPreviewService(store);
    this.temporary = new BundleJobStorage(store.directory);
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
    progress?: (bytes: number) => void,
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
          progress?.(chunk.length);
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
  async plan(
    manifest: ProjectDeliveryManifest,
    signal?: AbortSignal,
    progress?: (change: Partial<ProjectDeliveryBundleJob>) => void,
  ): Promise<ProjectDeliveryBundlePlan> {
    const job = this.acquire(signal);
    try {
      const selected = selections(manifest),
        issues: ProjectDeliveryBundlePlan['issues'] = [];
      let totalBytes = 0;
      let bytesDone = 0,
        filesDone = 0;
      progress?.({ filesTotal: selected.length, filesDone: 0, bytesDone: 0, bytesTotal: null });
      for (const row of selected) {
        job.signal.throwIfAborted();
        progress?.({ currentFile: row.file.name });
        try {
          await this.consume(
            row,
            manifest,
            job.signal,
            undefined,
            PROJECT_DELIVERY_BUNDLE_MAX_BYTES - totalBytes,
            (bytes) => {
              bytesDone += bytes;
              progress?.({ bytesDone });
            },
          );
        } catch (error) {
          job.signal.throwIfAborted();
          Object.assign(row.file, failure(error));
          const size = (error as AppError)?.details as { size?: number } | null;
          if (Number.isSafeInteger(size?.size) && size!.size! >= 0) row.file.size = size!.size!;
        }
        totalBytes += row.file.size ?? 0;
        progress?.({ filesDone: ++filesDone });
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
  async bundle(
    manifest: ProjectDeliveryManifest,
    signal?: AbortSignal,
    options?: {
      jobId: string;
      sessionHash: string;
      progress?: (change: Partial<ProjectDeliveryBundleJob>) => void;
    },
  ) {
    const job = this.acquire(signal);
    let temporary: Awaited<ReturnType<BundleJobStorage['create']>> | undefined,
      handle: FileHandle | undefined,
      stream: Readable | undefined;
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
          if (temporary) await temporary.dispose();
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
      temporary = await this.temporary.create({
        jobId: options?.jobId ?? randomUUID(),
        projectId: manifest.projectId,
        manifestId: manifest.id,
        manifestHash: manifest.hash,
        sessionHash: options?.sessionHash ?? hash('legacy-request'),
      });
      const filename = temporary.filename;
      handle = await fs.open(filename, 'wx', 0o600);
      const zip = new ZipWriter(handle, job.signal, (bytesDone) => options?.progress?.({ bytesDone }));
      let filesDone = 0;
      for (const row of selected) {
        job.signal.throwIfAborted();
        options?.progress?.({ currentFile: row.file.name });
        await this.consume(row, manifest, job.signal, zip, PROJECT_DELIVERY_BUNDLE_MAX_BYTES - zip.offset);
        options?.progress?.({ filesDone: ++filesDone });
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
      // Open failures must reject preparation, before announcing a ready job.
      handle = await fs.open(filename, 'r');
      stream = handle.createReadStream({ highWaterMark: 64 * 1024 });
      handle = undefined;
      void finished(stream).catch(() => {});
      stream.once('error', () =>
        options?.progress?.({
          stage: 'failed',
          error: { code: 'PROJECT_BUNDLE_SEND_FAILED', message: '文件包无法发送，请重新检查后重试' },
        }),
      );
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
      return { stream, size: zip.offset, filename, fileCount: selected.length, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
  async close() {
    this.lifetime.abort();
    for (const tracked of this.tracked.values()) {
      clearTimeout(tracked.timer);
      tracked.controller.abort();
      await tracked.bundle?.dispose();
    }
    await Promise.allSettled(this.work);
    await Promise.allSettled(this.jobs);
    await this.temporary.ready.catch(() => {});
    await this.previews.close();
  }
  /** Retained ZIP reads share the same bounded slots and shutdown cancellation. */
  async body(
    load: (signal: AbortSignal) => Promise<{ stream: Readable; size: number; dispose: () => Promise<void> }>,
    signal?: AbortSignal,
  ) {
    const job = this.acquire(signal);
    let resource: Awaited<ReturnType<typeof load>> | undefined, disposing: Promise<void> | undefined;
    const dispose = () =>
      (disposing ??= (async () => {
        await resource?.dispose();
      })().finally(job.release));
    try {
      resource = await load(job.signal);
      const abort = () => {
        void dispose().catch(() => {});
      };
      job.signal.addEventListener('abort', abort, { once: true });
      resource.stream.once('close', () => {
        job.signal.removeEventListener('abort', abort);
        void dispose().catch(() => {});
      });
      if (job.signal.aborted) {
        await dispose();
        job.signal.throwIfAborted();
      }
      return { stream: resource.stream, size: resource.size, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  private bound(manifest: ProjectDeliveryManifest, jobId: string, sessionHash: string, clientId?: string) {
    const job = this.tracked.get(jobId);
    if (
      !job ||
      job.sessionHash !== sessionHash ||
      job.view.clientId !== (clientId ?? null) ||
      job.view.projectId !== manifest.projectId ||
      job.view.manifestId !== manifest.id ||
      job.view.manifestHash !== manifest.hash
    )
      throw new AppError(
        'PROJECT_BUNDLE_JOB_GONE',
        '文件包作业已结束或不属于当前会话，请重新检查',
        false,
        null,
        410,
      );
    return job;
  }
  private expiry(job: ReturnType<ProjectDeliveryBundleService['bound']>, milliseconds: number) {
    clearTimeout(job.timer);
    job.view.expiresAt = new Date(Date.now() + milliseconds).toISOString();
    job.timer = setTimeout(() => {
      if (['completed', 'failed', 'cancelled'].includes(job.view.stage)) this.tracked.delete(job.view.id);
      else {
        job.view.stage = 'failed';
        job.view.error = { code: 'PROJECT_BUNDLE_EXPIRED', message: '文件包作业已超时，请重新检查后重试' };
        job.controller.abort();
        job.disposing = job.bundle?.dispose();
        void job.disposing?.catch(() => {});
        this.expiry(job, 120_000);
      }
    }, milliseconds);
    job.timer.unref();
  }
  job(
    manifest: ProjectDeliveryManifest,
    jobId: string,
    sessionHash: string,
    clientId?: string,
  ): ProjectDeliveryBundleJob {
    return structuredClone(this.bound(manifest, jobId, sessionHash, clientId).view);
  }
  async start(
    manifest: ProjectDeliveryManifest,
    input: { jobId: string; kind: 'check' | 'download' | 'save'; clientId?: string },
    sessionHash: string,
  ) {
    this.lifetime.signal.throwIfAborted();
    if (input.kind === 'save') {
      if (!this.archives)
        throw new AppError('PROJECT_ARCHIVE_UNAVAILABLE', '当前入口未启用保存文件包', false, null, 503);
      this.archives.writable(manifest);
    }
    if (this.tracked.has(input.jobId)) {
      const old = this.bound(manifest, input.jobId, sessionHash, input.clientId);
      if (old.view.kind !== input.kind)
        throw new AppError(
          'PROJECT_BUNDLE_JOB_CONFLICT',
          '同一作业标识不能更改操作，请创建新作业',
          false,
          null,
          409,
        );
      return structuredClone(old.view);
    }
    if (this.tracked.size >= 64)
      throw new AppError('PROJECT_BUNDLE_BUSY', '正在核验或下载其他文件包，请稍后重试', true, null, 429);
    const job = {
      view: {
        id: input.jobId,
        clientId: input.clientId ?? null,
        projectId: manifest.projectId,
        manifestId: manifest.id,
        manifestHash: manifest.hash,
        kind: input.kind,
        stage: 'verifying',
        filesDone: 0,
        filesTotal: 0,
        bytesDone: 0,
        bytesTotal: null,
        currentFile: null,
        expiresAt: '',
      } as ProjectDeliveryBundleJob,
      sessionHash,
      controller: new AbortController(),
    } as ReturnType<ProjectDeliveryBundleService['bound']>;
    this.tracked.set(input.jobId, job);
    this.expiry(job, 300_000);
    // A fresh operation on the same frozen manifest supersedes abandoned work
    // from a reload. Reserving its identity first also serializes concurrent retries.
    for (const previous of this.tracked.values()) {
      if (job.controller.signal.aborted) return structuredClone(job.view);
      if (
        previous !== job &&
        input.clientId !== undefined &&
        previous.view.clientId === input.clientId &&
        previous.sessionHash === sessionHash &&
        previous.view.projectId === manifest.projectId &&
        previous.view.manifestId === manifest.id &&
        previous.view.manifestHash === manifest.hash
      ) {
        if (!['completed', 'failed', 'cancelled'].includes(previous.view.stage))
          await this.cancel(manifest, previous.view.id, sessionHash, input.clientId);
        // A cancelled predecessor can still be closing its ZIP and holding a slot.
        await previous.disposing;
        await previous.work;
        if (job.controller.signal.aborted) return structuredClone(job.view);
      }
    }
    if (job.controller.signal.aborted) return structuredClone(job.view);
    if (this.active >= 2) {
      job.view.stage = 'failed';
      job.view.error = { code: 'PROJECT_BUNDLE_BUSY', message: '正在核验或下载其他文件包，请稍后重试' };
      this.expiry(job, 120_000);
      throw new AppError('PROJECT_BUNDLE_BUSY', job.view.error.message, true, null, 429);
    }
    const signal = AbortSignal.any([job.controller.signal, this.lifetime.signal]);
    const update = (change: Partial<ProjectDeliveryBundleJob>) => {
      if (!signal.aborted && !['cancelled', 'failed', 'completed'].includes(job.view.stage)) {
        Object.assign(job.view, change);
        if (change.stage === 'failed') {
          job.disposing = job.bundle?.dispose();
          void job.disposing?.catch(() => {});
          this.expiry(job, 120_000);
        }
      }
    };
    const work = (async () => {
      try {
        if (input.kind === 'save') {
          const existing = this.archives!.get(manifest);
          if (existing) {
            update({
              stage: 'completed',
              archive: existing,
              filesTotal: existing.fileCount,
              filesDone: existing.fileCount,
              bytesDone: existing.size,
              bytesTotal: existing.size,
            });
            this.expiry(job, 120_000);
            return;
          }
        }
        const plan = await this.plan(manifest, signal, update);
        signal.throwIfAborted();
        update({ plan, bytesTotal: plan.totalBytes, currentFile: null });
        if (input.kind === 'check') {
          update({ stage: 'completed' });
          this.expiry(job, 120_000);
          return;
        }
        if (!plan.canDownload)
          throw new AppError(
            plan.issues[0]?.code ?? 'PROJECT_BUNDLE_SOURCES',
            plan.issues[0]?.message ?? '冻结来源无法打包',
            false,
            null,
            422,
          );
        update({ stage: 'preparing', filesDone: 0, bytesDone: 0, bytesTotal: plan.archiveBytes });
        const bundle = await this.bundle(manifest, signal, {
          jobId: input.jobId,
          sessionHash,
          progress: update,
        });
        job.bundle = bundle;
        if (signal.aborted) {
          await bundle.dispose();
          signal.throwIfAborted();
        }
        if (input.kind === 'save') {
          update({ stage: 'saving', currentFile: null, bytesDone: 0, bytesTotal: bundle.size });
          await this.archives!.save(
            manifest,
            bundle,
            signal,
            (archive) => {
              // The record commit is synchronous. Its receipt wins over later cancellation.
              Object.assign(job.view, {
                stage: 'completed',
                archive,
                currentFile: null,
                bytesDone: archive.size,
                bytesTotal: archive.size,
                filesDone: archive.fileCount,
                filesTotal: archive.fileCount,
              });
              this.expiry(job, 120_000);
            },
            (bytesDone) => update({ bytesDone }),
          );
          return;
        }
        update({ stage: 'ready', currentFile: null, bytesDone: bundle.size, bytesTotal: bundle.size });
        this.expiry(job, 60_000);
      } catch (error) {
        if (!signal.aborted && job.view.stage !== 'completed') {
          job.view.stage = 'failed';
          job.view.error =
            error instanceof AppError
              ? { code: error.code, message: error.message }
              : { code: 'PROJECT_BUNDLE_FAILED', message: '文件包处理失败，请重新检查后重试' };
          this.expiry(job, 120_000);
        }
      } finally {
        if (input.kind === 'save' && job.bundle) {
          job.disposing = job.bundle.dispose();
          await job.disposing.catch(() => {});
        }
      }
    })();
    job.work = work;
    this.work.add(work);
    void work.finally(() => this.work.delete(work));
    return structuredClone(job.view);
  }
  async cancel(manifest: ProjectDeliveryManifest, jobId: string, sessionHash: string, clientId?: string) {
    const job = this.bound(manifest, jobId, sessionHash, clientId);
    if (!['completed', 'failed', 'cancelled'].includes(job.view.stage)) {
      job.view.stage = 'cancelled';
      job.controller.abort();
      job.disposing = job.bundle?.dispose();
      await job.disposing;
      this.expiry(job, 120_000);
    }
    return structuredClone(job.view);
  }
  send(
    manifest: ProjectDeliveryManifest,
    jobId: string,
    sessionHash: string,
    signal: AbortSignal,
    clientId?: string,
  ) {
    const job = this.bound(manifest, jobId, sessionHash, clientId);
    if (job.view.kind !== 'download' || job.view.stage !== 'ready' || !job.bundle)
      throw new AppError(
        'PROJECT_BUNDLE_JOB_NOT_READY',
        '文件包未就绪或已被领取，请重新检查后重试',
        false,
        null,
        409,
      );
    const bundle = job.bundle;
    job.view.stage = 'sending';
    job.view.bytesDone = 0;
    this.expiry(job, 300_000);
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        if (job.view.stage === 'sending') job.view.bytesDone += chunk.length;
        callback(null, chunk);
      },
    });
    const abort = () => {
      void this.cancel(manifest, jobId, sessionHash, clientId).catch(() => {});
      meter.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    job.controller.signal.addEventListener('abort', () => meter.destroy(), { once: true });
    bundle.stream.on('error', (error) => meter.destroy(error));
    meter.once('end', () => {
      if (job.view.stage === 'sending') {
        job.view.stage = 'completed';
        job.disposing = bundle.dispose();
        void job.disposing.catch(() => {});
        this.expiry(job, 120_000);
      }
    });
    meter.once('close', () => {
      signal.removeEventListener('abort', abort);
      if (job.view.stage === 'sending') {
        job.view.stage = 'failed';
        job.view.error = { code: 'PROJECT_BUNDLE_SEND_FAILED', message: '文件包发送中断，请重新检查后重试' };
        this.expiry(job, 120_000);
      }
      job.disposing = bundle.dispose();
      void job.disposing.catch(() => {});
    });
    if (signal.aborted) abort();
    else bundle.stream.pipe(meter);
    return { stream: meter, size: bundle.size, dispose: bundle.dispose };
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
