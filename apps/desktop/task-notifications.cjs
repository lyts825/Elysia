/**
 * 为桌面窗口管理任务通知及其生命周期。
 * EN: Manage desktop task notifications and their lifecycle for one window.
 *
 * 将任务状态转换为桌面通知并协调点击定位；通知数量与去重记录有界，点击时核对窗口是否仍存在。
 * EN: Translate task states into desktop notifications and click navigation. Bound active notifications and deduplication history, and check window existence on clicks.
 */
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

/**
 * 按原生和终端入口分别保存通知偏好，并按任务版本去重。
 * 通知只包含固定状态文案；点击后聚焦窗口并发送任务定位信息。
 * EN: Persist notification preferences separately for native and terminal surfaces and deduplicate
 * by task revision. Notifications contain fixed status text; clicking focuses the window and sends
 * task navigation identifiers.
 */
function createTaskNotifications(window, directory) {
  const parent = path.join(directory, 'desktop'),
    file = path.join(parent, 'task-notifications.json');
  let reading,
    writing = Promise.resolve();
  const seen = new Map(),
    active = new Set();
  /**
   * 实时查询Electron是否支持系统通知，避免仅依据保存开关推断可用。
   * EN: Query Electron notification support rather than inferring availability from a saved toggle.
   */
  const supported = () => Notification.isSupported();
  /**
   * 校验两个入口的布尔通知偏好，返回最小公开配置。
   * EN: Validate boolean preferences for both surfaces and return their minimal public form.
   */
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
  /**
   * 共享偏好读取并严格区分文件缺失与损坏，缺失时默认不启用通知。
   * EN: Share preference loading; default notifications off only for a missing file, not corrupt data.
   */
  const read = () =>
    (reading ||= (async () => {
      try {
        return normalize(JSON.parse((await readBounded(file, 8192)).toString('utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('无法读取通知偏好，通知未启用。');
        return { native: false, terminal: false };
      }
    })());
  /**
   * 把已读入口偏好与当前系统支持状态组合返回。
   * EN: Combine loaded surface preferences with current system notification availability.
   */
  const result = async () => ({ ...(await read()), available: supported() });
  return {
    read: result,
    /**
     * 串行保存单个入口的开关；启用时要求系统支持桌面通知。
     * EN: Serialize updates to one surface preference and require operating-system notification support
     * when enabling it.
     */
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
          // 新启用的入口会在工作台中建立自己的通知观察基线。
          // EN: A newly enabled surface establishes its own notification observer baseline in the workbench.
          for (const key of seen.keys()) if (key.startsWith(value.surface + ':')) seen.delete(key);
          return result();
        });
      writing = job;
      return job;
    },
    /**
     * 仅对已启用入口的新版本状态发送通知，并限制去重记录与活动通知数量。
     * EN: Send notifications only for newer revisions on enabled surfaces; bound both deduplication
     * history and active notifications.
     */
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
      // 经过中间状态变化后，更高版本可以再次进入同一状态，不能只按状态名去重。
      // EN: A later revision may re-enter the same status after an intervening transition, so status text
      // alone is not a deduplication key.
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
