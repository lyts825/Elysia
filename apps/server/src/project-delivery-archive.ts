/**
 * 管理项目交付归档及其摘要。
 * 保存冻结清单对应的完整 ZIP 并管理校验下载、索引和集合哈希；原字节缺失/损坏明确失败，不用其他正文代替。
 * EN: Manages saved project-delivery archives and summaries. Persists complete frozen-manifest ZIPs with verified downloads/index/set hashes; missing/corrupt original bytes fail without substitution.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { z } from 'zod';
import { AppError, type Project } from '../../../packages/contracts/src/index.js';
import type {
  ProjectDeliveryArchive,
  ProjectDeliveryArchiveList,
  ProjectDeliveryArchiveView,
} from '../../../packages/contracts/src/project-delivery-archive.js';
import type { ProjectDeliveryManifest } from '../../../packages/contracts/src/project-delivery.js';
import {
  hash,
  now,
  stable,
  STORAGE_SCHEMA_VERSION,
  type Store,
} from '../../../packages/storage/src/index.js';
import { fileVersion, openFile, streamFile } from './file-reader.js';

const maxBytes = 64 * 1024 * 1024;
const rowSchema = z.object({
  manifest_id: z.string().uuid(),
  project_id: z.string().uuid(),
  manifest_hash: z.string().regex(/^[a-f0-9]{64}$/),
  object_hash: z.string().regex(/^[a-f0-9]{64}$/),
  object_ref: z.string(),
  size: z.number().int().min(22).max(maxBytes),
  file_count: z.number().int().min(1).max(800),
  saved_at: z.string().datetime(),
  title: z.string().min(1).max(200),
  frozen_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
type Row = z.infer<typeof rowSchema>;
const select = `SELECT a.*,m.title,m.hash frozen_hash FROM project_delivery_archives_v1 a
  LEFT JOIN project_delivery_manifests_v1 m ON m.id=a.manifest_id AND m.project_id=a.project_id`;
/**
 * 创建保存包索引不可完整核验的 422 错误，要求保留现有数据而非将其当作空包。
 * EN: Creates a 422 error for unverifiable archive records, preserving existing data rather than treating it as empty.
 */
const unreadable = () =>
  new AppError(
    'PROJECT_ARCHIVE_UNREADABLE',
    '已保存文件包记录无法完整核验，请保留现有数据后重试',
    false,
    null,
    422,
  );
/**
 * 创建归档文件缺失或完整性失败的冲突错误，不自动寻找其他正文替代。
 * EN: Creates a conflict for missing/corrupt archive bytes without substituting other content.
 */
const corrupt = () =>
  new AppError(
    'PROJECT_ARCHIVE_CORRUPT',
    '已保存文件包缺失、变化或校验失败，未用其他内容替代',
    false,
    null,
    409,
  );
/**
 * 归档记录依赖当前数据库格式；拒绝在未升级或不匹配的库中静默写入新结构。
 * EN: Archive records depend on the current database format; unupgraded or mismatched stores cannot silently accept the new structure.
 */
function schema(store: Store) {
  if (
    STORAGE_SCHEMA_VERSION < 6 ||
    Number(store.db.prepare('PRAGMA user_version').get()?.user_version) !== STORAGE_SCHEMA_VERSION
  )
    throw new AppError(
      'PROJECT_ARCHIVE_SCHEMA',
      '保存文件包需要相容的数据格式，请先完成升级',
      false,
      null,
      503,
    );
}
/**
 * 同时验证行结构、冻结清单哈希和内容寻址路径，避免损坏记录引导到任意文件。
 * EN: Validates row structure, frozen manifest hash, and content-addressed paths so corrupt rows cannot redirect arbitrary file reads.
 */
function checked(raw: unknown): Row {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) throw unreadable();
  const row = parsed.data;
  if (
    row.frozen_hash !== row.manifest_hash ||
    row.object_ref.replaceAll('\\', '/') !== `objects/${row.object_hash.slice(0, 2)}/${row.object_hash}`
  )
    throw unreadable();
  return row;
}
/**
 * 把已验证索引行转换为公开 ZIP 元数据，不包含磁盘私有路径或完整对象正文。
 * EN: Maps a validated row to public ZIP metadata without private paths or object bodies.
 */
function view(row: Row): ProjectDeliveryArchive {
  return {
    version: 1,
    format: 'zip',
    projectId: row.project_id,
    manifestId: row.manifest_id,
    manifestHash: row.manifest_hash,
    title: row.title,
    objectHash: row.object_hash,
    size: row.size,
    fileCount: row.file_count,
    savedAt: row.saved_at,
  };
}
/**
 * 读取项目完整归档集合并逐行核验；存在坏行时整个读取失败，不能把它当成已不存在。
 * EN: Reads and validates every archive in a project; one bad row fails the read rather than pretending it is absent.
 */
function rows(store: Store, projectId: string) {
  schema(store);
  store.require<Project>('projects', projectId);
  return store.db
    .prepare(select + ' WHERE a.project_id=? ORDER BY a.manifest_id')
    .all(projectId)
    .map(checked);
}
/**
 * 对保留包的清单 ID、对象摘要和保存时间计算集合指纹，供项目删除确认绑定完整集合。
 * EN: Hashes retained manifest IDs, object hashes and save times to bind deletion acknowledgement to the complete archive set.
 */
function setHash(retained: Row[]) {
  return hash(
    stable(
      retained.map((row) => ({
        manifestId: row.manifest_id,
        objectHash: row.object_hash,
        savedAt: row.saved_at,
      })),
    ),
  );
}
/**
 * 哈希覆盖完整保留集合；项目删除确认不能只绑定用户当前看见的归档页。
 * EN: The hash covers the full retained set, not merely the archive page visible during project-deletion confirmation.
 */
export function archiveSetHash(store: Store, projectId: string) {
  return setHash(rows(store, projectId));
}
/**
 * 汇总项目已保存交付包数量、字节数和集合哈希。
 * EN: Summarizes saved archive count, bytes, and set hash for a project.
 */
export function projectDeliveryArchiveSummary(
  store: Store,
  projectId: string,
): { count: number; totalBytes: number; setHash: string } {
  const retained = rows(store, projectId),
    totalBytes = retained.reduce((total, row) => total + row.size, 0);
  if (!Number.isSafeInteger(totalBytes)) throw unreadable();
  return { count: retained.length, totalBytes, setHash: setHash(retained) };
}
/**
 * 按保存时间、清单 ID 稳定倒序分页；游标行消失时要求刷新，避免无声跳过记录。 count、totalBytes 和 setHash 始终描述整个集合，可供删除确认核对未展示的页面。
 * EN: Paginates stably by saved time and manifest ID descending. Missing cursor rows require refresh instead of silently skipping. count, totalBytes, and setHash always describe the full set for deletion confirmation across hidden pages.
 */
export function readProjectArchives(
  store: Store,
  projectId: string,
  input: { limit?: number; before?: string } = {},
): ProjectDeliveryArchiveList {
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      before: z.string().uuid().optional(),
    })
    .strict()
    .parse(input);
  const retained = rows(store, projectId),
    ordered = [...retained].sort(
      (a, b) => b.saved_at.localeCompare(a.saved_at) || b.manifest_id.localeCompare(a.manifest_id),
    );
  let start = 0;
  if (query.before) {
    start = ordered.findIndex((row) => row.manifest_id === query.before) + 1;
    if (!start) throw new AppError('PROJECT_ARCHIVE_CURSOR', '保存包列表已变化，请刷新列表', true, null, 409);
  }
  const selected = ordered.slice(start, start + query.limit),
    hasMore = start + selected.length < ordered.length;
  const totalBytes = retained.reduce((total, row) => total + row.size, 0);
  if (!Number.isSafeInteger(totalBytes)) throw unreadable();
  return {
    projectId,
    items: selected.map(view),
    count: retained.length,
    totalBytes,
    setHash: setHash(retained),
    page: {
      limit: query.limit,
      before: query.before ?? null,
      total: retained.length,
      hasMore,
      nextBefore: hasMore ? selected.at(-1)!.manifest_id : null,
    },
  };
}

/**
 * 管理项目交付归档的保存及读取，写入前调用作用域守卫。
 * EN: Manages saved archives and reads, invoking scope guards before writes.
 */
export class ProjectDeliveryArchiveService {
  /**
   * 绑定归档存储与项目/运行可变性守卫，具体文件核验由读取和保存操作执行。
   * EN: Binds archive storage and run/project mutation guard; read/save operations perform actual file validation.
   */
  constructor(
    private store: Store,
    private guard: (runId: string | null, projectId?: string) => void,
  ) {}
  /**
   * 保存前检查当前作用域和项目归档状态；异步处理后仍需在提交事务内再次检查。
   * EN: Checks current scope and project archival before preparation and again inside the final commit transaction.
   */
  writable(manifest: ProjectDeliveryManifest) {
    schema(this.store);
    this.guard(null, manifest.projectId);
    if (this.store.require<Project>('projects', manifest.projectId).archived)
      throw new AppError('PROJECT_ARCHIVED', '请先恢复归档项目，再保存文件包', false, null, 409);
  }
  /**
   * 仅返回与指定冻结清单完全绑定的记录；缺失为 null，哈希不符属于不可读错误。
   * EN: Returns only records exactly bound to the frozen manifest. Missing is null; a hash mismatch is unreadability.
   */
  private row(manifest: ProjectDeliveryManifest) {
    schema(this.store);
    this.store.require<Project>('projects', manifest.projectId);
    const raw = this.store.db
      .prepare(select + ' WHERE a.project_id=? AND a.manifest_id=?')
      .get(manifest.projectId, manifest.id);
    if (!raw) return null;
    const row = checked(raw);
    if (row.manifest_hash !== manifest.hash) throw unreadable();
    return row;
  }
  /**
   * 返回归档元数据，不在此读取文件正文；实际下载还会完整核对不可变对象。
   * EN: Returns metadata without reading file bytes; downloading separately verifies the complete immutable object.
   */
  get(manifest: ProjectDeliveryManifest): ProjectDeliveryArchive | null {
    const row = this.row(manifest);
    return row ? view(row) : null;
  }
  /**
   * 为给定冻结清单返回归档状态视图；归档身份匹配逻辑由 get 负责。
   * EN: Returns archive state for a frozen manifest, delegating identity matching to get.
   */
  read(manifest: ProjectDeliveryManifest): ProjectDeliveryArchiveView {
    return {
      projectId: manifest.projectId,
      manifestId: manifest.id,
      manifestHash: manifest.hash,
      archive: this.get(manifest),
    };
  }
  /**
   * 以对象哈希作并发前提删除引用；已删除可重放，引用已变化则要求用户重新确认。
   * EN: Deletes references under an expected object hash. Already-deleted records replay safely; changed references require fresh confirmation.
   */
  remove(manifest: ProjectDeliveryManifest, expectedObjectHash: string): ProjectDeliveryArchiveView {
    this.guard(null, manifest.projectId);
    return this.store.tx(() => {
      this.guard(null, manifest.projectId);
      const current = this.row(manifest);
      if (!current) return this.read(manifest);
      if (current.object_hash !== expectedObjectHash)
        throw new AppError('PROJECT_ARCHIVE_CHANGED', '已保存文件包已变化，请刷新后重试', false, null, 409);
      this.store.db
        .prepare(
          'DELETE FROM project_delivery_archives_v1 WHERE project_id=? AND manifest_id=? AND object_hash=?',
        )
        .run(manifest.projectId, manifest.id, expectedObjectHash);
      /**
       * 此事务只删除引用。内容寻址对象可能被其他记录共享，实体字节留给显式对象维护回收。
       * EN: This transaction deletes references only. Shared content-addressed bytes remain for explicit object-maintenance collection.
       */
      return this.read(manifest);
    });
  }
  /**
   * 分块计算准备文件的完整哈希，限制大小并复核同一文件句柄版本；支持取消和累计字节进度。
   * EN: Hashes prepared files in chunks with size limits and same-handle version checks, supporting abort and cumulative byte progress.
   */
  private async digest(
    filename: string,
    expectedSize: number,
    signal: AbortSignal,
    progress?: (bytes: number) => void,
  ) {
    const opened = await openFile(filename, signal);
    try {
      if (opened.stat.size !== expectedSize || expectedSize > maxBytes) throw corrupt();
      const digest = createHash('sha256'),
        buffer = Buffer.alloc(64 * 1024);
      let at = 0;
      while (at < expectedSize) {
        signal.throwIfAborted();
        const { bytesRead } = await opened.handle.read(
          buffer,
          0,
          Math.min(buffer.length, expectedSize - at),
          at,
        );
        if (!bytesRead) throw corrupt();
        digest.update(buffer.subarray(0, bytesRead));
        at += bytesRead;
        progress?.(at);
      }
      if (fileVersion(await opened.handle.stat()) !== opened.version) throw corrupt();
      signal.throwIfAborted();
      return digest.digest('hex');
    } finally {
      await opened.handle.close();
    }
  }
  /**
   * 将已生成 ZIP 发布成不可变对象，再在事务内登记与冻结清单的绑定。 同一清单已保存时返回原回执；异步文件发布后重新检查授权、项目状态和清单正文哈希。 对象发布成功而事务失败时不伪造成功记录；未引用对象由后续显式维护处理。 committed 在提交后同步调用，使调用方一旦观察到成功便保留该回执，晚到的取消不改写结果。
   * EN: Publishes a generated ZIP as an immutable object, then records its frozen-manifest binding transactionally. Existing saves return their receipt. After asynchronous publishing, rechecks authorization, project state, and manifest-body hash. A failed record transaction never fabricates success; unreferenced objects await explicit maintenance. committed runs synchronously after commit so late abort cannot overwrite an observed receipt.
   */
  async save(
    manifest: ProjectDeliveryManifest,
    prepared: { filename: string; size: number; fileCount: number },
    signal: AbortSignal,
    committed: (receipt: ProjectDeliveryArchive) => void,
    progress?: (bytes: number) => void,
  ) {
    signal.throwIfAborted();
    this.writable(manifest);
    const existing = this.get(manifest);
    if (existing) {
      signal.throwIfAborted();
      committed(existing);
      return existing;
    }
    const objectHash = await this.digest(prepared.filename, prepared.size, signal, progress);
    const published = await this.store.publishFileObject(
      prepared.filename,
      { hash: objectHash, size: prepared.size },
      signal,
    );
    signal.throwIfAborted();
    const receipt = this.store.tx(() => {
      signal.throwIfAborted();
      this.writable(manifest);
      const current = this.get(manifest);
      if (current) return current;
      const frozen = this.store.db
        .prepare('SELECT hash,data FROM project_delivery_manifests_v1 WHERE id=? AND project_id=?')
        .get(manifest.id, manifest.projectId) as { hash: string; data: string } | undefined;
      if (!frozen || frozen.hash !== manifest.hash) throw unreadable();
      const { hash: currentHash, ...body } = JSON.parse(frozen.data);
      if (currentHash !== manifest.hash || hash(stable(body)) !== manifest.hash) throw unreadable();
      this.store.db
        .prepare(
          `INSERT INTO project_delivery_archives_v1
        (manifest_id,project_id,manifest_hash,object_ref,object_hash,size,file_count,saved_at) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          manifest.id,
          manifest.projectId,
          manifest.hash,
          published.objectRef,
          objectHash,
          prepared.size,
          prepared.fileCount,
          now(),
        );
      return this.get(manifest)!;
    });
    /**
     * 提交与成功回执之间不让出事件循环，避免取消信号把已持久保存的结果描述成失败。
     * EN: Does not yield between commit and receipt, preventing cancellation from misreporting a persisted save as failure.
     */
    committed(receipt);
    return receipt;
  }
  /**
   * 下载前核验引用、真实父目录、完整内容哈希和文件版本，再重读引用确认其仍被保留。 返回的流仍绑定核验版本和哈希；调用者必须 dispose，取消或损坏都不能替换成重新生成的包。
   * EN: Verifies references, real parent directories, full content hash, and file version before downloading, then rereads retained ownership. The stream remains version/hash-bound and must be disposed; cancellation or corruption cannot substitute a regenerated archive.
   */
  async body(manifest: ProjectDeliveryManifest, expectedObjectHash: string, signal: AbortSignal) {
    const row = this.row(manifest);
    if (!row)
      throw new AppError(
        'PROJECT_ARCHIVE_MISSING',
        '此清单没有已保存文件包，请在来源可用时显式保存',
        false,
        null,
        404,
      );
    if (row.object_hash !== expectedObjectHash)
      throw new AppError('PROJECT_ARCHIVE_CHANGED', '已保存文件包已变化，请刷新后重试', false, null, 409);
    let opened: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      const root = await fs.realpath(this.store.directory);
      const filename = path.join(root, row.object_ref.replaceAll('\\', '/'));
      const parents = [path.join(root, 'objects'), path.dirname(filename)];
      /**
       * 逐级核验归档父目录是无链接真实目录，拒绝路径别名或重定向后继续读包。
       * EN: Validates each archive parent as a real nonlink directory, rejecting aliases or redirects before reading.
       */
      const plainParents = async () => {
        for (const directory of parents) {
          const stat = await fs.lstat(directory),
            real = await fs.realpath(directory);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (process.platform === 'win32'
              ? real.toLowerCase() !== path.resolve(directory).toLowerCase()
              : real !== path.resolve(directory))
          )
            throw corrupt();
        }
      };
      await plainParents();
      opened = await openFile(filename, signal);
      if (opened.stat.size !== row.size) throw corrupt();
      const digest = createHash('sha256'),
        buffer = Buffer.alloc(64 * 1024);
      for (let at = 0; at < row.size; ) {
        signal.throwIfAborted();
        const { bytesRead } = await opened.handle.read(buffer, 0, Math.min(buffer.length, row.size - at), at);
        if (!bytesRead) throw corrupt();
        digest.update(buffer.subarray(0, bytesRead));
        at += bytesRead;
      }
      if (
        digest.digest('hex') !== row.object_hash ||
        fileVersion(await opened.handle.stat()) !== opened.version
      )
        throw corrupt();
      signal.throwIfAborted();
      /**
       * 文件核验可能耗时；重新读取引用，让并发移除归档或删除项目优先于这次下载。
       * EN: File verification may be slow; reread the reference so concurrent archive removal or project deletion wins over this download.
       */
      const current = this.row(manifest);
      if (!current || current.object_hash !== row.object_hash || current.saved_at !== row.saved_at)
        throw corrupt();
      const version = opened.version;
      await opened.handle.close();
      opened = undefined;
      await plainParents();
      const { stream } = await streamFile(filename, 'application/zip', {
        signal,
        version,
        verifyHash: row.object_hash,
      });
      const ended = finished(stream).catch(() => {});
      return {
        stream,
        size: row.size,
        /**
         * 销毁归档流并等待结束，释放读取工作而不删除已保存包。
         * EN: Destroys and awaits the archive stream without deleting saved bytes.
         */
        dispose: async () => {
          stream.destroy();
          await ended;
        },
      };
    } catch (error) {
      await opened?.handle.close();
      signal.throwIfAborted();
      if (error instanceof AppError && error.code.startsWith('PROJECT_ARCHIVE_')) throw error;
      throw corrupt();
    }
  }
}
