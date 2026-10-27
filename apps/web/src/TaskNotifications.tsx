/**
 * 处理任务通知及通知状态。
 *
 * EN: Observes task notifications and their delivery health.
 *
 * 本模块管理入口级通知偏好、窗口内健康计数及变更轮询，并通过发件箱核验后调用桌面桥；首次观察建立基线，系统投递和持久通知队列能力由桥及发件箱承担。
 * EN: Owns per-surface preferences, window-local health counters, and change polling, delegating verification/delivery to the outbox and desktop bridge. Initial observation seeds a baseline; the bridge/outbox own delivery and queue behavior.
 */
import { useEffect, useState } from 'react';
import type { SurfaceClient } from './api';
import type { TaskCenterChanges, TaskCenterItem } from '../../../packages/contracts/src/task-center';
import { NotificationOutbox, type NotificationHealth } from './NotificationOutbox';

type Surface = 'native' | 'terminal';
/**
 * 通知健康计数按入口和工作台作用域隔离，作用域未就绪时使用独立的 pending 键。
 *
 * EN: Health counters are isolated by surface and workbench scope; pending scope has a separate key.
 */
function healthKey(client: SurfaceClient) {
  return client.surfaceStorageKey('elysia.notification.health.v1:' + (client.workbenchScope() || 'pending'));
}
/**
 * 从当前窗口缓存恢复有界计数；该缓存只供提示，不能作为历史通知已成功投递的证明。
 *
 * EN: Restores bounded window-local counters for guidance, not proof that past notifications were delivered.
 */
export function readNotificationHealth(client: SurfaceClient): NotificationHealth {
  /**
   * 只恢复数量和失败时间，不持久化任务正文；损坏缓存回退到空状态。
   *
   * EN: Persists counts/failure times only, never task bodies; corrupt cache falls back to empty health.
   */
  try {
    const raw = sessionStorage.getItem(healthKey(client));
    if (!raw || raw.length > 512) return { pending: 0, failed: 0 };
    const value = JSON.parse(raw);
    if (Number.isInteger(value.failed) && value.failed >= 0 && value.failed <= 999)
      return {
        pending:
          Number.isInteger(value.pending) && value.pending >= 0 && value.pending <= 40 ? value.pending : 0,
        failed: value.failed,
        ...(Number.isFinite(value.lastFailureAt) ? { lastFailureAt: value.lastFailureAt } : {}),
      };
  } catch {}
  return { pending: 0, failed: 0 };
}
/**
 * 尽力写窗口缓存并广播入口内健康变化；存储不可用时仍可通过内存事件更新面板。
 *
 * EN: Best-effort saves window cache and broadcasts surface health; in-memory updates still work if storage fails.
 */
function publishHealth(client: SurfaceClient, health: NotificationHealth) {
  try {
    sessionStorage.setItem(healthKey(client), JSON.stringify(health));
  } catch {}
  window.dispatchEvent(
    new CustomEvent('elysia.task-notification-error', { detail: { surface: client.surface, health } }),
  );
}
/**
 * 清除已读失败计数并通知活动发件箱同步；待处理队列和任务原文保持各自状态。
 *
 * EN: Dismisses failure counts and synchronizes the active outbox without changing pending delivery/task contents.
 */
export function dismissTaskNotificationFailures(client: SurfaceClient) {
  publishHealth(client, { ...readNotificationHealth(client), failed: 0 });
  window.dispatchEvent(
    new CustomEvent('elysia.task-notification-dismiss', { detail: { surface: client.surface } }),
  );
}
/**
 * 从桌面桥读取某入口偏好及系统可用性；普通浏览器返回两个 false。
 *
 * EN: Reads per-surface preference and system availability from the desktop bridge; ordinary browsers get false for both.
 */
export async function readTaskNotificationSettings(surface: Surface) {
  /**
   * 桌面通知桥不可用时明确报告不可用，普通浏览器不会假定通知已开启。
   *
   * EN: An absent desktop bridge reports unavailable; browsers never assume notifications are enabled.
   */
  const settings = await window.elysia?.readTaskNotifications?.();
  return { enabled: settings?.[surface] === true, available: settings?.available === true };
}
/**
 * 只有系统可用且用户显式启用时，通知观察器才可开始工作。
 *
 * EN: Observation starts only when the system is available and the user explicitly enabled it.
 */
export async function readTaskNotificationPreference(surface: Surface) {
  const settings = await readTaskNotificationSettings(surface);
  return settings.available && settings.enabled;
}
/**
 * 等待桌面偏好保存成功后广播设置变化；无法调用桌面桥时明确失败，不假设已保存。
 *
 * EN: Broadcasts preference changes only after desktop save succeeds; an unavailable bridge fails explicitly.
 */
export async function setTaskNotificationPreference(surface: Surface, enabled: boolean) {
  if (!window.elysia?.setTaskNotifications) throw Error('桌面通知不可用');
  const preferences = await window.elysia.setTaskNotifications({ surface, enabled });
  window.dispatchEvent(new CustomEvent('elysia.task-notification-settings', { detail: { surface } }));
  return preferences[surface] === true;
}
/**
 * 独立于工作台 Activity 的通知观察器，显式启用的隐藏入口也能报告新状态。
 * 首次读取和游标重置仅建立基线，不回放历史；后续变化先入队，投递前重新核验当前任务。
 * 读取失败从最后成功游标重连，关闭偏好或卸载会取消读取并停止发件箱。
 *
 * EN: Observes independently from workbench Activity, including explicitly enabled hidden surfaces. Initial/reset reads seed a baseline without historical replay. Later changes queue and reverify before delivery. Failed reads reconnect from the last successful cursor; disabling/unmounting cancels reads and stops the outbox.
 */
export function TaskNotifications({ client, ready }: { client: SurfaceClient; ready: boolean }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    let generation = 0;
    /**
     * 发起偏好读取并递增代次；只接受最新且仍挂载的结果，读取失败时关闭本地观察状态。
     * EN: Reads preferences with a new generation; only the newest mounted result applies, and failure disables local observation.
     */
    const read = () =>
      void (() => {
        /**
         * 设置读取可能重叠，generation 保证迟到的旧偏好不能重新启用已关闭的入口。
         *
         * EN: generation prevents overlapping preference reads from letting a late old result re-enable a disabled surface.
         */
        const current = ++generation;
        return readTaskNotificationPreference(client.surface)
          .then((value) => {
            if (live && current === generation) setEnabled(value);
          })
          .catch(() => {
            if (live && current === generation) setEnabled(false);
          });
      })();
    /**
     * 仅在当前入口设置变化时重新读取，避免另一入口的偏好事件触发本组件更新。
     * EN: Rereads only when this surface's settings change, ignoring preference events for another surface.
     */
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.surface === client.surface) read();
    };
    read();
    window.addEventListener('elysia.task-notification-settings', changed);
    return () => {
      live = false;
      window.removeEventListener('elysia.task-notification-settings', changed);
    };
  }, [client]);
  useEffect(() => {
    if (!ready || !enabled || !window.elysia?.notifyTaskStatus) return;
    const controller = new AbortController();
    let cursor: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let box: NotificationOutbox | undefined;
    /**
     * 使用当前客户端和取消信号创建发件箱，恢复提示计数并注入投递前核验、桌面投递和健康回调。
     * EN: Creates an outbox for this client/signal, restoring health counters and wiring verification, desktop delivery, and health callbacks.
     */
    const createBox = () =>
      new NotificationOutbox(
        {
          /**
           * 投递前读取任务最新投影，只有通知版本与状态仍匹配才返回 true；读取错误由发件箱处理。
           * EN: Rereads the latest task projection before delivery and returns true only for a matching revision/status; the outbox handles read errors.
           */
          verify: async (notice) => {
            /**
             * 真正投递前重新检查版本和状态，轮询队列中的旧变化不能直接变成系统通知。
             *
             * EN: Rechecks version/state immediately before delivery; stale queued changes cannot directly become system notifications.
             */
            const { item } = await client.api<{ item: TaskCenterItem | null }>(
              '/task-center/' + notice.id,
              undefined,
              undefined,
              controller.signal,
            );
            return (
              item?.notification?.revision === notice.revision && item.notification.status === notice.status
            );
          },
          /**
           * 将已核验通知的身份提交桌面桥，返回桥的投递结果；不在此处把请求发送等同于投递成功。
           * EN: Submits verified notice identity to the desktop bridge and returns its result without treating submission as delivery success.
           */
          deliver: (notice) =>
            window.elysia!.notifyTaskStatus!({
              surface: client.surface,
              taskId: notice.id,
              status: notice.status,
              revision: notice.revision,
            }),
          /**
           * 将发件箱的新健康快照写入当前入口缓存并广播，供任务中心显示待投递和失败计数。
           * EN: Caches and broadcasts the outbox health snapshot for this surface so the task center can show pending/failure counts.
           */
          changed: (health) => publishHealth(client, health),
        },
        readNotificationHealth(client),
      );
    /**
     * 响应当前入口的已读事件，清除活动发件箱的失败计数；未创建发件箱时无需操作。
     * EN: Dismisses failures in this surface's active outbox; no action is needed before an outbox exists.
     */
    const dismiss = (event: Event) => {
      if ((event as CustomEvent).detail?.surface === client.surface) box?.dismissFailures();
    };
    window.addEventListener('elysia.task-notification-dismiss', dismiss);
    /**
     * 完成后再安排下一轮，积压分页短间隔读取，普通轮询保持五秒，不叠加慢请求。
     *
     * EN: Schedules after completion: backlog pages use a short delay, normal polling uses five seconds, and slow reads never overlap.
     */
    const poll = async () => {
      let next = 5000;
      try {
        await client.initializeSession({ retry: true });
        if (controller.signal.aborted) return;
        box ||= createBox();
        const before = cursor;
        const query = new URLSearchParams({ limit: '40' });
        if (before !== undefined) query.set('after', String(before));
        const result = await client.api<TaskCenterChanges>(
          '/task-center/changes?' + query,
          undefined,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (before !== undefined && !result.baseline && !result.resetRequired) {
          /**
           * 初次读取或日志重置只建立观察基线，不能把已有历史全部通知一遍。
           *
           * EN: Initial/reset reads only establish a baseline instead of notifying all existing history.
           */
          for (const change of result.items) {
            if (controller.signal.aborted) return;
            if (change.item) box.enqueue(change.item, before);
            else box.remove(change.id);
          }
        }
        cursor = result.cursor;
        if (result.hasMore) next = 100;
      } catch {
        /**
         * 从最后成功游标重新连接，首次读取只建立基线。
         *
         * EN: Reconnect from the last successful cursor; a first read only seeds a baseline.
         */
      }
      await box?.drain(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), next);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener('elysia.task-notification-dismiss', dismiss);
      box?.stop();
    };
  }, [client, ready, enabled]);
  return null;
}
