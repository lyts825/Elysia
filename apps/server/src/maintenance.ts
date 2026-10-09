import { Store, acquireLock, dataDirectory, now, stable } from '../../../packages/storage/src/index.js';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  renameSync,
  readdirSync,
  rmSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

type Surface = 'native' | 'terminal';
type Selection = Surface | 'all';
type SurfaceBackup = { path: string; schemaVersion: number; includes: string[] };
type BackupMetadata = {
  schemaVersion: number;
  createdAt: string;
  includes: string[];
  workspacesRetainedAt: string;
  surface: Selection;
  surfaces: Partial<Record<Surface, SurfaceBackup>>;
};
const fileNames = ['state.db', 'state.db-wal', 'state.db-shm', 'objects', 'logs'];
const action = process.argv[2];
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
if (argument && !['backup', 'restore'].includes(action)) throw new Error('此维护操作不接受路径参数');

function isWithin(root: string, candidate: string, allowRoot = false) {
  const relative = path.relative(root, candidate);
  return (
    (allowRoot || Boolean(relative)) &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function canonicalDestination(destination: string): string {
  if (existsSync(destination)) return realpathSync(destination);
  const parent = path.dirname(destination);
  if (parent === destination) return destination;
  return path.join(canonicalDestination(parent), path.basename(destination));
}

function surfaceDirectory(root: string, surface: Surface) {
  return surface === 'native' ? root : path.join(root, 'surfaces', 'terminal');
}

function assertDirectory(directory: string) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('维护目录不能是链接或特殊文件：' + directory);
}

function assertSurfacePath(root: string, surface: Surface) {
  if (surface === 'native') return;
  for (const item of [path.join(root, 'surfaces'), surfaceDirectory(root, surface)])
    if (existsSync(item)) assertDirectory(item);
}

async function snapshotDatabase(source: string, target: string, expectedVersion?: number) {
  if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink())
    throw new Error('数据库不能是链接或特殊文件');
  // SQLite backup includes committed WAL pages without upgrading or changing its source.
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, target);
  } finally {
    database.close();
  }
  const snapshot = new DatabaseSync(target);
  try {
    const mode = snapshot.prepare('PRAGMA journal_mode=DELETE').get() as any;
    if (mode.journal_mode !== 'delete') throw new Error('无法生成独立备份数据库');
  } finally {
    snapshot.close();
  }
  const validation = new DatabaseSync(target, { readOnly: true });
  try {
    const version = Number((validation.prepare('PRAGMA user_version').get() as any).user_version);
    if (![1, 2, 3].includes(version)) throw new Error('备份 schema 不相容');
    if (expectedVersion !== undefined && version !== expectedVersion)
      throw new Error('备份版本与元数据不一致');
    const integrity = validation.prepare('PRAGMA integrity_check').all() as any[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
      throw new Error('备份数据库完整性检查失败');
    return version;
  } finally {
    validation.close();
  }
}

function copyDirectory(source: string, target: string) {
  assertDirectory(source);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('备份对象和日志不能包含链接：' + from);
    if (stat.isDirectory()) copyDirectory(from, to);
    else if (stat.isFile()) {
      const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
      const before = digest(from);
      cpSync(from, to);
      if (digest(to) !== before || digest(from) !== before) throw new Error('备份文件发生变化：' + from);
    } else throw new Error('备份对象和日志不能包含特殊文件：' + from);
  }
}

async function prepareSurface(source: string, target: string, expectedVersion?: number, migrate = false) {
  assertDirectory(source);
  mkdirSync(target, { recursive: true });
  let schemaVersion = await snapshotDatabase(
    path.join(source, 'state.db'),
    path.join(target, 'state.db'),
    expectedVersion,
  );
  copyDirectory(path.join(source, 'objects'), path.join(target, 'objects'));
  const includes = ['state.db', 'objects'];
  if (existsSync(path.join(source, 'logs'))) {
    copyDirectory(path.join(source, 'logs'), path.join(target, 'logs'));
    includes.push('logs');
  }
  if (migrate) {
    // Migrate and validate only the prepared copy; a bad second surface cannot alter the first.
    const store = new Store(target);
    try {
      const integrity = store.db.prepare('PRAGMA integrity_check').all() as any[];
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
        throw new Error('恢复数据库完整性检查失败');
    } finally {
      store.close();
    }
    const standalone = path.join(target, 'prepared.db');
    schemaVersion = await snapshotDatabase(path.join(target, 'state.db'), standalone, 3);
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm'])
      rmSync(path.join(target, name), { force: true });
    renameSync(standalone, path.join(target, 'state.db'));
  }
  return { schemaVersion, includes };
}

function backupSurfaces(source: string): Partial<Record<Surface, SurfaceBackup>> {
  const metadata = JSON.parse(readFileSync(path.join(source, 'backup.json'), 'utf8'));
  if (![1, 2, 3].includes(metadata.schemaVersion)) throw new Error('备份 schema 不相容');
  // Legacy backups have only the native root. Never infer a terminal backup from its filename.
  if (metadata.surface === undefined && metadata.surfaces === undefined)
    return { native: { path: '.', schemaVersion: metadata.schemaVersion, includes: metadata.includes } };
  if (!['native', 'terminal', 'all'].includes(metadata.surface) || !metadata.surfaces)
    throw new Error('备份入口元数据无效');
  const selected: Partial<Record<Surface, SurfaceBackup>> = {};
  for (const [name, value] of Object.entries(metadata.surfaces)) {
    if (!['native', 'terminal'].includes(name)) throw new Error('备份包含未知入口');
    const entry = value as SurfaceBackup;
    const expectedPath = metadata.surface === 'all' && name === 'terminal' ? 'surfaces/terminal' : '.';
    if (
      !entry ||
      entry.path !== expectedPath ||
      ![1, 2, 3].includes(entry.schemaVersion) ||
      !Array.isArray(entry.includes) ||
      !entry.includes.includes('state.db') ||
      !entry.includes.includes('objects') ||
      (metadata.surface !== 'all' && name !== metadata.surface)
    )
      throw new Error('备份入口元数据不一致');
    selected[name as Surface] = entry;
  }
  const primary = metadata.surface === 'terminal' ? selected.terminal : selected.native;
  if (!primary || primary.schemaVersion !== metadata.schemaVersion) throw new Error('备份入口不完整');
  return selected;
}

function removeStage(stage: string, directory: string) {
  if (
    path.dirname(path.resolve(stage)) !== path.resolve(directory) ||
    !path.basename(stage).startsWith('.maintenance-')
  )
    throw new Error('维护暂存路径越界');
  rmSync(stage, { recursive: true, force: true });
}

function installPrepared(directory: string, stage: string, surfaces: Surface[]) {
  const backupsDirectory = path.join(directory, 'backups');
  if (existsSync(backupsDirectory)) assertDirectory(backupsDirectory);
  const archive = path.join(directory, 'backups', 'before-restore-' + path.basename(stage));
  const moved: { from: string; to: string }[] = [];
  const installed: string[] = [];
  mkdirSync(archive, { recursive: true });
  try {
    for (const surface of surfaces) {
      assertSurfacePath(directory, surface);
      const destination = surfaceDirectory(directory, surface);
      const archived = surfaceDirectory(archive, surface);
      mkdirSync(destination, { recursive: true });
      mkdirSync(archived, { recursive: true });
      for (const name of fileNames) {
        const from = path.join(destination, name);
        const to = path.join(archived, name);
        if (!isWithin(directory, from) || !isWithin(archive, to)) throw new Error('恢复归档路径越界');
        if (existsSync(from)) {
          if (lstatSync(from).isSymbolicLink()) throw new Error('当前数据不能是链接：' + from);
          renameSync(from, to);
          moved.push({ from, to });
        }
      }
    }
    for (const surface of surfaces) {
      const prepared = surfaceDirectory(stage, surface);
      const destination = surfaceDirectory(directory, surface);
      for (const name of ['state.db', 'objects', 'logs']) {
        const from = path.join(prepared, name);
        const to = path.join(destination, name);
        if (existsSync(from)) {
          renameSync(from, to);
          installed.push(to);
        }
      }
    }
    writeFileSync(path.join(archive, 'archive.json'), stable({ createdAt: now(), surfaces }));
    return archive;
  } catch (error) {
    try {
      for (const installedPath of installed.reverse()) {
        if (!isWithin(directory, installedPath)) throw new Error('恢复回滚路径越界');
        rmSync(installedPath, { recursive: true, force: true });
      }
      for (const item of moved.reverse()) renameSync(item.to, item.from);
    } catch (rollbackError) {
      throw new Error('恢复及回滚失败；原数据保留于 ' + archive, { cause: rollbackError });
    }
    throw error;
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
  // One process owns both surfaces, so all maintenance shares the root service lock.
  const release = acquireLock(configuredDirectory);
  const directory = realpathSync(configuredDirectory);
  try {
    if (action === 'migrate') {
      const surfaces: Surface[] =
        selection === 'all'
          ? [
              'native',
              ...(existsSync(path.join(surfaceDirectory(directory, 'terminal'), 'state.db'))
                ? ['terminal' as const]
                : []),
            ]
          : [selection];
      for (const surface of surfaces) {
        assertSurfacePath(directory, surface);
        const store = new Store(surfaceDirectory(directory, surface));
        store.close();
      }
      console.log('schema v3 迁移完成（' + surfaces.join('、') + '）：' + directory);
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
