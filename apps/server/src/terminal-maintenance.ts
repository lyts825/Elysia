import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fs from 'node:fs';
import path from 'node:path';
import { AppError, type Run, type Task, type Operation } from '../../../packages/contracts/src/index.js';
import {
  TerminalMaintenanceApply,
  TerminalMaintenanceOverview,
  TerminalMaintenancePlan,
  TerminalSessionBackupView,
} from '../../../packages/contracts/src/terminal-maintenance.js';
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
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sessionKey = 'terminal-session:';
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
};

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
  private owner: string;
  constructor(
    private store: Store,
    private dependencies: TerminalMaintenanceDependencies,
  ) {
    this.owner = hash(path.resolve(store.directory)).slice(0, 32);
  }
  overview(): TerminalMaintenanceOverview {
    const scan = this.inventory();
    return TerminalMaintenanceOverview.parse(scan.overview);
  }
  private inventory() {
    const runs = this.store.all<Run>('runs'),
      tasks = this.store.all<Task>('tasks'),
      operations = this.store.all<Operation>('tool_operations');
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
      const run = runs.find((r) => r.id === record.runId),
        task = tasks.find((t) => t.id === record.taskId),
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
    const revision = hash(
      stable({
        rows,
        runs: runs.map((r) => [r.id, r.revision, r.status]),
        tasks: tasks.map((t) => [t.id, t.revision, t.status]),
        operations: operations.map((o) => [o.id, o.revision, o.status]),
        fingerprints,
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
  cleanupPlan() {
    const scan = this.inventory();
    return this.plan(
      'cleanup',
      scan.overview.revision,
      scan.cleanup.map((ref) => {
        const file = ref.startsWith(sessionKey) ? null : secure(this.store.directory, ref);
        return {
          kind: ref.startsWith(sessionKey) ? 'session-metadata' : 'owned-residue',
          ref,
          bytes: !file ? 0 : fs.lstatSync(file).isFile() ? fs.statSync(file).size : tree(file).bytes,
        };
      }),
      { warnings: ['不删除存活任务、未知 HOME、工作区、对象、日志和任何镜像。'] },
    );
  }
  cleanup(input: unknown) {
    const parsed = TerminalMaintenanceApply.parse(input);
    const moved: { from: string; to: string }[] = [];
    let quarantine: string | undefined;
    try {
      const result = this.store.command(
        parsed.commandId,
        { route: 'terminal-maintenance/cleanup', body: parsed },
        () => {
          const { plan } = this.requested(input, 'cleanup');
          if (this.dependencies.isActive()) fail('存在活跃任务，请停止后重新预览维护计划');
          const current = this.inventory();
          if (
            current.overview.revision !== plan.view.revision ||
            stable(current.cleanup) !== stable(plan.view.items.map((i) => i.ref))
          )
            fail('数据或引用已变化，请重新预览清理计划', 'TERMINAL_MAINTENANCE_STALE');
          // Rename first so a database failure can restore every known file; unknown content is never swept.
          if (plan.view.items.some((item) => item.kind === 'owned-residue')) {
            quarantine = secure(this.store.directory, 'maintenance/cleanup/' + parsed.commandId, true);
            if (fs.existsSync(quarantine)) fail('清理暂存目录已存在，保留未知内容');
            fs.mkdirSync(quarantine, { recursive: true });
          }
          for (const item of plan.view.items)
            if (item.kind === 'session-metadata')
              this.store.db.prepare('DELETE FROM storage_meta WHERE key=?').run(item.ref);
            else {
              const filename = secure(this.store.directory, item.ref);
              if (fs.lstatSync(filename).isDirectory()) tree(filename);
              const to = path.join(quarantine!, String(moved.length));
              fs.renameSync(filename, to);
              moved.push({ from: filename, to });
            }
          return { deleted: plan.view.items.map((i) => i.ref), bytes: plan.view.bytes };
        },
      );
      if (quarantine) {
        try {
          secure(this.store.directory, path.relative(this.store.directory, quarantine));
          tree(quarantine);
          fs.rmSync(quarantine, { recursive: true, force: true });
        } catch {
          return {
            ...result,
            pendingCleanup: true,
            message: '清理登记已完成，暂存文件尚未移除；内容保留，请稍后检查维护占用',
          };
        }
      }
      return result;
    } catch (error) {
      for (const move of moved.reverse()) {
        if (fs.existsSync(move.from))
          fail('清理回滚路径已被占用；原内容保留在维护暂存区', 'TERMINAL_CLEANUP_ROLLBACK');
        secure(this.store.directory, path.relative(this.store.directory, move.to));
        fs.renameSync(move.to, move.from);
      }
      if (quarantine && fs.existsSync(quarantine) && !fs.readdirSync(quarantine).length)
        fs.rmdirSync(quarantine);
      throw error;
    }
  }
  async loadPlan(input: unknown) {
    const supplied = TerminalMaintenancePlan.parse(input);
    if (Date.parse(supplied.expiresAt) < Date.now()) fail('计划已过期，请重新预览');
    const fresh =
      supplied.kind === 'cleanup'
        ? this.cleanupPlan()
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
  async backupPlan(input: unknown) {
    const body = z
      .object({ runId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
      .strict()
      .parse(input);
    if (this.dependencies.isActive(body.runId)) fail('终端仍在运行，不能生成一致快照');
    const snapshot = await this.dependencies.snapshot(body.runId, body.expectedRevision),
      workspace = tree(snapshot.workspace, { filterSecrets: true, hashes: true });
    const revision = hash(
      stable({
        checkpoint: checkpoint(snapshot),
        runRevision: snapshot.run.revision,
        recordRevision: snapshot.record.revision,
        workspace: workspace.files,
        rollout: currentRollout(snapshot),
      }),
    );
    const view = this.plan(
      'backup',
      revision,
      [
        {
          kind: 'session-rollout',
          ref: snapshot.rollout.relativePath,
          bytes: fs.statSync(snapshot.rollout.path).size,
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
      fs.writeFileSync(path.join(root, 'backup.json'), stable(manifest), { flag: 'wx' });
      return view;
    } catch (error) {
      secure(this.store.directory, 'maintenance/backups/' + backupId);
      tree(root);
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }
  async restorePlan(input: unknown) {
    const body = z
        .object({ backupId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
        .strict()
        .parse(input),
      backup = this.readBackups().find((b) => b.id === body.backupId);
    if (!backup) fail('没有可验证的同机备份');
    const snapshot = await this.dependencies.snapshot(backup.runId, body.expectedRevision, {
      requireConsistent: false,
    });
    this.validateRestore(snapshot, backup);
    const current = tree(snapshot.workspace, { filterSecrets: true, hashes: true });
    const revision = hash(
      stable({
        checkpoint: checkpoint(snapshot),
        recordRevision: snapshot.record.revision,
        runRevision: snapshot.run.revision,
        current: current.files,
        rollout: currentRollout(snapshot),
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
  private validateRestore(snapshot: TerminalMaintenanceSnapshot, backup: Backup) {
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
    let bytes = 0;
    for (const [base, entries] of [
      [path.join(root, 'home'), [backup.rollout]],
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
  app.get(root, () => maintenance.overview());
  app.get(root + '/backups', () => maintenance.backups());
  app.post(root + '/cleanup/plan', (request) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return maintenance.cleanupPlan();
  });
  app.post(root + '/cleanup/apply', (request) => maintenance.cleanup(request.body));
  app.post(root + '/backups/plan', (request) => maintenance.backupPlan(request.body));
  app.post(root + '/backups/create', (request) => maintenance.createBackup(request.body));
  app.post(root + '/backups/restore/plan', (request) => maintenance.restorePlan(request.body));
  app.post(root + '/backups/restore', (request) => maintenance.restore(request.body));
  return maintenance;
}
