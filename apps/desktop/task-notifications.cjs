// 为桌面窗口管理任务通知及其生命周期。
const { Notification } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readBounded } = require('./startup.cjs');
const bodies = {
  DONE: '任务已完成。打开工作台查看结果。',
  WAITING: '任务正在等待确认。打开工作台继续。',
  FAILED: '任务执行失败。打开工作台查看处理方式。',
  UNCERTAIN: '任务状态需要核对。打开工作台查看详情。',
};

function createTaskNotifications(window, directory) {
  const parent = path.join(directory, 'desktop'),
    file = path.join(parent, 'task-notifications.json');
  let reading,
    writing = Promise.resolve();
  const seen = new Map(),
    active = new Set();
  const supported = () => Notification.isSupported();
  const normalize = (value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.native !== 'boolean' ||
      typeof value.terminal !== 'boolean'
    )
      throw new Error('通知偏好无效');
    return { native: value.native, terminal: value.terminal };
  };
  const read = () =>
    (reading ||= (async () => {
      try {
        return normalize(JSON.parse((await readBounded(file, 8192)).toString('utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('无法读取通知偏好，通知未启用。');
        return { native: false, terminal: false };
      }
    })());
  const result = async () => ({ ...(await read()), available: supported() });
  return {
    read: result,
    set(value) {
      if (!value || !['native', 'terminal'].includes(value.surface) || typeof value.enabled !== 'boolean')
        throw new Error('通知偏好无效');
      if (value.enabled && !supported()) throw new Error('当前系统不支持桌面通知');
      const job = writing
        .catch(() => {})
        .then(async () => {
          const prefs = { ...(await read()), [value.surface]: value.enabled };
          await fs.mkdir(parent, { recursive: true });
          const stat = await fs.lstat(parent);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('通知偏好目录无效');
          const temporary = path.join(parent, `notifications-${randomUUID()}.tmp`);
          try {
            await fs.writeFile(temporary, JSON.stringify(prefs), { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, file);
          } finally {
            await fs.unlink(temporary).catch(() => {});
          }
          reading = Promise.resolve(prefs);
          // A newly enabled entry establishes its own observer baseline in the workbench.
          for (const key of seen.keys()) if (key.startsWith(value.surface + ':')) seen.delete(key);
          return result();
        });
      writing = job;
      return job;
    },
    async notify(value) {
      if (
        !value ||
        !['native', 'terminal'].includes(value.surface) ||
        typeof value.taskId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.taskId) ||
        !Object.hasOwn(bodies, value.status) ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0
      )
        throw new Error('任务通知无效');
      const prefs = await read();
      if (!prefs[value.surface] || !supported()) return false;
      const key = value.surface + ':' + value.taskId,
        previous = seen.get(key);
      // A later revision can re-enter the same status after an intervening transition.
      if (previous && value.revision <= previous.revision) return false;
      const notice = new Notification({
        title: value.surface === 'terminal' ? 'Elysia · Agent 终端' : 'Elysia',
        body: bodies[value.status],
        silent: true,
      });
      notice.on('click', () => {
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (!window.webContents.isDestroyed())
          window.webContents.send('elysia:notification-open', {
            surface: value.surface,
            taskId: value.taskId,
          });
      });
      notice.on('close', () => active.delete(notice));
      try {
        notice.show();
      } catch {
        throw new Error('系统未能显示通知，请检查系统通知设置');
      }
      seen.delete(key);
      seen.set(key, { revision: value.revision });
      while (seen.size > 256) seen.delete(seen.keys().next().value);
      active.add(notice);
      while (active.size > 8) {
        const first = active.values().next().value;
        active.delete(first);
        first.close();
      }
      return true;
    },
  };
}
module.exports = { createTaskNotifications };
