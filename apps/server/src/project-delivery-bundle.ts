/**
 * 构建和校验项目交付包。
 * 核验冻结产物并生成有界 ZIP 或读取保存包，统一管理会话作业、临时文件、取消与配额；超限或变化拒绝整个包。
 * EN: Builds and validates project-delivery bundles. Verifies frozen artifacts for bounded ZIP generation/saved archives with session jobs, temporary storage, cancellation and quotas; limits/changes reject the whole bundle.
 */
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
/**
 * 创建完整 ZIP 包超过 64MiB 的 413 错误，要求重新选择产物而非输出截断包。
 * EN: Creates a 413 error for bundles over 64MiB, requiring new selection rather than emitting truncated ZIPs.
 */
const tooLarge = () =>
  new AppError(
    'PROJECT_BUNDLE_TOO_LARGE',
    '完整文件包超过 64 MiB 上限，请减少所选产物后创建新清单',
    false,
    null,
    413,
  );

/**
 * 路径由服务生成，不取自objectRef、source或用户目录。 只取显示名称的最后一段并处理 Windows 保留名；不使用来源路径决定 ZIP 写入位置。
 * EN: Paths are generated, never taken from objectRef, source or user-supplied directories. Uses the final display-name segment and handles Windows reserved names; source paths never choose ZIP destinations.
 */
function safeName(name: string) {
  let base = (name.split(/[\\/]/).at(-1) ?? '').replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_');
  base = [...base]
    .slice(0, 100)
    .join('')
    .replace(/[. ]+$/g, '');
  if (!base || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base)) base = '_' + base;
  return base;
}
/**
 * 按冻结清单顺序生成确定的安全相对路径，并在读取正文前限制交付项/产物总量。
 * EN: Creates deterministic safe relative paths in frozen-manifest order and limits delivery/artifact counts before reading bodies.
 */
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
/**
 * 当前来源必须仍与冻结元数据逐字段一致；绝不把更新后的产物冒充冻结版本打包。
 * EN: Current sources must still match frozen metadata field by field; newer artifacts cannot masquerade as pinned versions.
 */
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
/**
 * 将单文件读取错误映射为用户可辨别的状态，保留缺失、变化、超限和无法核验的区别。
 * EN: Maps per-file failures into distinguishable missing, changed, oversized, or unverifiable states.
 */
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
/**
 * 生成冻结元数据、文件索引和校验清单；SHA256SUMS 不对自身求哈希，避免循环定义。
 * EN: Creates frozen metadata, file indexes, and checksums; SHA256SUMS excludes its own hash to avoid circular definition.
 */
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
/**
 * 按 UTF-8 文件名字节估算本写入器的本地头、描述符及中央目录固定开销，用于提前容量检查。
 * EN: Estimates this writer's local-header, descriptor and central-directory overhead from UTF-8 names for early size checks.
 */
const zipOverhead = (name: string) => 30 + 16 + 46 + 2 * Buffer.byteLength(name);
/**
 * ZIP STORE 不压缩正文，最终大小可由文件字节和固定目录/描述符开销精确计算。
 * EN: ZIP STORE leaves bodies uncompressed, allowing exact final-size calculation from bytes and bounded descriptor/directory overhead.
 */
function archiveSize(files: PlanFile[], docs: Document[]) {
  return (
    22 +
    files.reduce((sum, file) => sum + file.size! + zipOverhead(file.path), 0) +
    docs.reduce((sum, doc) => sum + doc.bytes.length + zipOverhead(doc.path), 0)
  );
}

/**
 * 使用带数据描述符的标准ZIP STORE，内存仅保留64 KiB块， 及有界中央目录，不依赖外部归档器。
 * EN: Standard ZIP STORE with data descriptors. Only 64 KiB stream chunks and a bounded central directory are held in memory; no external archiver is needed.
 */
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
class ZipWriter {
  offset = 0;
  private entries: Buffer[] = [];
  /**
   * 绑定已打开输出句柄、取消信号及字节进度回调，写入器从偏移零开始管理 ZIP。
   * EN: Binds the opened output handle, cancellation signal and byte progress callback for ZIP offsets starting at zero.
   */
  constructor(
    private handle: FileHandle,
    private signal: AbortSignal,
    private progress?: (bytes: number) => void,
  ) {}
  /**
   * 循环处理可能的短写并推进唯一输出偏移，每轮检查取消与总包上限；零进展立即失败以避免死循环。
   * EN: Handles short writes while advancing one output offset, checking cancellation/size limits each round; zero progress fails instead of looping.
   */
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
  /**
   * 流式写入一个条目并同步计算 CRC32 与冻结 SHA-256。大小或摘要不匹配时立即失败， 该临时 ZIP 不会被宣布就绪；中央目录只保存有界条目元数据，不缓存全部正文。
   * EN: Streams entries while calculating CRC32 and frozen SHA-256. Size/digest mismatch fails immediately, preventing the temporary ZIP from becoming ready. The central directory stores bounded metadata, never every body.
   */
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
  /**
   * 写入中央目录和结束标记后 fsync，确保后续只读流看到完整 ZIP。
   * EN: Writes the central directory and end marker, then fsyncs so later read-only streams observe a complete ZIP.
   */
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

/**
 * 协调交付包检查、下载和保存任务，关闭时取消并释放临时资源。
 * EN: Coordinates checks, downloads, and save jobs, aborting and releasing temporary resources on shutdown.
 */
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
  /**
   * 为存储创建独立产物预览器和临时包目录管理器，可选复用保存归档服务。
   * EN: Creates artifact previews and temporary bundle storage for a Store, optionally using saved archives.
   */
  constructor(
    private store: Store,
    private archives?: ProjectDeliveryArchiveService,
  ) {
    this.previews = new ArtifactPreviewService(store);
    this.temporary = new BundleJobStorage(store.directory);
  }
  /**
   * 检查/生成/发送共用两个容量槽；release 幂等，关闭服务可等待所有持有者退出。
   * EN: Checks, generation, and sending share two slots. release is idempotent and shutdown can await all holders.
   */
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
      /**
       * 幂等释放并发配额及作业登记，结算关闭时等待的完成承诺。
       * EN: Idempotently releases concurrency/job tracking and resolves the completion promise awaited at shutdown.
       */
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
  /**
   * 以剩余预算读取冻结正文。无 ZIP 时只核验摘要；有 ZIP 时边核验边写入。 读取结束后再次核对数据库元数据，并在所有退出路径销毁流以释放文件句柄。
   * EN: Reads frozen sources within the remaining budget, verifying hashes alone or while writing ZIP. Rechecks database metadata afterward and destroys streams on every exit to release handles.
   */
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
    /**
     * ZIP头写入可能在迭代安装错误监听前让出事件循环。
     * EN: ZIP header writes can yield before iteration attaches its error listener.
     */
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
  /**
   * 完整读取每个冻结来源，分别报告可用性并计算归档大小。某个文件失败不会遮蔽其他 文件状态，但只要有一个不完整，就禁止生成声称完整的文件包。
   * EN: Reads every frozen source, reports each availability state, and calculates archive size. A file failure does not hide others, but any incomplete file prevents a bundle claiming completeness.
   */
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
  /**
   * 重新核验来源并生成独占临时 ZIP；预览通过不代替这里的实际字节核验。 返回只读流及幂等 dispose，容量槽持续占用至流关闭或显式释放，取消也触发同一清理。
   * EN: Revalidates sources and creates an exclusive temporary ZIP; successful preview does not replace byte verification. Returns a read-only stream and idempotent dispose; its slot remains held until stream closure or explicit release, including cancellation.
   */
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
    /**
     * 合并并发释放请求，先停输出流、关句柄，再清理本次临时目录，finally 释放作业配额；失败仍可由调用方观察。
     * EN: Coalesces concurrent disposal, stops stream/closes handle/removes owned temporary storage and finally releases quota, preserving observable failures.
     */
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
      /**
       * 打开失败必须在作业宣布ready前拒绝准备。
       * EN: Open failures must reject preparation, before announcing a ready job.
       */
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
      /**
       * 取消时启动同一幂等释放流程，吞掉监听器无法处理的清理拒绝，主请求仍保留自身错误。
       * EN: Starts idempotent disposal on cancellation and handles listener-side cleanup rejection while the main request retains its error.
       */
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
  /**
   * 取消生命周期及所有跟踪包，等待生成和下载登记收束，再释放临时初始化与预览器资源。
   * EN: Aborts lifetime/tracked bundles, awaits generation/download jobs and releases temporary initialization and preview resources.
   */
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
  /**
   * 保留ZIP读取共享相同有界槽位及关闭取消链。
   * EN: Retained ZIP reads share the same bounded slots and shutdown cancellation.
   */
  async body(
    load: (signal: AbortSignal) => Promise<{ stream: Readable; size: number; dispose: () => Promise<void> }>,
    signal?: AbortSignal,
  ) {
    const job = this.acquire(signal);
    let resource: Awaited<ReturnType<typeof load>> | undefined, disposing: Promise<void> | undefined;
    /**
     * 对已有归档下载合并资源释放，并在 finally 归还并发配额。
     * EN: Coalesces saved-archive resource disposal and returns concurrency quota in finally.
     */
    const dispose = () =>
      (disposing ??= (async () => {
        await resource?.dispose();
      })().finally(job.release));
    try {
      resource = await load(job.signal);
      /**
       * 将归档下载取消交给幂等释放流程，监听器不产生未处理拒绝。
       * EN: Routes saved-archive download cancellation through idempotent disposal without unhandled listener rejection.
       */
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

  /**
   * 作业身份绑定清单哈希、服务会话及页面客户端，知道 jobId 不能跨会话领取文件。
   * EN: Job identity binds manifest hash, service session, and page client; knowing jobId cannot claim another session's file.
   */
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
  /**
   * 活跃作业超时先取消并清理资源；终态视图短暂保留供页面读到最终结果后再回收。
   * EN: Expired active jobs cancel and clean first; terminal views remain briefly for clients to observe before collection.
   */
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
  /**
   * 在项目、清单和会话边界核对后返回作业深拷贝，调用方不能修改服务内部状态。
   * EN: Checks manifest/project/session boundaries and returns a deep copy so callers cannot mutate job state.
   */
  job(
    manifest: ProjectDeliveryManifest,
    jobId: string,
    sessionHash: string,
    clientId?: string,
  ): ProjectDeliveryBundleJob {
    return structuredClone(this.bound(manifest, jobId, sessionHash, clientId).view);
  }
  /**
   * 建立可轮询的检查、下载或保存作业。同 ID 必须绑定同 kind 和清单；同一客户端的 新作业会等待旧作业释放资源后再继续。保存记录已提交时，其完成回执优先于迟到取消。
   * EN: Creates pollable check/download/save jobs. The same ID must bind the same kind and manifest. New work from a client waits for predecessor resource release; a committed save receipt outranks late cancellation.
   */
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
    /**
     * 同一冻结清单上的新操作取代刷新遗留工作， 预先预留其身份也会串行化并发重试。
     * EN: A fresh operation on the same frozen manifest supersedes abandoned work from a reload. Reserving its identity first also serializes concurrent retries.
     */
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
        /**
         * 已取消前驱仍可能正在关闭ZIP并持有容量槽。
         * EN: A cancelled predecessor can still be closing its ZIP and holding a slot.
         */
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
    /**
     * 仅更新未取消且未结束的作业进度；失败阶段立即启动包释放并缩短保留时间，迟到进度忽略。
     * EN: Updates only live uncancelled jobs; failure starts disposal and shortens retention, while late progress is ignored.
     */
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
              /**
               * 记录提交是同步的，其回执优先于后来的取消。
               * EN: The record commit is synchronous. Its receipt wins over later cancellation.
               */
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
  /**
   * 只取消尚未终结的作业并等待已建立资源释放，不撤销已经提交的保存包记录。
   * EN: Cancels only nonterminal jobs and awaits acquired resources; it does not undo saved archive records already committed.
   */
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
  /**
   * 将 ready 下载原子切换为 sending，防止同一临时流被重复领取。 响应读完才标 completed；断开或流错误标 failed，并通过同一 dispose 释放 ZIP。
   * EN: Atomically claims a ready download as sending, preventing duplicate use of one temporary stream. Completion follows full response consumption; disconnect/errors fail the job and dispose the same ZIP.
   */
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
      /**
       * 下载 sending 阶段按实际通过的块累计字节，再原样转发，保持背压和内容不变。
       * EN: Counts actual chunks during sending and forwards them unchanged, preserving backpressure/content.
       */
      transform(chunk, _encoding, callback) {
        if (job.view.stage === 'sending') job.view.bytesDone += chunk.length;
        callback(null, chunk);
      },
    });
    /**
     * 取消会话所属下载作业并销毁计量流，停止后续发送。
     * EN: Cancels the session-owned download job and destroys its metering stream.
     */
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

/**
 * 调用方把导出绑定到其确实检查过的清单。 核对冻结清单正文哈希及调用方预期哈希，不一致时要求重新读取。
 * EN: The caller binds the export to the exact manifest they reviewed. Checks frozen manifest-body and expected hashes; mismatch requires rereading.
 */
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
