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
} from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

async function snapshotDatabase(source: string, target: string, expectedVersion?: number) {
  // Snapshot the logical database, including committed WAL pages, without changing its source.
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
  // Validate the closed, standalone file that will actually be copied into place.
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

function removeStage(stage: string, directory: string) {
  if (
    path.dirname(path.resolve(stage)) !== path.resolve(directory) ||
    !path.basename(stage).startsWith('.maintenance-')
  )
    throw new Error('维护暂存路径越界');
  rmSync(stage, { recursive: true, force: true });
}
const action = process.argv[2],
  directory = dataDirectory();
if (action === 'stop') {
  if (!existsSync(path.join(directory, 'service.lock'))) throw new Error('未找到正在运行的 Elysia 服务');
  const lock = JSON.parse(readFileSync(path.join(directory, 'service.lock'), 'utf8'));
  try {
    process.kill(lock.pid, 0);
  } catch {
    throw new Error('服务锁已过期，请先核验进程');
  }
  writeFileSync(path.join(directory, 'stop.request'), stable({ requestedAt: now(), token: lock.token }));
  console.log('已请求服务在安全边界停止');
} else {
  const release = acquireLock(directory);
  try {
    if (action === 'migrate') {
      const store = new Store(directory);
      store.close();
      console.log('schema v3 迁移完成（SQLite 压缩会话存储）：' + directory);
    } else if (action === 'backup') {
      const target = path.resolve(
        process.argv[3] || path.join(directory, 'backups', now().replace(/[:.]/g, '-')),
      );
      if (target === directory || directory.startsWith(target + path.sep))
        throw new Error('备份目标不能覆盖数据目录或其祖先');
      if (
        target.startsWith(directory + path.sep) &&
        !target.startsWith(path.join(directory, 'backups') + path.sep)
      )
        throw new Error('数据目录内的备份只能放在 backups 子目录，避免递归复制源对象和日志');
      if (existsSync(target) && readdirSync(target).length) throw new Error('备份目标不是空目录');
      let schemaVersion: number;
      const stage = mkdtempSync(path.join(directory, '.maintenance-'));
      try {
        // Preserve the pre-upgrade schema; do not open the source through Store.
        schemaVersion = await snapshotDatabase(
          path.join(directory, 'state.db'),
          path.join(stage, 'state.db'),
        );
        mkdirSync(target, { recursive: true });
        cpSync(path.join(stage, 'state.db'), path.join(target, 'state.db'));
      } finally {
        removeStage(stage, directory);
      }
      cpSync(path.join(directory, 'objects'), path.join(target, 'objects'), { recursive: true });
      const includes = ['state.db', 'objects'];
      if (existsSync(path.join(directory, 'logs'))) {
        cpSync(path.join(directory, 'logs'), path.join(target, 'logs'), { recursive: true });
        includes.push('logs');
      }
      writeFileSync(
        path.join(target, 'backup.json'),
        stable({
          schemaVersion,
          createdAt: now(),
          includes,
          workspacesRetainedAt: path.join(directory, 'workspaces'),
        }),
      );
      console.log('备份完成：' + target);
    } else if (action === 'restore') {
      const source = path.resolve(process.argv[3] || '');
      if (
        !process.argv[3] ||
        !existsSync(path.join(source, 'backup.json')) ||
        !existsSync(path.join(source, 'state.db'))
      )
        throw new Error('restore 需要有效备份路径');
      const metadata = JSON.parse(readFileSync(path.join(source, 'backup.json'), 'utf8'));
      if (![1, 2, 3].includes(metadata.schemaVersion)) throw new Error('备份 schema 不相容');
      const stage = mkdtempSync(path.join(directory, '.maintenance-'));
      try {
        await snapshotDatabase(
          path.join(source, 'state.db'),
          path.join(stage, 'state.db'),
          metadata.schemaVersion,
        );
        cpSync(path.join(source, 'objects'), path.join(stage, 'objects'), { recursive: true });
        if (existsSync(path.join(source, 'logs')))
          cpSync(path.join(source, 'logs'), path.join(stage, 'logs'), { recursive: true });
        const archive = path.join(directory, 'backups', 'before-restore-' + now().replace(/[:.]/g, '-'));
        mkdirSync(archive, { recursive: true });
        for (const name of ['state.db', 'state.db-wal', 'state.db-shm', 'objects', 'logs']) {
          const from = path.resolve(directory, name),
            to = path.resolve(archive, name);
          if (
            !from.startsWith(path.resolve(directory) + path.sep) ||
            !to.startsWith(path.resolve(archive) + path.sep)
          )
            throw new Error('恢复归档路径越界');
          if (existsSync(from)) renameSync(from, to);
        }
        cpSync(path.join(stage, 'state.db'), path.join(directory, 'state.db'));
        cpSync(path.join(stage, 'objects'), path.join(directory, 'objects'), { recursive: true });
        if (existsSync(path.join(stage, 'logs')))
          cpSync(path.join(stage, 'logs'), path.join(directory, 'logs'), { recursive: true });
        const store = new Store(directory);
        let integrity: any[];
        try {
          integrity = store.db.prepare('PRAGMA integrity_check').all() as any[];
        } finally {
          store.close();
        }
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
          throw new Error('恢复数据库完整性检查失败；原数据保留在 ' + archive);
        console.log('恢复完成；替换前数据保留：' + archive);
      } finally {
        removeStage(stage, directory);
      }
    } else throw new Error('未知维护操作');
  } finally {
    release();
  }
}
