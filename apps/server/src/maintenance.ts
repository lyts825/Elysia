import {
  Store,
  dataDirectory,
  id,
  now,
  stable,
  STORAGE_SCHEMA_VERSION,
} from '../../../packages/storage/src/index.js';
import { VERSION } from '../../../packages/contracts/src/index.js';
import { Kernel } from '../../../packages/kernel/src/index.js';
import { ToolGateway } from '../../../packages/tools/src/index.js';
import { DockerAgentService } from '../../../packages/runtime/src/docker-agent.js';
import { TerminalMaintenance } from './terminal-maintenance.js';
import { z } from 'zod';
import { TerminalMaintenancePlan } from '../../../packages/contracts/src/terminal-maintenance.js';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  readdirSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import {
  type Surface,
  type Selection,
  type SurfaceBackup,
  type BackupMetadata,
  assertSurfacePath,
  surfaceDirectory,
  assertDirectory,
  canonicalDestination,
  isWithin,
  prepareSurface,
  copyDirectory,
  removeStage,
  backupSurfaces,
  installPrepared,
  acquireSurfaceLocks,
  recoverPreparedInstall,
} from './maintenance-storage.js';
import { prepareStartupUpgrade } from './startup-storage.js';
const action = process.argv[2];
const terminalActions = [
  'terminal-inspect',
  'terminal-cleanup-plan',
  'terminal-cleanup',
  'terminal-cleanup-retry-plan',
  'terminal-cleanup-retry',
  'terminal-session-backup-plan',
  'terminal-session-backup',
  'terminal-session-restore-plan',
  'terminal-session-restore',
  'terminal-session-delete-plan',
  'terminal-session-delete',
  'terminal-session-history',
];
let selection: Selection = 'all';
let argument: string | undefined;
let hasSelection = false;
for (let index = 3; index < process.argv.length; index++) {
  const value = process.argv[index];
  if (value === '--surface' || value.startsWith('--surface=')) {
    const selected = value === '--surface' ? process.argv[++index] : value.slice('--surface='.length);
    if (hasSelection || !['native', 'terminal', 'all'].includes(selected))
      throw new Error('--surface 只能指定一次，取值为 native、terminal 或 all');
    selection = selected as Selection;
    hasSelection = true;
  } else if (value.startsWith('--') || argument) throw new Error('未知或重复的维护参数：' + value);
  else argument = value;
}
if (
  argument &&
  ![
    'backup',
    'restore',
    ...terminalActions.filter((name) => !['terminal-inspect', 'terminal-cleanup-plan'].includes(name)),
  ].includes(action)
)
  throw new Error('此维护操作不接受路径参数');
if (terminalActions.includes(action) && hasSelection && selection !== 'terminal')
  throw new Error('terminal-* 维护操作只能用于 terminal 入口');

async function terminalMaintenance(directory: string) {
  assertSurfacePath(directory, 'terminal');
  const target = surfaceDirectory(directory, 'terminal');
  if (!existsSync(path.join(target, 'state.db'))) throw new Error('未找到终端入口数据库');
  const store = new Store(target),
    kernel = new Kernel(store),
    gateway = new ToolGateway(kernel);
  const service = new DockerAgentService(kernel, gateway, {
    transport: {
      run: async () => {
        throw new Error('文件维护不能调用 Docker');
      },
    },
    environment: () => {
      throw new Error('文件维护不能读取 CLI 凭据');
    },
    resolveConnection: async () => {
      throw new Error('文件维护不能读取 API 凭据');
    },
  });
  const maintenance = new TerminalMaintenance(store, {
    snapshot: service.maintenanceSnapshot.bind(service),
    guard: service.withMaintenanceGuard.bind(service),
    isActive: (runId) => store.all<any>('tasks', runId).some((task) => task.status === 'RUNNING'),
  });
  function input() {
    if (!argument) throw new Error(action + ' 需要预览输入或计划 JSON 文件路径');
    const filename = path.resolve(argument),
      stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error('维护输入须为不超过 1 MiB 的普通 JSON 文件');
    return JSON.parse(readFileSync(filename, 'utf8'));
  }
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const scanOptions = { signal: controller.signal };
  try {
    if (action === 'terminal-inspect')
      return { overview: await maintenance.overview(scanOptions), backups: maintenance.backups() };
    if (action === 'terminal-session-history')
      return await maintenance.backupPage(argument ? input() : {}, scanOptions);
    if (action.endsWith('-plan')) {
      const plan =
        action === 'terminal-cleanup-plan'
          ? await maintenance.cleanupPlan(scanOptions)
          : action === 'terminal-cleanup-retry-plan'
            ? await (() => {
                const body = z
                  .object({ retryId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() })
                  .strict()
                  .parse(input());
                return maintenance.retryCleanupPlan(body.retryId, body.expectedRevision, scanOptions);
              })()
            : action === 'terminal-session-delete-plan'
              ? await maintenance.deleteBackupPlan(input(), scanOptions)
              : action === 'terminal-session-backup-plan'
                ? await maintenance.backupPlan(input(), scanOptions)
                : await maintenance.restorePlan(input(), scanOptions);
      return { commandId: id(), plan };
    }
    const supplied = input(),
      envelope = z
        .object({ commandId: z.string().uuid(), plan: TerminalMaintenancePlan })
        .strict()
        .parse(supplied);
    const expectedKind = ['terminal-cleanup', 'terminal-cleanup-retry'].includes(action)
      ? 'cleanup'
      : action === 'terminal-session-delete'
        ? 'delete'
        : action === 'terminal-session-backup'
          ? 'backup'
          : 'restore';
    if (envelope.plan.kind !== expectedKind) throw new Error('维护计划与当前操作不一致');
    // A committed command is replayed using its original payload before revalidating an expired plan.
    if (!store.db.prepare('SELECT id FROM commands WHERE id=?').get(envelope.commandId))
      await maintenance.loadPlan(envelope.plan);
    const body = {
      commandId: envelope.commandId,
      planId: envelope.plan.id,
      expectedRevision: envelope.plan.revision,
    };
    if (action === 'terminal-cleanup-retry') {
      if (!envelope.plan.retryId) throw new Error('重试计划缺少暂存记录');
      return maintenance.retryCleanup(envelope.plan.retryId, body);
    }
    if (action === 'terminal-session-delete') return maintenance.deleteBackup(body);
    return action === 'terminal-cleanup'
      ? maintenance.cleanup(body)
      : action === 'terminal-session-backup'
        ? await maintenance.createBackup(body)
        : await maintenance.restore(body);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    maintenance.close();
    await gateway.dispose();
    store.close();
  }
}

const configuredDirectory = dataDirectory();
if (action === 'stop') {
  if (!existsSync(path.join(configuredDirectory, 'service.lock')))
    throw new Error('未找到正在运行的 Elysia 服务');
  const lock = JSON.parse(readFileSync(path.join(configuredDirectory, 'service.lock'), 'utf8'));
  try {
    process.kill(lock.pid, 0);
  } catch {
    throw new Error('服务锁已过期，请先核验进程');
  }
  writeFileSync(
    path.join(configuredDirectory, 'stop.request'),
    stable({ requestedAt: now(), token: lock.token }),
  );
  console.log('已请求服务在安全边界停止（两个入口整体停止）');
} else {
  // Preflight both surface locks before backup, recovery, migration or terminal maintenance.
  const release = acquireSurfaceLocks(configuredDirectory);
  const directory = realpathSync(configuredDirectory);
  try {
    recoverPreparedInstall(directory);
    if (terminalActions.includes(action)) {
      await prepareStartupUpgrade(directory, ['terminal']);
      console.log(stable(await terminalMaintenance(directory)));
    } else if (action === 'migrate') {
      const surfaces: Surface[] =
        selection === 'all'
          ? [
              'native',
              ...(existsSync(path.join(surfaceDirectory(directory, 'terminal'), 'state.db'))
                ? ['terminal' as const]
                : []),
            ]
          : [selection];
      const backup = await prepareStartupUpgrade(directory, surfaces);
      if (backup) console.log('升级前备份：' + backup);
      console.log(
        'schema v' + STORAGE_SCHEMA_VERSION + ' 迁移完成（' + surfaces.join('、') + '）：' + directory,
      );
    } else if (action === 'backup') {
      const target = canonicalDestination(
        path.resolve(argument || path.join(directory, 'backups', now().replace(/[:.]/g, '-'))),
      );
      if (target === directory || isWithin(target, directory))
        throw new Error('备份目标不能覆盖数据目录或其祖先');
      if (isWithin(directory, target) && !isWithin(path.join(directory, 'backups'), target))
        throw new Error('数据目录内的备份只能放在 backups 子目录，避免递归复制源对象和日志');
      if (existsSync(target)) {
        assertDirectory(target);
        if (readdirSync(target).length) throw new Error('备份目标不是空目录');
      }
      const surfaces: Surface[] =
        selection === 'all'
          ? [
              'native',
              ...(existsSync(path.join(surfaceDirectory(directory, 'terminal'), 'state.db'))
                ? ['terminal' as const]
                : []),
            ]
          : [selection];
      const stage = mkdtempSync(path.join(directory, '.maintenance-'));
      try {
        const entries: Partial<Record<Surface, SurfaceBackup>> = {};
        for (const surface of surfaces) {
          assertSurfacePath(directory, surface);
          const relative = selection === 'all' && surface === 'terminal' ? 'surfaces/terminal' : '.';
          const prepared = await prepareSurface(
            surfaceDirectory(directory, surface),
            path.join(stage, relative),
          );
          entries[surface] = { path: relative, ...prepared };
        }
        const primary = entries[selection === 'terminal' ? 'terminal' : 'native']!;
        const metadata: BackupMetadata = {
          appVersion: VERSION,
          backupFormatVersion: 1,
          schemaVersion: primary.schemaVersion,
          createdAt: now(),
          includes: primary.includes,
          workspacesRetainedAt: path.join(
            surfaceDirectory(directory, selection === 'terminal' ? 'terminal' : 'native'),
            'workspaces',
          ),
          surface: selection,
          surfaces: entries,
        };
        // Publish metadata last so incomplete copies are never valid restore sources.
        copyDirectory(stage, target);
        writeFileSync(path.join(target, 'backup.json'), stable(metadata));
        console.log('备份完成（' + surfaces.join('、') + '）：' + target);
      } finally {
        removeStage(stage, directory);
      }
    } else if (action === 'restore') {
      const source = path.resolve(argument || '');
      if (!argument || !existsSync(path.join(source, 'backup.json')))
        throw new Error('restore 需要有效备份路径');
      assertDirectory(source);
      const entries = backupSurfaces(source);
      const surfaces = (selection === 'all' ? Object.keys(entries) : [selection]) as Surface[];
      if (surfaces.some((surface) => !entries[surface]))
        throw new Error('备份不包含所选入口，不能将另一入口的数据覆盖至 ' + selection);
      const stage = mkdtempSync(path.join(directory, '.maintenance-'));
      try {
        for (const surface of surfaces) {
          assertSurfacePath(directory, surface);
          const entry = entries[surface]!;
          const surfaceSource = path.join(source, entry.path);
          if (surface === 'terminal' && entry.path !== '.') assertSurfacePath(source, surface);
          await prepareSurface(surfaceSource, surfaceDirectory(stage, surface), entry.schemaVersion, true);
        }
        const archive = installPrepared(directory, stage, surfaces);
        console.log('恢复完成（' + surfaces.join('、') + '）；替换前数据保留：' + archive);
      } finally {
        removeStage(stage, directory);
      }
    } else throw new Error('未知维护操作');
  } finally {
    release();
  }
}
