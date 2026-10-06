import { Store, acquireLock, dataDirectory, now, stable } from '../../../packages/storage/src/index.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
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
      console.log('schema v1 迁移完成：' + directory);
    } else if (action === 'backup') {
      const target = path.resolve(
        process.argv[3] || path.join(directory, 'backups', now().replace(/[:.]/g, '-')),
      );
      if (target === directory || directory.startsWith(target + path.sep))
        throw new Error('备份目标不能覆盖数据目录或其祖先');
      if (existsSync(target) && readdirSync(target).length) throw new Error('备份目标不是空目录');
      const store = new Store(directory);
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      store.close();
      mkdirSync(target, { recursive: true });
      cpSync(path.join(directory, 'state.db'), path.join(target, 'state.db'));
      cpSync(path.join(directory, 'objects'), path.join(target, 'objects'), { recursive: true });
      writeFileSync(
        path.join(target, 'backup.json'),
        stable({
          schemaVersion: 1,
          createdAt: now(),
          includes: ['state.db', 'objects'],
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
      if (metadata.schemaVersion !== 1) throw new Error('备份 schema 不相容');
      const archive = path.join(directory, 'backups', 'before-restore-' + now().replace(/[:.]/g, '-'));
      mkdirSync(archive, { recursive: true });
      for (const name of ['state.db', 'state.db-wal', 'state.db-shm', 'objects'])
        if (existsSync(path.join(directory, name)))
          renameSync(path.join(directory, name), path.join(archive, name));
      cpSync(path.join(source, 'state.db'), path.join(directory, 'state.db'));
      cpSync(path.join(source, 'objects'), path.join(directory, 'objects'), { recursive: true });
      const store = new Store(directory);
      const integrity = store.db.prepare('PRAGMA integrity_check').get() as any;
      store.close();
      if (integrity.integrity_check !== 'ok')
        throw new Error('恢复数据库完整性检查失败；原数据保留在 ' + archive);
      console.log('恢复完成；替换前数据保留：' + archive);
    } else throw new Error('未知维护操作');
  } finally {
    release();
  }
}
