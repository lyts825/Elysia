import {
  Store,
  acquireLock,
  now,
  stable,
  STORAGE_SCHEMA_VERSION,
  STORAGE_MIN_READER_VERSION,
} from '../../../packages/storage/src/index.js';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  renameSync,
  readdirSync,
  rmSync,
  lstatSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export type Surface = 'native' | 'terminal';
export type Selection = Surface | 'all';
export type DataFormat = { name: 'elysia-sqlite'; version: number; minimumReaderVersion: string };
export type SurfaceBackup = {
  path: string;
  schemaVersion: number;
  dataFormat?: DataFormat;
  includes: string[];
};
export type BackupMetadata = {
  appVersion: string;
  backupFormatVersion: 1;
  schemaVersion: number;
  createdAt: string;
  includes: string[];
  workspacesRetainedAt: string;
  surface: Selection;
  surfaces: Partial<Record<Surface, SurfaceBackup>>;
};
export const fileNames = ['state.db', 'state.db-wal', 'state.db-shm', 'objects', 'logs'];
export const supportedSchema = (version: unknown): version is number =>
  Number.isInteger(version) && Number(version) >= 1 && Number(version) <= STORAGE_SCHEMA_VERSION;
export const dataFormat = (version: number): DataFormat => ({
  name: 'elysia-sqlite',
  version,
  minimumReaderVersion: version === 4 ? STORAGE_MIN_READER_VERSION : '0.24.0-preview.1',
});
export function validateDataFormat(entry: SurfaceBackup, required: boolean) {
  if (!entry.dataFormat) {
    if (required || entry.schemaVersion >= 4) throw new Error('备份缺少数据格式及最低读取版本');
    return;
  }
  const expected = dataFormat(entry.schemaVersion);
  if (
    entry.dataFormat.name !== expected.name ||
    entry.dataFormat.version !== expected.version ||
    entry.dataFormat.minimumReaderVersion !== expected.minimumReaderVersion
  )
    throw new Error('备份数据格式或最低读取版本不相容');
}
export function isWithin(root: string, candidate: string, allowRoot = false) {
  const relative = path.relative(root, candidate);
  return (
    (allowRoot || Boolean(relative)) &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

export function canonicalDestination(destination: string): string {
  if (existsSync(destination)) return realpathSync(destination);
  const parent = path.dirname(destination);
  if (parent === destination) return destination;
  return path.join(canonicalDestination(parent), path.basename(destination));
}

export function surfaceDirectory(root: string, surface: Surface) {
  return surface === 'native' ? root : path.join(root, 'surfaces', 'terminal');
}

export function assertDirectory(directory: string) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('维护目录不能是链接或特殊文件：' + directory);
}

export function assertSurfacePath(root: string, surface: Surface) {
  if (surface === 'terminal') {
    for (const item of [path.join(root, 'surfaces'), surfaceDirectory(root, surface)])
      if (existsSync(item)) assertDirectory(item);
  }
  const file = path.join(surfaceDirectory(root, surface), 'state.db');
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()))
    throw new Error('入口数据库不能是链接或特殊文件');
  const nativeFile = path.join(root, 'state.db'),
    terminalFile = path.join(surfaceDirectory(root, 'terminal'), 'state.db');
  if (existsSync(nativeFile) && existsSync(terminalFile)) {
    const native = statSync(nativeFile, { bigint: true }),
      terminal = statSync(terminalFile, { bigint: true });
    if (native.dev === terminal.dev && native.ino === terminal.ino)
      throw new Error('两个入口不能共用同一个数据库文件');
  }
}

export async function snapshotDatabase(source: string, target: string, expectedVersion?: number) {
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
    if (!supportedSchema(version)) throw new Error('备份 schema 不相容');
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

export function copyDirectory(source: string, target: string) {
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

export async function prepareSurface(
  source: string,
  target: string,
  expectedVersion?: number,
  migrate = false,
) {
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
    schemaVersion = await snapshotDatabase(path.join(target, 'state.db'), standalone, STORAGE_SCHEMA_VERSION);
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm'])
      rmSync(path.join(target, name), { force: true });
    renameSync(standalone, path.join(target, 'state.db'));
  }
  return { schemaVersion, dataFormat: dataFormat(schemaVersion), includes };
}

export function backupSurfaces(source: string): Partial<Record<Surface, SurfaceBackup>> {
  const metadata = JSON.parse(readFileSync(path.join(source, 'backup.json'), 'utf8'));
  if (!supportedSchema(metadata.schemaVersion)) throw new Error('备份 schema 不相容');
  const modern = metadata.backupFormatVersion !== undefined;
  if (
    modern &&
    (metadata.backupFormatVersion !== 1 ||
      typeof metadata.appVersion !== 'string' ||
      !metadata.appVersion.trim())
  )
    throw new Error('备份封装格式或应用版本无效');
  if (!modern && metadata.schemaVersion >= 4) throw new Error('备份缺少封装格式与应用版本');
  // Legacy backups have only the native root. Never infer a terminal backup from its filename.
  if (!modern && metadata.surface === undefined && metadata.surfaces === undefined)
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
      !supportedSchema(entry.schemaVersion) ||
      !Array.isArray(entry.includes) ||
      !entry.includes.includes('state.db') ||
      !entry.includes.includes('objects') ||
      (metadata.surface !== 'all' && name !== metadata.surface)
    )
      throw new Error('备份入口元数据不一致');
    validateDataFormat(entry, modern);
    selected[name as Surface] = entry;
  }
  const primary = metadata.surface === 'terminal' ? selected.terminal : selected.native;
  if (!primary || primary.schemaVersion !== metadata.schemaVersion) throw new Error('备份入口不完整');
  return selected;
}

export function removeStage(stage: string, directory: string) {
  if (
    path.dirname(path.resolve(stage)) !== path.resolve(directory) ||
    !path.basename(stage).startsWith('.maintenance-')
  )
    throw new Error('维护暂存路径越界');
  rmSync(stage, { recursive: true, force: true });
}

type InstallJournal = {
  version: 1;
  phase: 'installing' | 'committed';
  stage: string;
  archive: string;
  surfaces: Surface[];
  originals: Record<string, boolean>;
};
const journalName = '.maintenance-install.json';
function saveJournal(directory: string, journal: InstallJournal) {
  const target = path.join(directory, journalName);
  writeFileSync(target + '.tmp', stable(journal), { mode: 0o600, flush: true });
  renameSync(target + '.tmp', target);
}

// Both startup and maintenance hold these locks through all reads, installation and database use.
export function acquireSurfaceLocks(directory: string) {
  const release = acquireLock(directory);
  let releaseTerminal: (() => void) | undefined;
  try {
    assertDirectory(directory);
    assertSurfacePath(directory, 'native');
    assertSurfacePath(directory, 'terminal');
    releaseTerminal = acquireLock(surfaceDirectory(directory, 'terminal'));
    return () => {
      try {
        releaseTerminal!();
      } finally {
        release();
      }
    };
  } catch (error) {
    releaseTerminal?.();
    release();
    throw error;
  }
}

export function recoverPreparedInstall(directory: string) {
  const filename = path.join(directory, journalName);
  if (!existsSync(filename)) return;
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
    throw new Error('维护恢复记录无效；请保留数据并手动核验');
  const journal = JSON.parse(readFileSync(filename, 'utf8')) as InstallJournal;
  if (
    journal.version !== 1 ||
    !['installing', 'committed'].includes(journal.phase) ||
    !/^\.maintenance-[a-zA-Z0-9_-]+$/.test(journal.stage) ||
    journal.archive !== 'before-restore-' + journal.stage ||
    !Array.isArray(journal.surfaces) ||
    !journal.surfaces.length ||
    journal.surfaces.length > 2 ||
    new Set(journal.surfaces).size !== journal.surfaces.length ||
    journal.surfaces.some((surface) => !['native', 'terminal'].includes(surface)) ||
    !journal.originals ||
    typeof journal.originals !== 'object'
  )
    throw new Error('维护恢复路径或入口无效');
  const archive = path.join(directory, 'backups', journal.archive);
  assertDirectory(path.join(directory, 'backups'));
  assertDirectory(archive);
  for (const surface of journal.surfaces) {
    assertSurfacePath(directory, surface);
    assertSurfacePath(archive, surface);
    for (const name of fileNames)
      if (typeof journal.originals[surface + '/' + name] !== 'boolean')
        throw new Error('维护恢复原始清单不完整');
  }
  if (journal.phase === 'installing') {
    for (const surface of journal.surfaces) {
      for (const name of fileNames) {
        const destination = path.join(surfaceDirectory(directory, surface), name);
        const original = path.join(surfaceDirectory(archive, surface), name);
        if (existsSync(destination) && lstatSync(destination).isSymbolicLink())
          throw new Error('维护恢复目标不能是链接');
        if (existsSync(original)) {
          if (lstatSync(original).isSymbolicLink()) throw new Error('维护恢复原件不能是链接');
          rmSync(destination, { recursive: true, force: true });
          renameSync(original, destination);
        } else if (!journal.originals[surface + '/' + name])
          rmSync(destination, { recursive: true, force: true });
      }
    }
  }
  rmSync(filename);
  const stage = path.join(directory, journal.stage);
  if (existsSync(stage)) removeStage(stage, directory);
}

export function installPrepared(directory: string, stage: string, surfaces: Surface[]) {
  if (path.dirname(stage) !== directory || !/^\.maintenance-[a-zA-Z0-9_-]+$/.test(path.basename(stage)))
    throw new Error('维护安装暂存路径越界');
  if (existsSync(path.join(directory, journalName))) throw new Error('有尚未恢复的维护操作');
  const backupsDirectory = path.join(directory, 'backups');
  if (existsSync(backupsDirectory)) assertDirectory(backupsDirectory);
  const archive = path.join(backupsDirectory, 'before-restore-' + path.basename(stage));
  const originals: Record<string, boolean> = {};
  for (const surface of surfaces) {
    assertSurfacePath(directory, surface);
    for (const name of fileNames) {
      const file = path.join(surfaceDirectory(directory, surface), name);
      originals[surface + '/' + name] = existsSync(file);
      if (existsSync(file) && lstatSync(file).isSymbolicLink())
        throw new Error('当前数据不能是链接：' + file);
    }
  }
  mkdirSync(archive, { recursive: true });
  const journal: InstallJournal = {
    version: 1,
    phase: 'installing',
    stage: path.basename(stage),
    archive: path.basename(archive),
    surfaces,
    originals,
  };
  saveJournal(directory, journal);
  try {
    for (const surface of surfaces) {
      const destination = surfaceDirectory(directory, surface);
      const archived = surfaceDirectory(archive, surface);
      mkdirSync(destination, { recursive: true });
      mkdirSync(archived, { recursive: true });
      for (const name of fileNames)
        if (originals[surface + '/' + name])
          renameSync(path.join(destination, name), path.join(archived, name));
    }
    for (const surface of surfaces) {
      const prepared = surfaceDirectory(stage, surface);
      const destination = surfaceDirectory(directory, surface);
      for (const name of ['state.db', 'objects', 'logs'])
        if (existsSync(path.join(prepared, name)))
          renameSync(path.join(prepared, name), path.join(destination, name));
    }
    writeFileSync(path.join(archive, 'archive.json'), stable({ createdAt: now(), surfaces }), {
      flush: true,
    });
    saveJournal(directory, { ...journal, phase: 'committed' });
    rmSync(path.join(directory, journalName));
    return archive;
  } catch (error) {
    try {
      recoverPreparedInstall(directory);
    } catch (rollbackError) {
      throw new Error('恢复及回滚失败；下次启动将重试，原数据保留于 ' + archive, { cause: rollbackError });
    }
    throw error;
  }
}
