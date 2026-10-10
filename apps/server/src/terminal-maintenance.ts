import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import path from 'node:path';
import { AppError, type Run, type Task, type Operation } from '../../../packages/contracts/src/index.js';
import {
  TerminalMaintenanceApply,
  TerminalMaintenanceOverview,
  TerminalMaintenancePlan,
  TerminalSessionBackupView,
  TerminalMaintenanceScan,
  TerminalMaintenanceScanInput,
  TerminalBackupHistoryItem,
  TerminalBackupEligibility,
} from '../../../packages/contracts/src/terminal-maintenance.js';
import { TerminalBackupIndex } from './terminal-backup-index.js';
import { type Store, hash, id, now, stable } from '../../../packages/storage/src/index.js';
import {
  TerminalSessionRecordSchema,
  TerminalStateOwnerSchema,
  type TerminalSessionRecord,
  type TerminalMaintenanceSnapshot,
} from '../../../packages/runtime/src/terminal-session.js';

type Guard = <T>(
  runId: string,
  expectedRevision: number,
  action: (snapshot: TerminalMaintenanceSnapshot) => T,
  options?: { mutates?: boolean },
) => T | Promise<T>;
export type TerminalMaintenanceDependencies = {
  snapshot: (
    runId: string,
    expectedRevision: number,
    options?: { requireConsistent?: boolean },
  ) => TerminalMaintenanceSnapshot | Promise<TerminalMaintenanceSnapshot>;
  guard: Guard;
  isActive: (runId?: string) => boolean;
  /** File-system failure injection for isolated acceptance; never selected by HTTP input. */
  removeQuarantine?: (directory: string) => void;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sessionKey = 'terminal-session:';
const cleanupKey = 'terminal-maintenance:cleanup:';
type ScanOptions = {
  scanId?: string;
  signal?: AbortSignal;
  progress?: (patch: Partial<TerminalMaintenanceScan>) => void;
};
function cancelled(options: ScanOptions) {
  if (options.signal?.aborted)
    throw new AppError('TERMINAL_MAINTENANCE_CANCELLED', '维护扫描已取消', false, null, 409);
}
async function pause(options: ScanOptions) {
  cancelled(options);
  await turn();
  cancelled(options);
}
const secretName =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|auth\.json|credentials(?:\.json)?|api-keys\.bin|environment|config\.toml)$/i;
const excludedName = (name: string) =>
  secretName.test(name) || ['.git', '.codex', '.dsh', 'credentials'].includes(name.toLowerCase());
const excludedPath = (value: string) => value.split(/[\\/]/).some(excludedName);
function fail(message: string, code = 'TERMINAL_MAINTENANCE_SCOPE'): never {
  throw new AppError(code, message, false, null, 409);
}
type FileEntry = { path: string; bytes: number; hash: string };
type Backup = TerminalSessionBackupView & {
  format: 1;
  owner: string;
  record: TerminalSessionRecord;
  checkpointData: unknown;
  rollout: FileEntry | null;
  workspace: FileEntry[];
  manifestHash: string;
};
const fileEntrySchema = z
  .object({
    path: z.string().min(1).max(2000),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(512 * 1024 * 1024),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const backupSchema = TerminalSessionBackupView.extend({
  format: z.literal(1),
  owner: z.string().regex(/^[a-f0-9]{32}$/),
  record: TerminalSessionRecordSchema,
  checkpointData: z.unknown(),
  rollout: fileEntrySchema.nullable(),
  workspace: z.array(fileEntrySchema).max(20000),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type InternalPlan = {
  view: TerminalMaintenancePlan;
  snapshot?: TerminalMaintenanceSnapshot;
  backup?: Backup;
  workspace?: FileEntry[];
  excluded?: string[];
  cleanup?: string[];
  retry?: CleanupJournal;
  deletionProof?: unknown;
};
const cleanupJournalSchema = z
  .object({
    format: z.literal(1),
    owner: z.string().regex(/^[a-f0-9]{32}$/),
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    bytes: z.number().int().nonnegative(),
    items: z
      .array(
        z
          .object({
            ref: z
              .string()
              .regex(/^(?:terminal-state\/[a-f0-9-]+(?:\/environment)?|maintenance\/backups\/[a-f0-9-]+)$/i),
            slot: z.string().regex(/^\d+$/),
            owner: TerminalStateOwnerSchema.optional(),
            directory: z.boolean(),
            files: z.array(fileEntrySchema).max(20000),
            directories: z.array(z.string().max(2000)).max(20000),
            backup: z
              .object({
                id: z.string().uuid(),
                owner: z.string().regex(/^[a-f0-9]{32}$/),
                runId: z.string().uuid(),
                taskId: z.string().uuid(),
                manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
                checkpoint: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(20000),
  })
  .strict();
type CleanupJournal = z.infer<typeof cleanupJournalSchema>;

function within(root: string, candidate: string, allowRoot = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    (allowRoot || !!relative) &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}
/** Resolve each existing component separately: lexical containment alone is insufficient on Windows junctions. */
function secure(root: string, relative: string, allowMissing = false) {
  if (path.isAbsolute(relative) || relative.includes(':') || /[\0\r\n]/.test(relative))
    fail('维护路径必须是数据目录中的相对路径');
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('维护根目录不能是链接或特殊文件');
  const base = fs.realpathSync(root),
    target = path.resolve(base, relative);
  if (!within(base, target)) fail('维护路径越界');
  let current = base;
  for (const part of path.relative(base, target).split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      if (allowMissing) continue;
      fail('维护文件已变化，请重新生成计划');
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1) || !within(base, fs.realpathSync(current)))
      fail('维护路径包含链接或重定向，已保留未知文件');
  }
  return target;
}
function tree(root: string, options: { filterSecrets?: boolean; hashes?: boolean } = {}) {
  const files: FileEntry[] = [],
    excluded: string[] = [];
  let count = 0,
    bytes = 0;
  if (!fs.existsSync(root)) return { files, excluded, bytes };
  if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory())
    fail('维护源目录不能是链接或特殊文件');
  function visit(directory: string, depth: number) {
    if (depth > 24) fail('维护目录层级过深');
    for (const name of fs.readdirSync(directory).sort()) {
      if (++count > 20000) fail('本次维护文件超过 20000 个，请先缩小工作区');
      const filename = path.join(directory, name),
        relative = path.relative(root, filename).split(path.sep).join('/'),
        stat = fs.lstatSync(filename);
      if (options.filterSecrets && excludedName(name)) {
        excluded.push(relative);
        continue;
      }
      if (
        stat.isSymbolicLink() ||
        (stat.isFile() && stat.nlink > 1) ||
        !within(root, fs.realpathSync(filename))
      )
        fail('维护目录含链接，无法保证一致快照');
      if (stat.isDirectory()) visit(filename, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 512 * 1024 * 1024) fail('本次快照超过 512 MiB，请缩小工作区');
        let digest = '';
        if (options.hashes) {
          digest = hash(fs.readFileSync(filename));
          const after = fs.lstatSync(filename);
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
            fail('文件正在变化，请重新生成计划');
        } else digest = `${stat.mtimeMs}:${stat.ctimeMs}`;
        files.push({ path: relative, bytes: stat.size, hash: digest });
      } else fail('维护目录含特殊文件，已保留');
    }
  }
  visit(root, 0);
  return { files, excluded, bytes };
}
async function secureAsync(root: string, relative: string, options: ScanOptions, allowMissing = false) {
  cancelled(options);
  if (path.isAbsolute(relative) || relative.includes(':') || /[\0\r\n]/.test(relative))
    fail('维护路径必须是数据目录中的相对路径');
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('维护根目录不能是链接或特殊文件');
  const base = await fsp.realpath(root),
    target = path.resolve(base, relative);
  if (!within(base, target)) fail('维护路径越界');
  let current = base;
  for (const part of path.relative(base, target).split(path.sep)) {
    cancelled(options);
    current = path.join(current, part);
    let info: fs.Stats;
    try {
      info = await fsp.lstat(current);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (
      info.isSymbolicLink() ||
      (info.isFile() && info.nlink > 1) ||
      !within(base, await fsp.realpath(current))
    )
      fail('维护路径包含链接或重定向，已保留未知文件');
  }
  return target;
}
async function hashFileAsync(filename: string, options: ScanOptions) {
  cancelled(options);
  const before = await fsp.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > 512 * 1024 * 1024)
    fail('快照文件不是有界普通文件');
  const handle = await fsp.open(filename, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink > 1)
      fail('维护文件在打开时变化');
    const digest = createHash('sha256'),
      buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < before.size) {
      cancelled(options);
      const chunk = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!chunk.bytesRead) fail('维护文件正在变化');
      digest.update(buffer.subarray(0, chunk.bytesRead));
      offset += chunk.bytesRead;
      options.progress?.({ bytesProcessed: chunk.bytesRead });
      await pause(options);
    }
    const after = await fsp.lstat(filename),
      end = await handle.stat();
    if (
      after.isSymbolicLink() ||
      after.nlink > 1 ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      end.size !== before.size ||
      end.mtimeMs !== before.mtimeMs ||
      end.ctimeMs !== before.ctimeMs
    )
      fail('文件正在变化，请重新生成计划');
    cancelled(options);
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}
async function namesAsync(directory: string, options: ScanOptions) {
  const handle = await fsp.opendir(directory),
    names: string[] = [];
  try {
    while (true) {
      cancelled(options);
      const entry = await handle.read();
      if (!entry) break;
      names.push(entry.name);
      if (names.length > 20000) fail('单目录超过 20000 项，超出占用未计入');
      if (names.length % 32 === 0) await pause(options);
    }
  } finally {
    await handle.close();
  }
  return names.sort();
}
async function treeAsync(
  root: string,
  options: ScanOptions & { filterSecrets?: boolean; hashes?: boolean; partial?: boolean } = {},
) {
  const files: FileEntry[] = [],
    excluded: string[] = [];
  let count = 0,
    bytes = 0,
    coverage: 'complete' | 'partial' | 'unknown' = 'complete';
  function preserve() {
    coverage = files.length ? 'partial' : 'unknown';
  }
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 24) fail('维护目录层级过深');
    for (const name of await namesAsync(directory, options)) {
      await pause(options);
      if (++count > 20000) fail('本次维护文件超过 20000 个，请先缩小工作区');
      const filename = path.join(directory, name),
        relative = path.relative(root, filename).split(path.sep).join('/');
      if (options.filterSecrets && excludedName(name)) {
        excluded.push(relative);
        continue;
      }
      try {
        const stat = await fsp.lstat(filename);
        if (
          stat.isSymbolicLink() ||
          (stat.isFile() && stat.nlink > 1) ||
          !within(root, await fsp.realpath(filename))
        )
          fail('维护目录含链接，保留未知内容');
        if (stat.isDirectory()) await visit(filename, depth + 1);
        else if (stat.isFile()) {
          if (bytes + stat.size > 512 * 1024 * 1024) fail('本次维护超过 512 MiB，超出部分未计入');
          const digest = options.hashes
            ? await hashFileAsync(filename, options)
            : `${stat.mtimeMs}:${stat.ctimeMs}`;
          bytes += stat.size;
          files.push({ path: relative, bytes: stat.size, hash: digest });
          options.progress?.({ filesVisited: 1 });
        } else fail('维护目录含特殊文件，保留');
      } catch (error) {
        cancelled(options);
        if (!options.partial) throw error;
        preserve();
      }
    }
  }
  try {
    const stat = await fsp.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('维护源目录不能是链接或特殊文件');
    await visit(root, 0);
  } catch (error) {
    cancelled(options);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (!options.partial) throw error;
      preserve();
    }
  }
  if (coverage !== 'complete' && files.length) coverage = 'partial';
  return {
    files,
    excluded,
    bytes,
    coverage,
    reason: coverage === 'complete' ? undefined : '链接、权限、变化或扫描上限导致部分占用未计入',
  };
}
async function currentRolloutAsync(
  snapshot: TerminalMaintenanceSnapshot,
  options: ScanOptions,
): Promise<FileEntry | null> {
  const filename = await secureAsync(snapshot.home, snapshot.rollout.relativePath, options, true);
  try {
    const stat = await fsp.lstat(filename);
    return {
      path: snapshot.rollout.relativePath,
      bytes: stat.size,
      hash: await hashFileAsync(filename, options),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function checkpoint(snapshot: TerminalMaintenanceSnapshot) {
  return {
    runId: snapshot.run.id,
    taskId: snapshot.task.id,
    operationId: snapshot.operation.id,
    imageId: snapshot.imageId,
    profileHash: snapshot.record.profileHash,
    authorityHash: snapshot.record.authorityHash,
    homeOperationId: snapshot.record.homeOperationId,
    lastOperationId: snapshot.record.lastOperationId,
    sessionId: snapshot.record.sessionId,
    state: snapshot.record.state,
  };
}
function currentRollout(snapshot: TerminalMaintenanceSnapshot): FileEntry | null {
  const filename = secure(snapshot.home, snapshot.rollout.relativePath, true);
  if (!fs.existsSync(filename)) return null;
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.size > 512 * 1024 * 1024) fail('会话文件不是可维护的普通文件');
  const digest = hash(fs.readFileSync(filename)),
    after = fs.lstatSync(filename);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    fail('会话文件正在变化');
  return { path: snapshot.rollout.relativePath, bytes: before.size, hash: digest };
}
function copyFileChecked(sourceRoot: string, destinationRoot: string, entry: FileEntry) {
  const source = secure(sourceRoot, entry.path),
    destination = secure(destinationRoot, entry.path, true);
  if (!fs.lstatSync(source).isFile() || hash(fs.readFileSync(source)) !== entry.hash)
    fail('快照源文件已变化，请重新生成计划');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  if (hash(fs.readFileSync(destination)) !== entry.hash || hash(fs.readFileSync(source)) !== entry.hash)
    fail('快照复制时源文件变化');
}

export class TerminalMaintenance {
  private plans = new Map<string, InternalPlan>();
  private scans = new Map<
    string,
    { view: TerminalMaintenanceScan; controller: AbortController; backupId?: string }
  >();
  private backupIndex: TerminalBackupIndex;
  private backupReaders = new Map<string, number>();
  private closed = false;
  private owner: string;
  constructor(
    private store: Store,
    private dependencies: TerminalMaintenanceDependencies,
  ) {
    this.owner = hash(path.resolve(store.directory)).slice(0, 32);
    this.backupIndex = new TerminalBackupIndex(
      store,
      this.owner,
      (backupId, options) =>
        secureAsync(
          store.directory,
          'maintenance/backups' + (backupId ? '/' + backupId + '/backup.json' : ''),
          options,
          true,
        ),
      async (backupId, options) => this.historyView(await this.readBackupAsync(backupId, options)),
    );
  }
  startScan(input: unknown) {
    if (this.closed) fail('维护服务已停止');
    const body = TerminalMaintenanceScanInput.parse(input);
    if ([...this.scans.values()].filter((job) => job.view.status === 'running').length >= 2)
      fail('已有维护扫描进行中，请等待或取消');
    for (const [key, job] of this.scans)
      if (this.scans.size >= 30 && job.view.status !== 'running') this.scans.delete(key);
    const controller = new AbortController(),
      createdAt = now();
    const view: TerminalMaintenanceScan = {
      id: id(),
      kind: body.kind,
      status: 'running',
      phase: 'references',
      filesVisited: 0,
      bytesProcessed: 0,
      groupsCompleted: 0,
      createdAt,
      updatedAt: createdAt,
    };
    this.scans.set(view.id, { view, controller, ...('backupId' in body ? { backupId: body.backupId } : {}) });
    // A disconnected POST may never deliver its job ID to the caller. Such read-only work expires locally.
    const expiry = setTimeout(() => controller.abort(), 120000);
    expiry.unref();
    const options: ScanOptions = {
      signal: controller.signal,
      scanId: view.id,
      progress: (patch) => {
        if (view.status !== 'running' || controller.signal.aborted) return;
        for (const field of ['filesVisited', 'bytesProcessed', 'groupsCompleted'] as const)
          if (patch[field] !== undefined) view[field] += patch[field]!;
        if (patch.phase) view.phase = patch.phase;
        view.updatedAt = now();
      },
    };
    void (async () => {
      try {
        await pause(options);
        if (body.kind === 'overview') view.overview = await this.overview(options);
        else if (body.kind === 'delete')
          view.plan = await this.deleteBackupPlan({ backupId: body.backupId }, options);
        else
          view.plan =
            body.kind === 'cleanup'
              ? await this.cleanupPlan(options)
              : body.kind === 'backup'
                ? await this.backupPlan(
                    { runId: body.runId, expectedRevision: body.expectedRevision },
                    options,
                  )
                : body.kind === 'restore'
                  ? await this.restorePlan(
                      { backupId: body.backupId, expectedRevision: body.expectedRevision },
                      options,
                    )
                  : await this.retryCleanupPlan(body.retryId, body.expectedRevision, options);
        cancelled(options);
        view.status = 'completed';
        view.phase = 'complete';
      } catch (error) {
        delete view.overview;
        delete view.plan;
        view.status = controller.signal.aborted ? 'cancelled' : 'failed';
        view.message = controller.signal.aborted
          ? '维护扫描已取消'
          : error instanceof AppError
            ? error.message
            : '维护扫描失败；未知内容已保留，请重新检查';
      } finally {
        clearTimeout(expiry);
        view.updatedAt = now();
      }
    })();
    return TerminalMaintenanceScan.parse(view);
  }
  scan(scanId: string) {
    z.string().uuid().parse(scanId);
    const value = this.scans.get(scanId);
    if (!value) throw new AppError('NOT_FOUND', '维护扫描不存在或服务已重启', false, null, 404);
    return TerminalMaintenanceScan.parse(value.view);
  }
  cancelScan(scanId: string) {
    const view = this.scan(scanId),
      job = this.scans.get(scanId)!;
    if (view.status === 'running') {
      job.controller.abort();
      job.view.status = 'cancelled';
      job.view.message = '维护扫描已取消';
      job.view.updatedAt = now();
      delete job.view.plan;
      delete job.view.overview;
    }
    return this.scan(scanId);
  }
  close() {
    this.closed = true;
    for (const job of this.scans.values()) if (job.view.status === 'running') this.cancelScan(job.view.id);
  }
  cancelPlan(planId: string) {
    z.string().uuid().parse(planId);
    this.plans.delete(planId);
    return { cancelled: true };
  }
  async overview(options: ScanOptions = {}): Promise<TerminalMaintenanceOverview> {
    const scan = await this.inventoryAsync(options);
    return TerminalMaintenanceOverview.parse(scan.overview);
  }
  private databaseChange() {
    return (this.store.db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
  }
  private referenceRows(table: 'runs' | 'tasks' | 'tool_operations', after = '', limit?: number) {
    return this.store.db
      .prepare(
        `SELECT id,revision,run_id,data FROM ${table} WHERE id>? ORDER BY id${limit ? ' LIMIT ' + limit : ''}`,
      )
      .all(after) as { id: string; revision: number; run_id: string | null; data: string }[];
  }
  private reference(
    table: 'runs' | 'tasks' | 'tool_operations',
    row: { id: string; revision: number; run_id: string | null; data: string },
  ) {
    const value = JSON.parse(row.data),
      read = value.readModel ?? value;
    const legacy =
      table === 'tool_operations' && !read.taskId ? this.store.get<Operation>(table, row.id) : undefined;
    return {
      id: row.id,
      revision: row.revision,
      runId: row.run_id ?? value.runId,
      taskId: read.taskId ?? legacy?.taskId,
      status: read.status ?? value.status ?? legacy?.status,
    };
  }
  private references(table: 'runs' | 'tasks' | 'tool_operations') {
    return this.referenceRows(table).map((row) => this.reference(table, row));
  }
  private async referencesAsync(table: 'runs' | 'tasks' | 'tool_operations', options: ScanOptions) {
    const values: ReturnType<TerminalMaintenance['reference']>[] = [];
    let cursor = '';
    while (true) {
      await pause(options);
      const rows = this.referenceRows(table, cursor, 128);
      if (!rows.length) break;
      for (const row of rows) values.push(this.reference(table, row));
      cursor = rows.at(-1)!.id;
    }
    return values;
  }
  private inventory() {
    const runs = this.references('runs'),
      tasks = this.references('tasks'),
      operations = this.references('tool_operations');
    const rows = this.store.db
      .prepare("SELECT key,value FROM storage_meta WHERE key LIKE 'terminal-session:%' ORDER BY key")
      .all() as { key: string; value: string }[];
    const records: { key: string; record: TerminalSessionRecord }[] = [];
    const preserved: { path: string; reason: string }[] = [];
    const cleanup: string[] = [];
    for (const row of rows) {
      try {
        const record = TerminalSessionRecordSchema.parse(JSON.parse(row.value));
        if (row.key !== sessionKey + record.taskId) throw Error();
        records.push({ key: row.key, record });
      } catch {
        preserved.push({ path: row.key, reason: '未知或不完整的会话元数据，保留' });
      }
    }
    const sessions = records.map(({ key, record }) => {
      const run = this.store.get<Run>('runs', record.runId),
        task = this.store.get<Task>('tasks', record.taskId),
        refs = operations.filter(
          (o) =>
            o.id === record.homeOperationId ||
            o.id === record.lastOperationId ||
            o.taskId === record.taskId ||
            o.runId === record.runId,
        );
      const orphan = !run && !task && !refs.length && !record.pending;
      if (orphan) cleanup.push(key);
      let bytes = 0;
      try {
        bytes = tree(
          secure(this.store.directory, 'terminal-state/' + record.homeOperationId + '/home'),
        ).bytes;
      } catch {
        preserved.push({
          path: 'terminal-state/' + record.homeOperationId + '/home',
          reason: '缺失、链接或未知HOME；不删除',
        });
      }
      const eligible =
        !!run &&
        run.execution?.kind === 'docker-agent' &&
        run.execution.profile.agent === 'codex' &&
        run.status === 'WAITING' &&
        run.reason === 'terminal_review' &&
        !!task &&
        task.status === 'WAITING' &&
        record.ready &&
        !!record.state &&
        !record.pending &&
        !refs.some((o) => ['INTENT', 'UNCERTAIN'].includes(o.status)) &&
        !this.dependencies.isActive(run.id);
      return {
        taskId: record.taskId,
        runId: run?.id ?? null,
        homeOperationId: record.homeOperationId,
        bytes,
        protected: !orphan,
        reason: orphan
          ? '任务及操作引用均已不存在，可清理孤立元数据'
          : eligible
            ? '停止的可靠 Codex 会话；保留状态与冻结镜像'
            : '存活、未确认或无法证明一致的会话，保留',
        backupEligible: eligible,
      };
    });
    const groups: { id: string; label: string; bytes: number; files: number }[] = [],
      fingerprints: unknown[] = [];
    for (const [name, label] of [
      ['objects', '消息与对象'],
      ['logs', '终端与事件日志'],
      ['workspaces', '任务工作区'],
      ['terminal-state', 'CLI 会话 HOME'],
      ['terminal-preparation', '准备状态'],
      ['maintenance', '维护快照'],
    ] as const) {
      try {
        const source = secure(this.store.directory, name, true),
          manifest = tree(source);
        groups.push({ id: name, label, bytes: manifest.bytes, files: manifest.files.length });
        fingerprints.push([name, manifest.files]);
      } catch {
        groups.push({ id: name, label, bytes: 0, files: 0 });
        preserved.push({ path: name, reason: '链接、过大或未知目录，保留；占用未计入' });
        fingerprints.push([name, 'preserved']);
      }
    }
    let databaseBytes = 0;
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm'])
      if (
        fs.existsSync(path.join(this.store.directory, name)) &&
        !fs.lstatSync(path.join(this.store.directory, name)).isSymbolicLink()
      )
        databaseBytes += fs.statSync(path.join(this.store.directory, name)).size;
    groups.push({ id: 'database', label: '数据库', bytes: databaseBytes, files: 1 });
    const known = new Set([
      'objects',
      'logs',
      'workspaces',
      'terminal-state',
      'terminal-preparation',
      'maintenance',
      'state.db',
      'state.db-wal',
      'state.db-shm',
      'credentials',
      'service.lock',
      'backups',
    ]);
    for (const name of fs.readdirSync(this.store.directory))
      if (!known.has(name)) preserved.push({ path: name, reason: '非清理范围，保留' });
    if (fs.existsSync(path.join(this.store.directory, 'terminal-state'))) {
      try {
        for (const name of fs.readdirSync(secure(this.store.directory, 'terminal-state'))) {
          try {
            if (!UUID.test(name)) {
              preserved.push({ path: 'terminal-state/' + name, reason: '未知状态目录，保留' });
              continue;
            }
            if (
              operations.some((o) => o.id === name) ||
              records.some((r) => r.record.homeOperationId === name || r.record.lastOperationId === name)
            )
              continue;
            const directory = secure(this.store.directory, 'terminal-state/' + name),
              marker = path.join(directory, 'owner.json');
            if (!fs.existsSync(marker) || fs.lstatSync(marker).isSymbolicLink()) {
              preserved.push({ path: 'terminal-state/' + name, reason: '没有本应用归属标记，保留 HOME' });
              continue;
            }
            secure(this.store.directory, 'terminal-state/' + name + '/owner.json');
            const markerStat = fs.lstatSync(marker);
            if (!markerStat.isFile() || markerStat.size > 16384) {
              preserved.push({ path: 'terminal-state/' + name, reason: '归属标记无法确认，保留' });
              continue;
            }
            const owner = TerminalStateOwnerSchema.parse(JSON.parse(fs.readFileSync(marker, 'utf8')));
            if (
              owner.owner !== this.owner ||
              owner.operationId !== name ||
              !owner.stopped ||
              !UUID.test(owner.runId) ||
              !UUID.test(owner.taskId) ||
              runs.some((r) => r.id === owner.runId) ||
              tasks.some((t) => t.id === owner.taskId) ||
              operations.some(
                (o) => o.runId === owner.runId || o.taskId === owner.taskId || o.id === owner.homeOperationId,
              ) ||
              records.some(
                (r) =>
                  r.record.runId === owner.runId ||
                  r.record.taskId === owner.taskId ||
                  r.record.homeOperationId === owner.homeOperationId,
              ) ||
              this.dependencies.isActive()
            ) {
              preserved.push({
                path: 'terminal-state/' + name,
                reason: '归属、停止证明或存活引用不满足清理条件，保留',
              });
              continue;
            }
            const names = fs.readdirSync(directory);
            const emptyHome =
              !names.includes('home') ||
              fs.readdirSync(secure(this.store.directory, 'terminal-state/' + name + '/home')).length === 0;
            if (names.every((n) => ['owner.json', 'home', 'environment'].includes(n)) && emptyHome)
              cleanup.push('terminal-state/' + name);
            else {
              if (
                names.includes('environment') &&
                fs.lstatSync(secure(this.store.directory, 'terminal-state/' + name + '/environment')).isFile()
              )
                cleanup.push('terminal-state/' + name + '/environment');
              preserved.push({
                path: 'terminal-state/' + name,
                reason: 'HOME或其他未知文件保留，只可清理已证明孤立的临时环境文件',
              });
            }
          } catch {
            preserved.push({
              path: 'terminal-state/' + name,
              reason: '此状态目录含链接、损坏或未知归属，保留',
            });
          }
        }
      } catch {
        preserved.push({ path: 'terminal-state', reason: '归属扫描失败，未知状态全部保留' });
      }
    }
    const cleanupProof = cleanup
      .filter((ref) => !ref.startsWith(sessionKey))
      .map((ref) => {
        const filename = secure(this.store.directory, ref),
          stat = fs.lstatSync(filename);
        return [
          ref,
          stat.isDirectory()
            ? tree(filename).files
            : [{ path: '@file', bytes: stat.size, hash: `${stat.mtimeMs}:${stat.ctimeMs}` }],
        ];
      });
    const revision = hash(
      stable({
        rows,
        runs: runs.map((r) => [r.id, r.revision]),
        tasks: tasks.map((t) => [t.id, t.revision]),
        operations: operations.map((o) => [o.id, o.revision]),
        fingerprints,
        cleanupProof,
        cleanup,
      }),
    );
    return {
      cleanup,
      overview: {
        revision,
        checkedAt: now(),
        groups,
        sessions,
        preserved,
        totalBytes: groups.reduce((n, g) => n + g.bytes, 0),
      },
    };
  }
  private async inventoryAsync(options: ScanOptions = {}) {
    const change = this.databaseChange();
    options.progress?.({ phase: 'references' });
    const runs = await this.referencesAsync('runs', options),
      tasks = await this.referencesAsync('tasks', options),
      operations = await this.referencesAsync('tool_operations', options);
    const rows = this.store.db
      .prepare("SELECT key,value FROM storage_meta WHERE key LIKE 'terminal-session:%' ORDER BY key")
      .all() as { key: string; value: string }[];
    const records: { key: string; record: TerminalSessionRecord }[] = [];
    const preserved: { path: string; reason: string }[] = [];
    const cleanup: string[] = [];
    for (const row of rows) {
      await pause(options);
      try {
        const record = TerminalSessionRecordSchema.parse(JSON.parse(row.value));
        if (row.key !== sessionKey + record.taskId) throw Error();
        records.push({ key: row.key, record });
      } catch {
        cancelled(options);
        preserved.push({ path: row.key, reason: '未知或不完整的会话元数据，保留' });
      }
    }
    const sessions: TerminalMaintenanceOverview['sessions'] = [];
    options.progress?.({ phase: 'sessions' });
    for (const { key, record } of records) {
      await pause(options);
      const run = this.store.get<Run>('runs', record.runId),
        task = this.store.get<Task>('tasks', record.taskId),
        refs = operations.filter(
          (o) =>
            o.id === record.homeOperationId ||
            o.id === record.lastOperationId ||
            o.taskId === record.taskId ||
            o.runId === record.runId,
        );
      const orphan = !run && !task && !refs.length && !record.pending;
      if (orphan) cleanup.push(key);
      let bytes = 0,
        coverage: 'complete' | 'partial' | 'unknown' = 'unknown';
      try {
        const measured = await treeAsync(
          await secureAsync(
            this.store.directory,
            'terminal-state/' + record.homeOperationId + '/home',
            options,
          ),
          { ...options, partial: true },
        );
        bytes = measured.bytes;
        coverage = measured.coverage;
      } catch {
        cancelled(options);
        preserved.push({
          path: 'terminal-state/' + record.homeOperationId + '/home',
          reason: '缺失、链接或未知HOME；不删除',
        });
      }
      const eligible =
        !!run &&
        run.execution?.kind === 'docker-agent' &&
        run.execution.profile.agent === 'codex' &&
        run.status === 'WAITING' &&
        run.reason === 'terminal_review' &&
        !!task &&
        task.status === 'WAITING' &&
        record.ready &&
        !!record.state &&
        !record.pending &&
        !refs.some((o) => ['INTENT', 'UNCERTAIN'].includes(o.status)) &&
        !this.dependencies.isActive(run.id);
      sessions.push({
        coverage,
        taskId: record.taskId,
        runId: run?.id ?? null,
        homeOperationId: record.homeOperationId,
        bytes,
        protected: !orphan,
        reason: orphan
          ? '任务及操作引用均已不存在，可清理孤立元数据'
          : eligible
            ? '停止的可靠 Codex 会话；保留状态与冻结镜像'
            : '存活、未确认或无法证明一致的会话，保留',
        backupEligible: eligible,
      });
    }
    const groups: TerminalMaintenanceOverview['groups'] = [],
      fingerprints: unknown[] = [];
    options.progress?.({ phase: 'storage' });
    for (const [name, label] of [
      ['objects', '消息与对象'],
      ['logs', '终端与事件日志'],
      ['workspaces', '任务工作区'],
      ['terminal-state', 'CLI 会话 HOME'],
      ['terminal-preparation', '准备状态'],
      ['maintenance', '维护快照'],
    ] as const) {
      try {
        const source = await secureAsync(this.store.directory, name, options, true),
          manifest = await treeAsync(source, { ...options, partial: true });
        groups.push({
          id: name,
          label,
          bytes: manifest.bytes,
          files: manifest.files.length,
          coverage: manifest.coverage,
          measurementReason: manifest.reason,
        });
        fingerprints.push([name, manifest.coverage === 'complete' ? manifest.files : 'preserved']);
        if (manifest.coverage !== 'complete') preserved.push({ path: name, reason: manifest.reason! });
      } catch {
        cancelled(options);
        cancelled(options);
        groups.push({
          id: name,
          label,
          bytes: 0,
          files: 0,
          coverage: 'unknown',
          measurementReason: '占用未计入',
        });
        preserved.push({ path: name, reason: '链接、过大或未知目录，保留；占用未计入' });
        fingerprints.push([name, 'preserved']);
      }
      options.progress?.({ groupsCompleted: 1 });
      await pause(options);
    }
    let databaseBytes = 0;
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm'])
      if (
        fs.existsSync(path.join(this.store.directory, name)) &&
        !fs.lstatSync(path.join(this.store.directory, name)).isSymbolicLink()
      )
        databaseBytes += fs.statSync(path.join(this.store.directory, name)).size;
    groups.push({ id: 'database', label: '数据库', bytes: databaseBytes, files: 1, coverage: 'complete' });
    groups.push({
      id: 'credentials',
      label: '凭据库',
      bytes: 0,
      files: 0,
      coverage: 'unknown',
      measurementReason: '保留且不读取；占用未计入',
    });
    const known = new Set([
      'objects',
      'logs',
      'workspaces',
      'terminal-state',
      'terminal-preparation',
      'maintenance',
      'state.db',
      'state.db-wal',
      'state.db-shm',
      'credentials',
      'service.lock',
      'backups',
    ]);
    for (const name of await namesAsync(this.store.directory, options))
      if (!known.has(name)) preserved.push({ path: name, reason: '非清理范围，保留' });
    if (fs.existsSync(path.join(this.store.directory, 'terminal-state'))) {
      try {
        options.progress?.({ phase: 'ownership' });
        for (const name of await namesAsync(
          await secureAsync(this.store.directory, 'terminal-state', options),
          options,
        )) {
          await pause(options);
          try {
            if (!UUID.test(name)) {
              preserved.push({ path: 'terminal-state/' + name, reason: '未知状态目录，保留' });
              continue;
            }
            if (
              operations.some((o) => o.id === name) ||
              records.some((r) => r.record.homeOperationId === name || r.record.lastOperationId === name)
            )
              continue;
            const directory = await secureAsync(this.store.directory, 'terminal-state/' + name, options),
              marker = path.join(directory, 'owner.json');
            if (!fs.existsSync(marker) || fs.lstatSync(marker).isSymbolicLink()) {
              preserved.push({ path: 'terminal-state/' + name, reason: '没有本应用归属标记，保留 HOME' });
              continue;
            }
            secure(this.store.directory, 'terminal-state/' + name + '/owner.json');
            const markerStat = fs.lstatSync(marker);
            if (!markerStat.isFile() || markerStat.size > 16384) {
              preserved.push({ path: 'terminal-state/' + name, reason: '归属标记无法确认，保留' });
              continue;
            }
            const owner = TerminalStateOwnerSchema.parse(JSON.parse(await fsp.readFile(marker, 'utf8')));
            if (
              owner.owner !== this.owner ||
              owner.operationId !== name ||
              !owner.stopped ||
              !UUID.test(owner.runId) ||
              !UUID.test(owner.taskId) ||
              runs.some((r) => r.id === owner.runId) ||
              tasks.some((t) => t.id === owner.taskId) ||
              operations.some(
                (o) => o.runId === owner.runId || o.taskId === owner.taskId || o.id === owner.homeOperationId,
              ) ||
              records.some(
                (r) =>
                  r.record.runId === owner.runId ||
                  r.record.taskId === owner.taskId ||
                  r.record.homeOperationId === owner.homeOperationId,
              ) ||
              this.dependencies.isActive()
            ) {
              preserved.push({
                path: 'terminal-state/' + name,
                reason: '归属、停止证明或存活引用不满足清理条件，保留',
              });
              continue;
            }
            const names = await namesAsync(directory, options);
            const emptyHome =
              !names.includes('home') ||
              (
                await fsp.readdir(
                  await secureAsync(this.store.directory, 'terminal-state/' + name + '/home', options),
                )
              ).length === 0;
            if (names.every((n) => ['owner.json', 'home', 'environment'].includes(n)) && emptyHome)
              cleanup.push('terminal-state/' + name);
            else {
              if (
                names.includes('environment') &&
                fs.lstatSync(secure(this.store.directory, 'terminal-state/' + name + '/environment')).isFile()
              )
                cleanup.push('terminal-state/' + name + '/environment');
              preserved.push({
                path: 'terminal-state/' + name,
                reason: 'HOME或其他未知文件保留，只可清理已证明孤立的临时环境文件',
              });
            }
          } catch {
            cancelled(options);
            preserved.push({
              path: 'terminal-state/' + name,
              reason: '此状态目录含链接、损坏或未知归属，保留',
            });
          }
        }
      } catch {
        cancelled(options);
        preserved.push({ path: 'terminal-state', reason: '归属扫描失败，未知状态全部保留' });
      }
    }
    try {
      const quarantine = await secureAsync(this.store.directory, 'maintenance/cleanup', options, true),
        knownPending = new Set(this.pendingCleanup().map((entry) => entry.id));
      for (const name of await namesAsync(quarantine, options))
        if (!knownPending.has(name))
          preserved.push({
            path: 'maintenance/cleanup/' + name,
            reason: '无有效暂存清理记录，内容未知，保留',
          });
    } catch (error) {
      cancelled(options);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        preserved.push({ path: 'maintenance/cleanup', reason: '暂存范围无法确认，保留' });
    }
    cancelled(options);
    if (change !== this.databaseChange())
      fail('扫描期间数据或引用发生变化，请重新扫描', 'TERMINAL_MAINTENANCE_STALE');
    options.progress?.({ phase: 'verification' });
    const cleanupProof: unknown[] = [];
    for (const ref of cleanup.filter((value) => !value.startsWith(sessionKey))) {
      const filename = await secureAsync(this.store.directory, ref, options),
        stat = await fsp.lstat(filename);
      cleanupProof.push([
        ref,
        stat.isDirectory()
          ? (await treeAsync(filename, options)).files
          : [{ path: '@file', bytes: stat.size, hash: `${stat.mtimeMs}:${stat.ctimeMs}` }],
      ]);
    }
    cancelled(options);
    if (change !== this.databaseChange())
      fail('扫描期间数据或引用变化，请重新扫描', 'TERMINAL_MAINTENANCE_STALE');
    const revision = hash(
      stable({
        rows,
        runs: runs.map((r) => [r.id, r.revision]),
        tasks: tasks.map((t) => [t.id, t.revision]),
        operations: operations.map((o) => [o.id, o.revision]),
        fingerprints,
        cleanupProof,
        cleanup,
      }),
    );
    return {
      cleanup,
      overview: {
        revision,
        checkedAt: now(),
        groups,
        coverage: groups.every((g) => g.coverage === 'complete')
          ? 'complete'
          : groups.some((g) => g.coverage !== 'unknown')
            ? 'partial'
            : 'unknown',
        pendingCleanup: this.pendingCleanup(),
        sessions,
        preserved,
        totalBytes: groups.reduce((n, g) => n + g.bytes, 0),
      },
    };
  }
  private plan(
    kind: TerminalMaintenancePlan['kind'],
    revision: string,
    items: TerminalMaintenancePlan['items'],
    extra: Partial<TerminalMaintenancePlan> = {},
  ) {
    const created = Date.now(),
      view = TerminalMaintenancePlan.parse({
        id: id(),
        kind,
        revision,
        createdAt: new Date(created).toISOString(),
        expiresAt: new Date(created + 10 * 60000).toISOString(),
        items,
        bytes: items.reduce((n, i) => n + i.bytes, 0),
        warnings: [],
        ...extra,
      });
    if (this.plans.size >= 30) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(view.id, { view });
    return view;
  }
  private requested(input: unknown, kind: TerminalMaintenancePlan['kind']) {
    const body = TerminalMaintenanceApply.parse(input),
      plan = this.plans.get(body.planId);
    if (
      !plan ||
      plan.view.kind !== kind ||
      plan.view.revision !== body.expectedRevision ||
      Date.parse(plan.view.expiresAt) < Date.now()
    )
      fail('维护计划已失效，请重新预览', 'TERMINAL_MAINTENANCE_STALE');
    return { body, plan };
  }
  async cleanupPlan(options: ScanOptions = {}) {
    const scan = await this.inventoryAsync(options);
    const items: TerminalMaintenancePlan['items'] = [];
    for (const ref of scan.cleanup) {
      await pause(options);
      items.push(
        await (async () => {
          const file = ref.startsWith(sessionKey)
            ? null
            : await secureAsync(this.store.directory, ref, options);
          return {
            kind: ref.startsWith(sessionKey) ? 'session-metadata' : 'owned-residue',
            ref,
            bytes: !file
              ? 0
              : (await fsp.lstat(file)).isFile()
                ? (await fsp.stat(file)).size
                : (await treeAsync(file, options)).bytes,
          };
        })(),
      );
    }
    cancelled(options);
    return this.plan('cleanup', scan.overview.revision, items, {
      warnings: ['不删除存活任务、未知 HOME、工作区、对象、日志和任何镜像。'],
    });
  }
  private journal(id: string) {
    const row = this.store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(cleanupKey + id) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    const entry = cleanupJournalSchema.parse(JSON.parse(row.value));
    if (entry.owner !== this.owner || entry.id !== id) fail('暂存清理归属无法确认，已保留');
    return entry;
  }
  private pendingCleanup(): TerminalMaintenanceOverview['pendingCleanup'] {
    const rows = this.store.db
      .prepare(
        "SELECT key,value FROM storage_meta WHERE key LIKE 'terminal-maintenance:cleanup:%' ORDER BY key",
      )
      .all() as { key: string; value: string }[];
    const result: TerminalMaintenanceOverview['pendingCleanup'] = [];
    for (const row of rows) {
      try {
        const entry = cleanupJournalSchema.parse(JSON.parse(row.value));
        if (entry.owner !== this.owner || row.key !== cleanupKey + entry.id) continue;
        result.push({
          id: entry.id,
          revision: entry.revision,
          createdAt: entry.createdAt,
          bytes: entry.bytes,
          items: entry.items.length,
          message: '清理登记已完成，暂存文件待移除；重试前需要重新检查',
        });
      } catch {
        /* Invalid records are preserved, never adopted as deletion authority. */
      }
    }
    return result;
  }
  private directoryEntries(root: string): string[] {
    const entries: string[] = [];
    const walk = (current: string, depth: number) => {
      if (depth > 24 || entries.length > 20000) fail('暂存目录范围超限');
      for (const name of fs.readdirSync(current).sort()) {
        const filename = secure(root, path.relative(root, path.join(current, name)));
        if (fs.lstatSync(filename).isDirectory()) {
          entries.push(path.relative(root, filename).split(path.sep).join('/'));
          walk(filename, depth + 1);
        }
      }
    };
    walk(root, 0);
    return entries;
  }
  private assertJournalReferences(entry: CleanupJournal) {
    if (this.dependencies.isActive()) fail('存在活跃终端，暂存文件保留');
    const records = this.store.db
      .prepare("SELECT value FROM storage_meta WHERE key LIKE 'terminal-session:%'")
      .all() as { value: string }[];
    const operations = this.references('tool_operations');
    for (const item of entry.items) {
      if (item.backup) {
        const authority = item.backup;
        if (
          item.owner ||
          authority.owner !== this.owner ||
          item.ref !== 'maintenance/backups/' + authority.id ||
          !item.directory ||
          !this.backupIndex.isDeleted(authority.id)
        )
          fail('快照暂存归属或已删除身份无法确认，保留');
        const run = this.store.get<Run>('runs', authority.runId),
          task = this.store.get<Task>('tasks', authority.taskId);
        if (
          this.dependencies.isActive(authority.runId) ||
          run?.status === 'RUNNING' ||
          task?.status === 'RUNNING' ||
          this.backupReaders.has(authority.id) ||
          this.references('tool_operations').some(
            (op) => op.runId === authority.runId && ['INTENT', 'UNCERTAIN'].includes(op.status),
          )
        )
          fail('快照仍有活跃或未确认引用，暂存内容保留');
        const row = this.store.db
          .prepare('SELECT value FROM storage_meta WHERE key=?')
          .get(sessionKey + authority.taskId) as { value: string } | undefined;
        if (row) {
          let data: unknown;
          try {
            data = JSON.parse(row.value);
          } catch {
            fail('当前会话元数据无法确认，快照暂存内容保留');
          }
          const record = TerminalSessionRecordSchema.safeParse(data);
          if (!record.success || record.data.pending)
            fail('当前会话存在待确认或未知状态，快照暂存内容保留', 'TERMINAL_BACKUP_PENDING');
        }
        continue;
      }
      const owner = item.owner;
      if (!owner) fail('暂存内容没有明确的清理归属，保留');
      if (
        !owner.stopped ||
        owner.owner !== this.owner ||
        !UUID.test(owner.operationId) ||
        (item.ref !== 'terminal-state/' + owner.operationId &&
          item.ref !== 'terminal-state/' + owner.operationId + '/environment')
      )
        fail('暂存归属标记不满足清理条件');
      if (
        this.store.db.prepare('SELECT id FROM runs WHERE id=?').get(owner.runId) ||
        this.store.db.prepare('SELECT id FROM tasks WHERE id=?').get(owner.taskId) ||
        operations.some(
          (o) =>
            o.id === owner.operationId ||
            o.id === owner.homeOperationId ||
            o.runId === owner.runId ||
            o.taskId === owner.taskId,
        )
      )
        fail('暂存内容重新出现任务或操作引用，已保留', 'TERMINAL_MAINTENANCE_STALE');
      for (const row of records) {
        let data: unknown;
        try {
          data = JSON.parse(row.value);
        } catch {
          fail('会话元数据无法确认，暂存内容保留');
        }
        const record = TerminalSessionRecordSchema.safeParse(data);
        if (!record.success) fail('会话元数据无法确认，暂存内容保留');
        const value = record.data;
        if (
          value.runId === owner.runId ||
          value.taskId === owner.taskId ||
          value.homeOperationId === owner.operationId ||
          value.lastOperationId === owner.operationId ||
          value.homeOperationId === owner.homeOperationId
        )
          fail('暂存内容重新出现会话引用，已保留', 'TERMINAL_MAINTENANCE_STALE');
      }
    }
  }
  private journalFiles(entry: CleanupJournal) {
    this.assertJournalReferences(entry);
    const relative = 'maintenance/cleanup/' + entry.id,
      root = secure(this.store.directory, relative, true);
    if (!fs.existsSync(root))
      return [
        ['missing', entry.items.map((item) => (item.backup ? this.backupReferenceProof(item.backup) : null))],
      ] as unknown[];
    if (!fs.lstatSync(root).isDirectory()) fail('暂存路径不是普通目录');
    const slots = fs.readdirSync(root).sort();
    if (slots.some((slot) => !entry.items.some((item) => item.slot === slot)))
      fail('暂存目录含未知文件，保留全部内容');
    const proof: unknown[] = [];
    for (const item of entry.items) {
      const filename = secure(this.store.directory, relative + '/' + item.slot, true);
      if (!fs.existsSync(filename)) {
        proof.push([item.slot, 'missing', item.backup ? this.backupReferenceProof(item.backup) : null]);
        continue;
      }
      if (fs.lstatSync(filename).isDirectory() !== item.directory) fail('暂存文件类型发生变化，保留');
      const files = item.directory
        ? tree(filename, { hashes: true }).files
        : [{ path: '@file', bytes: fs.statSync(filename).size, hash: hash(fs.readFileSync(filename)) }];
      const directories = item.directory ? this.directoryEntries(filename) : [];
      if (
        directories.some((value) => !item.directories.includes(value)) ||
        files.some((file) => !item.files.some((expected) => stable(expected) === stable(file)))
      )
        fail('暂存清单出现未知或变化内容，已保留');
      proof.push([
        item.slot,
        files,
        directories,
        item.backup ? this.backupReferenceProof(item.backup) : null,
      ]);
    }
    return proof;
  }
  private async journalFilesAsync(entry: CleanupJournal, options: ScanOptions) {
    this.assertJournalReferences(entry);
    const root = await secureAsync(this.store.directory, 'maintenance/cleanup/' + entry.id, options, true);
    let slots: string[];
    try {
      slots = await fsp.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return [
          [
            'missing',
            entry.items.map((item) => (item.backup ? this.backupReferenceProof(item.backup) : null)),
          ],
        ] as unknown[];
      throw error;
    }
    if (slots.some((slot) => !entry.items.some((item) => item.slot === slot)))
      fail('暂存目录含未知文件，已保留');
    const proof: unknown[] = [];
    for (const item of entry.items) {
      await pause(options);
      const filename = await secureAsync(
        this.store.directory,
        'maintenance/cleanup/' + entry.id + '/' + item.slot,
        options,
        true,
      );
      let stat: fs.Stats;
      try {
        stat = await fsp.lstat(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          proof.push([item.slot, 'missing', item.backup ? this.backupReferenceProof(item.backup) : null]);
          continue;
        }
        throw error;
      }
      if (stat.isDirectory() !== item.directory) fail('暂存文件类型发生变化，已保留');
      const files = item.directory
        ? (await treeAsync(filename, { ...options, hashes: true })).files
        : [{ path: '@file', bytes: stat.size, hash: await hashFileAsync(filename, options) }];
      // Directory names are bounded by the owned-residue rules (empty HOME only).
      const directories = item.directory ? this.directoryEntries(filename) : [];
      if (
        directories.some((value) => !item.directories.includes(value)) ||
        files.some((file) => !item.files.some((expected) => stable(expected) === stable(file)))
      )
        fail('暂存清单出现未知或变化内容，已保留');
      proof.push([
        item.slot,
        files,
        directories,
        item.backup ? this.backupReferenceProof(item.backup) : null,
      ]);
    }
    cancelled(options);
    this.assertJournalReferences(entry);
    return proof;
  }
  private finishCleanup(entry: CleanupJournal) {
    try {
      this.journalFiles(entry);
      const root = secure(this.store.directory, 'maintenance/cleanup/' + entry.id, true);
      if (fs.existsSync(root))
        (
          this.dependencies.removeQuarantine ??
          ((directory: string) => fs.rmSync(directory, { recursive: true, force: true }))
        )(root);
      if (fs.existsSync(root)) fail('暂存文件未完全移除');
      this.store.db.prepare('DELETE FROM storage_meta WHERE key=?').run(cleanupKey + entry.id);
      return false;
    } catch {
      return true;
    }
  }
  async retryCleanupPlan(retryId: string, expectedRevision?: number, options: ScanOptions = {}) {
    z.string().uuid().parse(retryId);
    const entry = this.journal(retryId);
    if (!entry) fail('没有待处理的暂存清理记录');
    if (expectedRevision !== undefined && entry.revision !== expectedRevision)
      fail('待清理记录版本已变化，请刷新', 'TERMINAL_MAINTENANCE_STALE');
    options.progress?.({ phase: 'hashing' });
    const change = this.databaseChange(),
      proof = await this.journalFilesAsync(entry, options);
    if (change !== this.databaseChange() || stable(this.journal(retryId)) !== stable(entry))
      fail('重试预览期间引用或版本变化，请重新预览', 'TERMINAL_MAINTENANCE_STALE');
    const view = this.plan(
      'cleanup',
      hash(stable({ entry, proof })),
      entry.items.map((item) => ({
        kind: 'owned-residue',
        ref: item.ref,
        bytes: item.files.reduce((n, f) => n + f.bytes, 0),
      })),
      { retryId, warnings: ['仅删除上一清理命令已登记的暂存内容；未知文件、工作区及镜像保留。'] },
    );
    this.plans.set(view.id, { view, retry: entry });
    return view;
  }
  retryCleanup(retryId: string, input: unknown) {
    z.string().uuid().parse(retryId);
    const parsed = TerminalMaintenanceApply.parse(input),
      payload = { route: 'terminal-maintenance/cleanup-retry', retryId, body: parsed };
    const replay = !!this.store.db.prepare('SELECT id FROM commands WHERE id=?').get(parsed.commandId);
    let committed: CleanupJournal | undefined;
    const result = this.store.command(parsed.commandId, payload, () => {
      const { plan } = this.requested(parsed, 'cleanup'),
        entry = this.journal(retryId);
      if (
        !entry ||
        plan.view.retryId !== retryId ||
        !plan.retry ||
        stable(entry) !== stable(plan.retry) ||
        hash(stable({ entry, proof: this.journalFiles(entry) })) !== plan.view.revision
      )
        fail('暂存内容、归属或引用变化，请重新预览', 'TERMINAL_MAINTENANCE_STALE');
      committed = { ...entry, revision: entry.revision + 1 };
      this.store.db
        .prepare('UPDATE storage_meta SET value=? WHERE key=?')
        .run(stable(committed), cleanupKey + retryId);
      return { deleted: entry.items.map((item) => item.ref), bytes: entry.bytes };
    });
    const pending = committed && !replay ? this.finishCleanup(committed) : !!this.journal(retryId);
    return {
      ...result,
      pendingCleanup: pending,
      message: pending ? '暂存内容仍未移除，记录已保留；请排除文件占用后重新预览' : '暂存清理已完成',
    };
  }
  cleanup(input: unknown) {
    const parsed = TerminalMaintenanceApply.parse(input);
    const moved: { from: string; to: string }[] = [];
    let quarantine: string | undefined, journal: CleanupJournal | undefined;
    let result: { deleted: string[]; bytes: number };
    try {
      result = this.store.command(
        parsed.commandId,
        { route: 'terminal-maintenance/cleanup', body: parsed },
        () => {
          const { plan } = this.requested(parsed, 'cleanup');
          if (plan.view.retryId) fail('请通过暂存清理重试入口确认');
          if (this.dependencies.isActive()) fail('存在活跃任务，请停止后重新预览维护计划');
          const current = this.inventory();
          if (
            current.overview.revision !== plan.view.revision ||
            stable(current.cleanup) !== stable(plan.view.items.map((i) => i.ref))
          )
            fail('数据或引用已变化，请重新预览清理计划', 'TERMINAL_MAINTENANCE_STALE');
          const items: CleanupJournal['items'] = [];
          for (const item of plan.view.items)
            if (item.kind === 'owned-residue') {
              const filename = secure(this.store.directory, item.ref),
                operationId = item.ref.split('/')[1],
                marker = secure(this.store.directory, 'terminal-state/' + operationId + '/owner.json');
              const owner = TerminalStateOwnerSchema.parse(JSON.parse(fs.readFileSync(marker, 'utf8'))),
                directory = fs.lstatSync(filename).isDirectory();
              items.push({
                ref: item.ref,
                slot: String(items.length),
                owner,
                directory,
                files: directory
                  ? tree(filename, { hashes: true }).files
                  : [
                      {
                        path: '@file',
                        bytes: fs.statSync(filename).size,
                        hash: hash(fs.readFileSync(filename)),
                      },
                    ],
                directories: directory ? this.directoryEntries(filename) : [],
              });
            }
          if (items.length) {
            journal = cleanupJournalSchema.parse({
              format: 1,
              owner: this.owner,
              id: parsed.commandId,
              revision: 0,
              createdAt: now(),
              bytes: plan.view.bytes,
              items,
            });
            this.assertJournalReferences(journal);
            quarantine = secure(this.store.directory, 'maintenance/cleanup/' + parsed.commandId, true);
            if (fs.existsSync(quarantine)) fail('清理暂存目录已存在，未知内容保留');
            fs.mkdirSync(quarantine, { recursive: true });
            this.store.db
              .prepare('INSERT INTO storage_meta(key,value) VALUES(?,?)')
              .run(cleanupKey + parsed.commandId, stable(journal));
          }
          for (const item of plan.view.items)
            if (item.kind === 'session-metadata')
              this.store.db.prepare('DELETE FROM storage_meta WHERE key=?').run(item.ref);
            else {
              const filename = secure(this.store.directory, item.ref),
                slot = items.find((entry) => entry.ref === item.ref)!.slot,
                to = path.join(quarantine!, slot);
              fs.renameSync(filename, to);
              moved.push({ from: filename, to });
            }
          return { deleted: plan.view.items.map((i) => i.ref), bytes: plan.view.bytes };
        },
      );
    } catch (error) {
      // Rollback is only for failures before the database command commits.
      for (const move of moved.reverse()) {
        if (fs.existsSync(move.from))
          fail('清理回滚路径被占用；原内容保留在暂存区', 'TERMINAL_CLEANUP_ROLLBACK');
        secure(this.store.directory, path.relative(this.store.directory, move.to));
        fs.renameSync(move.to, move.from);
      }
      if (quarantine && fs.existsSync(quarantine) && !fs.readdirSync(quarantine).length)
        fs.rmdirSync(quarantine);
      throw error;
    }
    const pending = journal ? this.finishCleanup(journal) : !!this.journal(parsed.commandId);
    return {
      ...result,
      pendingCleanup: pending,
      ...(pending ? { message: '清理登记已完成，暂存文件待移除；重启后可重新预览并重试' } : {}),
    };
  }
  async loadPlan(input: unknown) {
    const supplied = TerminalMaintenancePlan.parse(input);
    if (Date.parse(supplied.expiresAt) < Date.now()) fail('计划已过期，请重新预览');
    const fresh =
      supplied.kind === 'cleanup'
        ? supplied.retryId
          ? await this.retryCleanupPlan(supplied.retryId)
          : await this.cleanupPlan()
        : supplied.kind === 'delete'
          ? await this.deleteBackupPlan({ backupId: supplied.backupId })
          : supplied.kind === 'backup'
            ? await this.backupPlan({ runId: supplied.runId, expectedRevision: supplied.runRevision })
            : await this.restorePlan({ backupId: supplied.backupId, expectedRevision: supplied.runRevision });
    if (fresh.revision !== supplied.revision)
      fail('文件、引用或会话版本变化，请重新预览', 'TERMINAL_MAINTENANCE_STALE');
    const plan = this.plans.get(fresh.id)!;
    this.plans.delete(fresh.id);
    plan.view = { ...fresh, id: supplied.id, createdAt: supplied.createdAt, expiresAt: supplied.expiresAt };
    this.plans.set(supplied.id, plan);
    return plan.view;
  }
  backups() {
    return this.readBackups().map(
      ({
        format: _,
        owner: __,
        record: ___,
        checkpointData: ____,
        rollout: _____,
        workspace: ______,
        manifestHash: _______,
        ...view
      }) => TerminalSessionBackupView.parse(view),
    );
  }
  private readBackups(): Backup[] {
    const root = secure(this.store.directory, 'maintenance/backups', true);
    if (!fs.existsSync(root)) return [];
    const backups: Backup[] = [];
    for (const name of fs.readdirSync(root).sort().reverse()) {
      if (!UUID.test(name)) continue;
      try {
        const filename = secure(this.store.directory, 'maintenance/backups/' + name + '/backup.json'),
          stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) continue;
        const entry = backupSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8'))) as Backup;
        if (entry.owner !== this.owner || entry.id !== name) continue;
        backups.push(entry);
      } catch {
        /* Unknown backup files are preserved and never accepted as restore input. */
      }
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private historyView(backup: Backup, title?: string): TerminalBackupHistoryItem {
    const run = this.store.get<Run>('runs', backup.runId);
    return TerminalBackupHistoryItem.parse({
      id: backup.id,
      createdAt: backup.createdAt,
      runId: backup.runId,
      taskId: backup.taskId,
      runRevision: backup.runRevision,
      imageId: backup.imageId,
      bytes: backup.bytes,
      files: backup.files,
      checkpoint: backup.checkpoint,
      consistent: backup.consistent,
      title: (title ?? run?.title ?? run?.objective ?? backup.taskId).slice(0, 240),
      excludedCount: backup.excluded.length,
    });
  }
  async backupPage(input: unknown, options: ScanOptions = {}) {
    return this.backupIndex.page(input, options);
  }
  private async readBackupAsync(backupId: string, options: ScanOptions = {}): Promise<Backup> {
    z.string().uuid().parse(backupId);
    cancelled(options);
    if (this.backupIndex.isDeleted(backupId)) fail('此快照已删除，不能再恢复', 'TERMINAL_BACKUP_DELETED');
    this.backupReaders.set(backupId, (this.backupReaders.get(backupId) ?? 0) + 1);
    try {
      const filename = await secureAsync(
          this.store.directory,
          'maintenance/backups/' + backupId + '/backup.json',
          options,
        ),
        before = await fsp.lstat(filename);
      if (!before.isFile() || before.size > 32 * 1024 * 1024) fail('快照清单不是有界普通文件');
      const handle = await fsp.open(filename, 'r');
      let raw = '';
      try {
        const decoder = new TextDecoder(),
          buffer = Buffer.allocUnsafe(256 * 1024),
          opened = await handle.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink > 1) fail('快照清单变化');
        let offset = 0;
        while (offset < before.size) {
          cancelled(options);
          const part = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          if (!part.bytesRead) fail('快照清单正在变化');
          offset += part.bytesRead;
          raw += decoder.decode(buffer.subarray(0, part.bytesRead), { stream: true });
          await pause(options);
        }
        raw += decoder.decode();
      } finally {
        await handle.close();
      }
      const after = await fsp.lstat(filename);
      if (
        after.isSymbolicLink() ||
        after.nlink > 1 ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        fail('快照清单正在变化');
      const backup = backupSchema.parse(JSON.parse(raw)) as Backup;
      if (
        backup.owner !== this.owner ||
        backup.id !== backupId ||
        backup.record.runId !== backup.runId ||
        backup.record.taskId !== backup.taskId ||
        hash(stable({ rollout: backup.rollout, workspace: backup.workspace })) !== backup.manifestHash ||
        hash(stable(backup.checkpointData)) !== backup.checkpoint
      )
        fail('快照归属、身份或清单摘要无法确认');
      cancelled(options);
      return backup;
    } finally {
      const count = (this.backupReaders.get(backupId) ?? 1) - 1;
      if (count) this.backupReaders.set(backupId, count);
      else this.backupReaders.delete(backupId);
    }
  }
  private assertBackupDeletable(backup: Backup, ignorePlanId?: string, ignoreScanId?: string) {
    const run = this.store.get<Run>('runs', backup.runId),
      task = this.store.get<Task>('tasks', backup.taskId);
    if (
      this.dependencies.isActive(backup.runId) ||
      run?.status === 'RUNNING' ||
      task?.status === 'RUNNING' ||
      this.references('tool_operations').some(
        (op) => op.runId === backup.runId && ['INTENT', 'UNCERTAIN'].includes(op.status),
      )
    )
      fail('此任务仍在运行或存在未确认操作，请停止并确认后再删除', 'TERMINAL_BACKUP_ACTIVE');
    const row = this.store.db
      .prepare('SELECT value FROM storage_meta WHERE key=?')
      .get(sessionKey + backup.taskId) as { value: string } | undefined;
    if (row) {
      let value: unknown;
      try {
        value = JSON.parse(row.value);
      } catch {
        fail('当前会话元数据无法确认，快照保留');
      }
      const record = TerminalSessionRecordSchema.safeParse(value);
      if (!record.success || record.data.pending)
        fail('此会话有待确认操作，快照保留', 'TERMINAL_BACKUP_PENDING');
    }
    if (
      this.backupReaders.has(backup.id) ||
      [...this.scans.values()].some(
        (job) => job.backupId === backup.id && job.view.id !== ignoreScanId && job.view.status === 'running',
      )
    )
      fail('此快照仍在恢复检查中，请等待或取消', 'TERMINAL_BACKUP_REFERENCED');
    for (const [planId, plan] of this.plans)
      if (
        planId !== ignorePlanId &&
        plan.view.kind === 'restore' &&
        plan.view.backupId === backup.id &&
        Date.parse(plan.view.expiresAt) > Date.now() &&
        run?.revision === plan.view.runRevision
      ) {
        const current = row ? TerminalSessionRecordSchema.safeParse(JSON.parse(row.value)) : null;
        if (current?.success && current.data.revision === plan.snapshot?.record.revision)
          fail('此快照有待确认的恢复计划，请取消该计划后删除', 'TERMINAL_BACKUP_REFERENCED');
      }
  }
  async backupEligibility(backupId: string, options: ScanOptions = {}): Promise<TerminalBackupEligibility> {
    const backup = await this.readBackupAsync(backupId, options),
      run = this.store.get<Run>('runs', backup.runId);
    let canDelete = true,
      deleteReason = '只删除此归属快照，不影响当前会话、工作区或冻结镜像';
    try {
      this.assertBackupDeletable(backup);
    } catch (error) {
      canDelete = false;
      deleteReason = error instanceof AppError ? error.message : '引用无法确认，快照保留';
    }
    let canRestore = false,
      code = 'TERMINAL_BACKUP_RUN_MISSING',
      message = '原任务已不存在，此快照不能再续接；请使用新会话';
    if (!backup.consistent) {
      code = 'TERMINAL_BACKUP_CHECKPOINT';
      message = '恢复前保全快照不含可靠会话检查点，不能用于原会话续接';
    } else if (run) {
      try {
        cancelled(options);
        const snapshot = await this.dependencies.snapshot(run.id, run.revision, { requireConsistent: false });
        this.validateRestoreMetadata(snapshot, backup);
        canRestore = true;
        code = 'TERMINAL_BACKUP_ELIGIBLE';
        message = '同任务、最新轮次与冻结身份一致，可预览恢复；执行前会再次校验文件和版本';
      } catch (error) {
        code = error instanceof AppError ? error.code : 'TERMINAL_BACKUP_UNAVAILABLE';
        message = error instanceof AppError ? error.message : '当前会话资格无法确认，请使用新会话';
        if (!message.includes('新会话')) message += '；请使用新会话或重新选择最新快照';
      }
    }
    cancelled(options);
    return TerminalBackupEligibility.parse({
      backupId,
      runId: backup.runId,
      checkedAt: now(),
      canRestore,
      canDelete,
      runRevision: run?.revision ?? null,
      code,
      message,
      deleteReason,
    });
  }
  private backupReferenceProof(backup: Pick<Backup, 'runId' | 'taskId'>) {
    const run = this.store.get<Run>('runs', backup.runId),
      task = this.store.get<Task>('tasks', backup.taskId),
      row = this.store.db
        .prepare('SELECT value FROM storage_meta WHERE key=?')
        .get(sessionKey + backup.taskId) as { value: string } | undefined;
    return {
      run: run ? [run.id, run.revision, run.status] : null,
      task: task ? [task.id, task.revision, task.status] : null,
      session: row?.value ?? null,
      operations: this.references('tool_operations')
        .filter((op) => op.runId === backup.runId || op.taskId === backup.taskId)
        .map((op) => [op.id, op.revision, op.status]),
    };
  }
  async deleteBackupPlan(input: unknown, options: ScanOptions = {}) {
    const { backupId } = z.object({ backupId: z.string().uuid() }).strict().parse(input),
      backup = await this.readBackupAsync(backupId, options);
    this.assertBackupDeletable(backup, undefined, options.scanId);
    const refs = this.backupReferenceProof(backup),
      root = await secureAsync(this.store.directory, 'maintenance/backups/' + backupId, options);
    options.progress?.({ phase: 'hashing' });
    const files = await treeAsync(root, { ...options, hashes: true }),
      directories = this.directoryEntries(root);
    this.validateSnapshotFiles(backup, files.files, directories);
    cancelled(options);
    this.assertBackupDeletable(backup, undefined, options.scanId);
    if (stable(refs) !== stable(this.backupReferenceProof(backup)))
      fail('预览期间引用或版本变化，请重新预览', 'TERMINAL_MAINTENANCE_STALE');
    const proof = { backup: hash(stable(backup)), files: files.files, directories, refs },
      view = this.plan(
        'delete',
        hash(stable(proof)),
        [{ kind: 'backup-snapshot', ref: 'maintenance/backups/' + backupId, bytes: files.bytes }],
        {
          backupId,
          runId: backup.runId,
          warnings: [
            '删除后此快照不能再恢复；历史命令重放不会重建它。',
            '仅删除选定的本应用归属快照；CLI HOME、任务工作区、凭据与冻结镜像保持不变。',
          ],
        },
      );
    this.plans.set(view.id, { view, backup, deletionProof: proof });
    return view;
  }
  private validateSnapshotFiles(backup: Backup, files: FileEntry[], directories: string[]) {
    const expected = [
      { path: 'backup.json', bytes: 0, hash: '' },
      ...(backup.rollout ? [{ ...backup.rollout, path: 'home/' + backup.rollout.path }] : []),
      ...backup.workspace.map((file) => ({ ...file, path: 'workspace/' + file.path })),
    ];
    const allowedDirectories = new Set(['home', 'workspace']);
    for (const file of expected)
      for (let parent = path.posix.dirname(file.path); parent !== '.'; parent = path.posix.dirname(parent))
        allowedDirectories.add(parent);
    if (
      files.length !== expected.length ||
      directories.some((directory) => !allowedDirectories.has(directory)) ||
      files.some((file) => {
        const value = expected.find((entry) => entry.path === file.path);
        return (
          !value || (file.path !== 'backup.json' && (file.bytes !== value.bytes || file.hash !== value.hash))
        );
      })
    )
      fail('快照目录含未知、缺失或变更文件，保留全部内容');
  }
  deleteBackup(input: unknown) {
    const parsed = TerminalMaintenanceApply.parse(input),
      payload = { route: 'terminal-maintenance/backup-delete', body: parsed };
    let journal: CleanupJournal | undefined, moved: { from: string; to: string } | undefined;
    let result: { deleted: string; bytes: number };
    try {
      result = this.store.command(parsed.commandId, payload, () => {
        const { plan } = this.requested(parsed, 'delete'),
          backup = plan.backup!;
        this.assertBackupDeletable(backup, plan.view.id);
        const source = secure(this.store.directory, 'maintenance/backups/' + backup.id),
          filename = secure(source, 'backup.json'),
          current = backupSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8'))) as Backup;
        if (stable(current) !== stable(backup) || current.owner !== this.owner)
          fail('快照归属或清单变化，请重新预览', 'TERMINAL_MAINTENANCE_STALE');
        const files = tree(source, { hashes: true }).files,
          directories = this.directoryEntries(source);
        this.validateSnapshotFiles(backup, files, directories);
        const proof = {
          backup: hash(stable(backup)),
          files,
          directories,
          refs: this.backupReferenceProof(backup),
        };
        if (hash(stable(proof)) !== plan.view.revision)
          fail('快照、路径、引用或版本已变化，请重新预览', 'TERMINAL_MAINTENANCE_STALE');
        const root = secure(this.store.directory, 'maintenance/cleanup/' + parsed.commandId, true);
        if (fs.existsSync(root)) fail('暂存路径已存在，未知内容保留');
        journal = cleanupJournalSchema.parse({
          format: 1,
          owner: this.owner,
          id: parsed.commandId,
          revision: 0,
          createdAt: now(),
          bytes: plan.view.bytes,
          items: [
            {
              ref: 'maintenance/backups/' + backup.id,
              slot: '0',
              directory: true,
              files,
              directories,
              backup: {
                id: backup.id,
                owner: this.owner,
                runId: backup.runId,
                taskId: backup.taskId,
                manifestHash: backup.manifestHash,
                checkpoint: backup.checkpoint,
              },
            },
          ],
        });
        fs.mkdirSync(root, { recursive: true });
        this.store.db
          .prepare('INSERT INTO storage_meta(key,value) VALUES(?,?)')
          .run(cleanupKey + parsed.commandId, stable(journal));
        const to = path.join(root, '0');
        fs.renameSync(source, to);
        moved = { from: source, to };
        const stamp = fs.lstatSync(path.join(to, 'backup.json'));
        this.backupIndex.record(this.historyView(backup), `${stamp.size}:${stamp.mtimeMs}:${stamp.ctimeMs}`);
        this.backupIndex.deleted(backup.id);
        this.plans.delete(plan.view.id);
        return { deleted: backup.id, bytes: plan.view.bytes };
      });
    } catch (error) {
      if (moved && !fs.existsSync(moved.from)) {
        secure(this.store.directory, path.relative(this.store.directory, moved.to));
        fs.renameSync(moved.to, moved.from);
      }
      throw error;
    }
    const pending = journal ? this.finishCleanup(journal) : !!this.journal(parsed.commandId);
    return {
      ...result,
      pendingCleanup: pending,
      message: pending
        ? '快照已从历史移除，暂存文件待完成清理；不会重建或执行任务'
        : '选定快照已删除；当前会话和工作区未变更',
    };
  }
  async backupPlan(input: unknown, options: ScanOptions = {}) {
    const body = z
      .object({ runId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
      .strict()
      .parse(input);
    if (this.dependencies.isActive(body.runId)) fail('终端仍在运行，不能生成一致快照');
    cancelled(options);
    options.progress?.({ phase: 'verification' });
    const snapshot = await this.dependencies.snapshot(body.runId, body.expectedRevision);
    options.progress?.({ phase: 'hashing' });
    const change = this.databaseChange(),
      workspace = await treeAsync(snapshot.workspace, { ...options, filterSecrets: true, hashes: true }),
      rollout = await currentRolloutAsync(snapshot, options);
    this.checkPreviewSnapshot(snapshot, change, options);
    const revision = hash(
      stable({
        checkpoint: checkpoint(snapshot),
        runRevision: snapshot.run.revision,
        recordRevision: snapshot.record.revision,
        workspace: workspace.files,
        rollout,
      }),
    );
    const view = this.plan(
      'backup',
      revision,
      [
        {
          kind: 'session-rollout',
          ref: snapshot.rollout.relativePath,
          bytes: rollout?.bytes ?? 0,
        },
        { kind: 'workspace', ref: '当前任务工作区（过滤认证与环境文件）', bytes: workspace.bytes },
      ],
      {
        runId: body.runId,
        runRevision: body.expectedRevision,
        warnings: [
          '包含私有 CLI 会话与业务文件，请妥善保管。',
          '不包含密钥库、CLI 认证配置、环境文件或 Docker 镜像；任意业务文件中的自行嵌入秘密无法识别。',
          '仅同机、同任务、同最新操作与冻结镜像可恢复；已完成新轮次的旧快照不可续接。',
        ],
      },
    );
    this.plans.set(view.id, { view, snapshot, workspace: workspace.files, excluded: workspace.excluded });
    return view;
  }
  async createBackup(input: unknown) {
    const parsed = TerminalMaintenanceApply.parse(input);
    const replay = this.store.db.prepare('SELECT id FROM commands WHERE id=?').get(parsed.commandId);
    if (replay)
      return this.store.command(
        parsed.commandId,
        { route: 'terminal-maintenance/backup', body: parsed },
        () => fail('备份命令记录无效'),
      );
    const { plan } = this.requested(input, 'backup');
    return this.dependencies.guard(plan.view.runId!, plan.view.runRevision!, (snapshot) =>
      this.store.command(parsed.commandId, { route: 'terminal-maintenance/backup', body: parsed }, () => {
        const files = tree(snapshot.workspace, { filterSecrets: true, hashes: true });
        const revision = hash(
          stable({
            checkpoint: checkpoint(snapshot),
            runRevision: snapshot.run.revision,
            recordRevision: snapshot.record.revision,
            workspace: files.files,
            rollout: currentRollout(snapshot),
          }),
        );
        if (revision !== plan.view.revision)
          fail('会话或工作区已变化，请重新生成快照计划', 'TERMINAL_MAINTENANCE_STALE');
        return this.publish(snapshot, files.files, files.excluded, parsed.commandId);
      }),
    );
  }
  private publish(
    snapshot: TerminalMaintenanceSnapshot,
    workspace: FileEntry[],
    excluded: string[],
    backupId: string,
  ): TerminalSessionBackupView {
    const root = secure(this.store.directory, 'maintenance/backups/' + backupId, true);
    if (fs.existsSync(root)) fail('备份目录已存在，未覆盖未知内容');
    fs.mkdirSync(root, { recursive: true });
    try {
      fs.mkdirSync(path.join(root, 'home'));
      fs.mkdirSync(path.join(root, 'workspace'));
      const rollout = currentRollout(snapshot);
      if (rollout) copyFileChecked(snapshot.home, path.join(root, 'home'), rollout);
      for (const entry of workspace) copyFileChecked(snapshot.workspace, path.join(root, 'workspace'), entry);
      if (stable(tree(snapshot.workspace, { filterSecrets: true, hashes: true }).files) !== stable(workspace))
        fail('工作区在备份期间发生变化');
      const data = checkpoint(snapshot),
        view: TerminalSessionBackupView = {
          id: backupId,
          createdAt: now(),
          runId: snapshot.run.id,
          taskId: snapshot.task.id,
          runRevision: snapshot.run.revision,
          imageId: snapshot.imageId,
          bytes: (rollout?.bytes ?? 0) + workspace.reduce((n, e) => n + e.bytes, 0),
          files: workspace.length + (rollout ? 1 : 0),
          excluded,
          checkpoint: hash(stable(data)),
          consistent: !!snapshot.consistent && rollout?.hash === snapshot.record.state?.hash,
        };
      const manifest: Backup = {
        ...view,
        format: 1,
        owner: this.owner,
        record: snapshot.record,
        checkpointData: data,
        rollout,
        workspace,
        manifestHash: hash(stable({ rollout, workspace })),
      };
      const filename = path.join(root, 'backup.json');
      fs.writeFileSync(filename, stable(manifest), { flag: 'wx' });
      const stamp = fs.lstatSync(filename);
      this.backupIndex.record(
        this.historyView(manifest, snapshot.run.title ?? snapshot.run.objective),
        `${stamp.size}:${stamp.mtimeMs}:${stamp.ctimeMs}`,
      );
      return view;
    } catch (error) {
      secure(this.store.directory, 'maintenance/backups/' + backupId);
      tree(root);
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }
  async restorePlan(input: unknown, options: ScanOptions = {}) {
    const body = z
        .object({ backupId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
        .strict()
        .parse(input),
      backupId = body.backupId;
    this.backupReaders.set(backupId, (this.backupReaders.get(backupId) ?? 0) + 1);
    try {
      return await this.restorePlanInternal(body, options);
    } finally {
      const count = (this.backupReaders.get(backupId) ?? 1) - 1;
      if (count) this.backupReaders.set(backupId, count);
      else this.backupReaders.delete(backupId);
    }
  }
  private async restorePlanInternal(input: unknown, options: ScanOptions = {}) {
    const body = z
        .object({ backupId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
        .strict()
        .parse(input),
      backup = await this.readBackupAsync(body.backupId, options);
    if (!backup) fail('没有可验证的同机备份');
    const snapshot = await this.dependencies.snapshot(backup.runId, body.expectedRevision, {
      requireConsistent: false,
    });
    cancelled(options);
    options.progress?.({ phase: 'hashing' });
    const change = this.databaseChange();
    await this.validateRestoreAsync(snapshot, backup, options);
    const current = await treeAsync(snapshot.workspace, { ...options, filterSecrets: true, hashes: true }),
      rollout = await currentRolloutAsync(snapshot, options);
    this.checkPreviewSnapshot(snapshot, change, options);
    const revision = hash(
      stable({
        checkpoint: checkpoint(snapshot),
        recordRevision: snapshot.record.revision,
        runRevision: snapshot.run.revision,
        current: current.files,
        rollout,
        backup: backup.manifestHash,
      }),
    );
    const view = this.plan(
      'restore',
      revision,
      [
        { kind: 'session-rollout', ref: backup.rollout!.path, bytes: backup.rollout!.bytes },
        {
          kind: 'workspace',
          ref: '同任务工作区（当前内容保留为恢复前快照）',
          bytes: backup.workspace.reduce((n, e) => n + e.bytes, 0),
        },
      ],
      {
        runId: backup.runId,
        runRevision: body.expectedRevision,
        backupId: backup.id,
        warnings: [
          '将恢复选定会话文件与工作区，当前内容先保留为恢复前快照。',
          '密钥库、环境文件和镜像保持不变；恢复不会启动任务，请重新检查后手动继续。',
        ],
      },
    );
    this.plans.set(view.id, { view, snapshot, backup, workspace: current.files, excluded: current.excluded });
    return view;
  }
  private validateRestoreMetadata(snapshot: TerminalMaintenanceSnapshot, backup: Backup) {
    if (
      !backup.consistent ||
      !backup.rollout ||
      backup.rollout.path !== snapshot.record.state?.path ||
      backup.rollout.hash !== snapshot.record.state?.hash
    )
      fail('此快照不是可续接的一致检查点，请使用新会话', 'TERMINAL_BACKUP_CHECKPOINT');
    if (
      hash(stable(checkpoint(snapshot))) !== backup.checkpoint ||
      stable(checkpoint(snapshot)) !== stable(backup.checkpointData)
    )
      fail('快照与当前最新轮次或冻结身份不一致，请使用新会话', 'TERMINAL_BACKUP_CHECKPOINT');
    const root = secure(this.store.directory, 'maintenance/backups/' + backup.id);
    if (hash(stable({ rollout: backup.rollout, workspace: backup.workspace })) !== backup.manifestHash)
      fail('备份清单不一致');
    if (
      backup.workspace.length > 20000 ||
      new Set(backup.workspace.map((e) => e.path)).size !== backup.workspace.length
    )
      fail('备份清单数量或路径无效');
    return root;
  }
  private validateRestore(snapshot: TerminalMaintenanceSnapshot, backup: Backup) {
    const root = this.validateRestoreMetadata(snapshot, backup);
    let bytes = 0;
    for (const [base, entries] of [
      [path.join(root, 'home'), [backup.rollout!]],
      [path.join(root, 'workspace'), backup.workspace],
    ] as const)
      for (const entry of entries) {
        const filename = secure(base, entry.path),
          stat = fs.lstatSync(filename);
        bytes += stat.size;
        if (
          (base.endsWith('workspace') && excludedPath(entry.path)) ||
          secretName.test(path.basename(entry.path)) ||
          !stat.isFile() ||
          stat.size !== entry.bytes ||
          bytes > 512 * 1024 * 1024 ||
          hash(fs.readFileSync(filename)) !== entry.hash
        )
          fail('备份文件缺失或摘要不一致');
      }
  }
  private checkPreviewSnapshot(snapshot: TerminalMaintenanceSnapshot, change: number, options: ScanOptions) {
    cancelled(options);
    if (
      change !== this.databaseChange() ||
      this.store.get<Run>('runs', snapshot.run.id)?.revision !== snapshot.run.revision ||
      this.store.get<Task>('tasks', snapshot.task.id)?.revision !== snapshot.task.revision ||
      this.store.get<Operation>('tool_operations', snapshot.operation.id)?.revision !==
        snapshot.operation.revision ||
      this.dependencies.isActive(snapshot.run.id)
    )
      fail('预览期间会话、工作区或引用变化，请重新预览', 'TERMINAL_MAINTENANCE_STALE');
    options.progress?.({ phase: 'verification' });
  }
  private async validateRestoreAsync(
    snapshot: TerminalMaintenanceSnapshot,
    backup: Backup,
    options: ScanOptions,
  ) {
    const root = this.validateRestoreMetadata(snapshot, backup);
    let bytes = 0;
    for (const [base, entries] of [
      [path.join(root, 'home'), [backup.rollout!]],
      [path.join(root, 'workspace'), backup.workspace],
    ] as const)
      for (const entry of entries) {
        await pause(options);
        const filename = await secureAsync(base, entry.path, options),
          stat = await fsp.lstat(filename);
        bytes += stat.size;
        if (
          (base.endsWith('workspace') && excludedPath(entry.path)) ||
          secretName.test(path.basename(entry.path)) ||
          !stat.isFile() ||
          stat.size !== entry.bytes ||
          bytes > 512 * 1024 * 1024 ||
          (await hashFileAsync(filename, options)) !== entry.hash
        )
          fail('备份文件缺失或摘要不一致');
        options.progress?.({ filesVisited: 1 });
      }
  }
  async restore(input: unknown) {
    const parsed = TerminalMaintenanceApply.parse(input),
      payload = { route: 'terminal-maintenance/restore', body: parsed };
    if (this.store.db.prepare('SELECT id FROM commands WHERE id=?').get(parsed.commandId))
      return this.store.command(parsed.commandId, payload, () => fail('恢复命令记录无效'));
    const { plan } = this.requested(input, 'restore');
    return this.dependencies.guard(
      plan.view.runId!,
      plan.view.runRevision!,
      (snapshot) =>
        this.store.command(parsed.commandId, payload, () => {
          const backup = plan.backup!;
          this.validateRestore(snapshot, backup);
          const current = tree(snapshot.workspace, { filterSecrets: true, hashes: true }),
            previousRollout = currentRollout(snapshot);
          const revision = hash(
            stable({
              checkpoint: checkpoint(snapshot),
              recordRevision: snapshot.record.revision,
              runRevision: snapshot.run.revision,
              current: current.files,
              rollout: previousRollout,
              backup: backup.manifestHash,
            }),
          );
          if (revision !== plan.view.revision)
            fail('恢复预览后会话或工作区变化，请重新预览', 'TERMINAL_MAINTENANCE_STALE');
          const beforeId = id();
          const before = this.publish(snapshot, current.files, current.excluded, beforeId),
            source = secure(this.store.directory, 'maintenance/backups/' + backup.id),
            rollback = secure(this.store.directory, 'maintenance/backups/' + beforeId);
          try {
            copyFileChecked(path.join(source, 'home'), snapshot.home, backup.rollout!);
            for (const entry of current.files)
              if (!backup.workspace.some((e) => e.path === entry.path))
                fs.unlinkSync(secure(snapshot.workspace, entry.path));
            for (const entry of backup.workspace)
              copyFileChecked(path.join(source, 'workspace'), snapshot.workspace, entry);
            if (
              stable(tree(snapshot.workspace, { filterSecrets: true, hashes: true }).files) !==
              stable(backup.workspace)
            )
              fail('恢复后工作区摘要不一致');
            if (hash(fs.readFileSync(snapshot.rollout.path)) !== snapshot.record.state?.hash)
              fail('恢复后会话摘要未匹配检查点');
            this.plans.delete(plan.view.id);
            return {
              restored: backup.id,
              runId: backup.runId,
              beforeRestore: before.id,
              message: '文件已恢复；未启动任务，请重新检查后显式继续',
            };
          } catch (error) {
            try {
              if (previousRollout)
                copyFileChecked(path.join(rollback, 'home'), snapshot.home, previousRollout);
              else if (fs.existsSync(snapshot.rollout.path))
                fs.unlinkSync(secure(snapshot.home, snapshot.rollout.relativePath));
              for (const entry of tree(snapshot.workspace, { filterSecrets: true, hashes: true }).files)
                if (!current.files.some((e) => e.path === entry.path))
                  fs.unlinkSync(secure(snapshot.workspace, entry.path));
              for (const entry of current.files)
                copyFileChecked(path.join(rollback, 'workspace'), snapshot.workspace, entry);
            } catch {
              fail('恢复及回滚未完成；恢复前快照已保留，请停止后人工核验', 'TERMINAL_RESTORE_ROLLBACK');
            }
            throw error;
          }
        }),
      { mutates: true },
    );
  }
}

export function registerTerminalMaintenance(
  app: FastifyInstance,
  store: Store,
  dependencies: TerminalMaintenanceDependencies,
) {
  const maintenance = new TerminalMaintenance(store, dependencies),
    root = '/api/terminal/control/maintenance';
  app.addHook('onClose', async () => maintenance.close());
  app.post(root + '/scans', (request) => maintenance.startScan(request.body));
  app.get<{ Params: { id: string } }>(root + '/scans/:id', (request) => maintenance.scan(request.params.id));
  app.post<{ Params: { id: string } }>(root + '/scans/:id/cancel', (request) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return maintenance.cancelScan(request.params.id);
  });
  const readonly = async (
    request: { raw: import('node:http').IncomingMessage },
    reply: { raw: import('node:http').ServerResponse },
    action: (options: ScanOptions) => Promise<unknown>,
  ) => {
    const controller = new AbortController(),
      abort = () => controller.abort(),
      close = () => {
        if (!reply.raw.writableEnded) abort();
      };
    request.raw.once('aborted', abort);
    reply.raw.once('close', close);
    try {
      return await action({ signal: controller.signal });
    } finally {
      request.raw.off('aborted', abort);
      reply.raw.off('close', close);
    }
  };
  app.get(root, (request, reply) => readonly(request, reply, (options) => maintenance.overview(options)));
  app.get(root + '/backups', () => maintenance.backups());
  app.get(root + '/backups/page', (request, reply) =>
    readonly(request, reply, (options) => maintenance.backupPage(request.query, options)),
  );
  app.get<{ Params: { id: string } }>(root + '/backups/:id/eligibility', (request, reply) =>
    readonly(request, reply, (options) => maintenance.backupEligibility(request.params.id, options)),
  );
  app.post(root + '/backups/delete/plan', (request, reply) =>
    readonly(request, reply, (options) => maintenance.deleteBackupPlan(request.body, options)),
  );
  app.post(root + '/backups/delete', (request) => maintenance.deleteBackup(request.body));
  app.post<{ Params: { id: string } }>(root + '/plans/:id/cancel', (request) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return maintenance.cancelPlan(request.params.id);
  });
  app.post(root + '/cleanup/plan', (request, reply) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return readonly(request, reply, (options) => maintenance.cleanupPlan(options));
  });
  app.post<{ Params: { id: string } }>(root + '/cleanup/retries/:id/plan', (request, reply) => {
    const body = z.object({ expectedRevision: z.number().int().nonnegative() }).strict().parse(request.body);
    return readonly(request, reply, (options) =>
      maintenance.retryCleanupPlan(request.params.id, body.expectedRevision, options),
    );
  });
  app.post<{ Params: { id: string } }>(root + '/cleanup/retries/:id/apply', (request) =>
    maintenance.retryCleanup(request.params.id, request.body),
  );
  app.post(root + '/cleanup/apply', (request) => maintenance.cleanup(request.body));
  app.post(root + '/backups/plan', (request, reply) =>
    readonly(request, reply, (options) => maintenance.backupPlan(request.body, options)),
  );
  app.post(root + '/backups/create', (request) => maintenance.createBackup(request.body));
  app.post(root + '/backups/restore/plan', (request, reply) =>
    readonly(request, reply, (options) => maintenance.restorePlan(request.body, options)),
  );
  app.post(root + '/backups/restore', (request) => maintenance.restore(request.body));
  return maintenance;
}
