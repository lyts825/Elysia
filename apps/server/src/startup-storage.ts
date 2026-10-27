/** 启动时检查存储版本、准备升级并打开存储。 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, id, now, stable, STORAGE_SCHEMA_VERSION } from '../../../packages/storage/src/index.js';
import { VERSION } from '../../../packages/contracts/src/index.js';
import {
  type Surface,
  type SurfaceBackup,
  type BackupMetadata,
  acquireSurfaceLocks,
  assertDirectory,
  assertSurfacePath,
  surfaceDirectory,
  prepareSurface,
  removeStage,
  installPrepared,
  recoverPreparedInstall,
} from './maintenance-storage.js';

/** 只读探测已存在数据库的 schema；缺失允许创建，未知高版本不能尝试降级打开。 */
function schema(directory: string) {
  const file = path.join(directory, 'state.db');
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('启动数据库不能是链接或特殊文件');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = Number((db.prepare('PRAGMA user_version').get() as any).user_version);
    if (!Number.isInteger(version) || version < 1 || version > STORAGE_SCHEMA_VERSION)
      throw new Error('启动数据库 schema 不相容：' + version);
    return version;
  } finally {
    db.close();
  }
}

// Called with both service locks held; snapshots remain readable by the pre-upgrade application.
/**
 * 调用方持有两个入口锁时运行：先恢复中断安装，再备份所有已有入口并在独立目录升级。
 * 备份清单最后发布，使旧版本仍可读取升级前快照；任一入口准备失败都不替换当前数据。
 */
export async function prepareStartupUpgrade(directory: string, surfaces: Surface[] = ['native', 'terminal']) {
  recoverPreparedInstall(directory);
  const versions = surfaces.map((surface) => {
    assertSurfacePath(directory, surface);
    return schema(surfaceDirectory(directory, surface));
  });
  if (versions.every((version) => version === STORAGE_SCHEMA_VERSION)) return undefined;
  const existing = surfaces.filter((_, index) => versions[index] !== undefined);
  let backupDirectory: string | undefined;
  if (existing.length) {
    const backups = path.join(directory, 'backups');
    if (existsSync(backups)) assertDirectory(backups);
    else mkdirSync(backups);
    backupDirectory = path.join(backups, 'before-upgrade-' + now().replace(/[:.]/g, '-') + '-' + id());
    mkdirSync(backupDirectory);
    const entries: Partial<Record<Surface, SurfaceBackup>> = {};
    const selection = existing.includes('native') ? 'all' : 'terminal';
    // Publish backup.json only after both snapshots and object/log copies validate.
    for (const surface of existing) {
      const relative = selection === 'all' && surface === 'terminal' ? 'surfaces/terminal' : '.';
      const prepared = await prepareSurface(
        surfaceDirectory(directory, surface),
        path.join(backupDirectory, relative),
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
      workspacesRetainedAt: path.join(directory, 'workspaces'),
      surface: selection,
      surfaces: entries,
    };
    writeFileSync(path.join(backupDirectory, 'backup.json'), stable(metadata), { mode: 0o600, flush: true });
  }
  const stage = mkdtempSync(path.join(directory, '.maintenance-'));
  try {
    for (let index = 0; index < surfaces.length; index++) {
      const surface = surfaces[index],
        target = surfaceDirectory(stage, surface);
      if (versions[index] === undefined) {
        const empty = new Store(target);
        empty.close();
      } else {
        const metadata = JSON.parse(
          readFileSync(path.join(backupDirectory!, 'backup.json'), 'utf8'),
        ) as BackupMetadata;
        await prepareSurface(
          path.join(backupDirectory!, metadata.surfaces[surface]!.path),
          target,
          versions[index],
          true,
        );
      }
    }
    installPrepared(directory, stage, surfaces);
    return backupDirectory;
  } finally {
    // A failed rollback must retain its prepared files for recovery.
    if (!existsSync(path.join(directory, '.maintenance-install.json')) && existsSync(stage))
      removeStage(stage, directory);
  }
}

/**
 * 获取双方入口锁，完成升级后才打开 Store。成功返回 release 给服务全生命周期持有；
 * 中途失败按终端→原生→锁的顺序尽力释放，防止下次启动被半开的资源阻挡。
 */
export async function openStartupStores(configuredDirectory: string) {
  const release = acquireSurfaceLocks(configuredDirectory);
  let native: Store | undefined, terminal: Store | undefined;
  try {
    const directory = realpathSync(configuredDirectory);
    const backup = await prepareStartupUpgrade(directory);
    native = new Store(directory);
    terminal = new Store(surfaceDirectory(directory, 'terminal'));
    return { native, terminal, release, backup };
  } catch (error) {
    try {
      terminal?.close();
    } finally {
      try {
        native?.close();
      } finally {
        release();
      }
    }
    throw error;
  }
}
