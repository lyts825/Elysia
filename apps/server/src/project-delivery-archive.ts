/** 管理项目交付归档及其摘要。 */
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
const unreadable = () =>
  new AppError(
    'PROJECT_ARCHIVE_UNREADABLE',
    '已保存文件包记录无法完整核验，请保留现有数据后重试',
    false,
    null,
    422,
  );
const corrupt = () =>
  new AppError(
    'PROJECT_ARCHIVE_CORRUPT',
    '已保存文件包缺失、变化或校验失败，未用其他内容替代',
    false,
    null,
    409,
  );
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
function rows(store: Store, projectId: string) {
  schema(store);
  store.require<Project>('projects', projectId);
  return store.db
    .prepare(select + ' WHERE a.project_id=? ORDER BY a.manifest_id')
    .all(projectId)
    .map(checked);
}
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
/** Includes the entire retained set, so project deletion cannot omit unseen pages. */
export function archiveSetHash(store: Store, projectId: string) {
  return setHash(rows(store, projectId));
}
/** 汇总项目已保存交付包数量、字节数和集合哈希。 */
export function projectDeliveryArchiveSummary(
  store: Store,
  projectId: string,
): { count: number; totalBytes: number; setHash: string } {
  const retained = rows(store, projectId),
    totalBytes = retained.reduce((total, row) => total + row.size, 0);
  if (!Number.isSafeInteger(totalBytes)) throw unreadable();
  return { count: retained.length, totalBytes, setHash: setHash(retained) };
}
/** 按项目分页读取归档列表，并限制单页数量。 */
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

/** 管理项目交付归档的保存及读取，写入前调用作用域守卫。 */
export class ProjectDeliveryArchiveService {
  constructor(
    private store: Store,
    private guard: (runId: string | null, projectId?: string) => void,
  ) {}
  writable(manifest: ProjectDeliveryManifest) {
    schema(this.store);
    this.guard(null, manifest.projectId);
    if (this.store.require<Project>('projects', manifest.projectId).archived)
      throw new AppError('PROJECT_ARCHIVED', '请先恢复归档项目，再保存文件包', false, null, 409);
  }
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
  get(manifest: ProjectDeliveryManifest): ProjectDeliveryArchive | null {
    const row = this.row(manifest);
    return row ? view(row) : null;
  }
  read(manifest: ProjectDeliveryManifest): ProjectDeliveryArchiveView {
    return {
      projectId: manifest.projectId,
      manifestId: manifest.id,
      manifestHash: manifest.hash,
      archive: this.get(manifest),
    };
  }
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
      // Remove only the reference. Shared immutable bytes remain for explicit object maintenance.
      return this.read(manifest);
    });
  }
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
    // No await separates the committed transaction from the immutable success receipt.
    committed(receipt);
    return receipt;
  }
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
      // Re-read the retained record after byte verification; removal or project deletion wins.
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
