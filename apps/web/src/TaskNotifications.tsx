import { useEffect, useState } from 'react';
import type { SurfaceClient } from './api';
import type { TaskCenterChanges, TaskCenterItem } from '../../../packages/contracts/src/task-center';
import { NotificationOutbox, type NotificationHealth } from './NotificationOutbox';

type Surface = 'native' | 'terminal';
function healthKey(client: SurfaceClient) {
  return client.surfaceStorageKey('elysia.notification.health.v1:' + (client.workbenchScope() || 'pending'));
}
export function readNotificationHealth(client: SurfaceClient): NotificationHealth {
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
function publishHealth(client: SurfaceClient, health: NotificationHealth) {
  try {
    sessionStorage.setItem(healthKey(client), JSON.stringify(health));
  } catch {}
  window.dispatchEvent(
    new CustomEvent('elysia.task-notification-error', { detail: { surface: client.surface, health } }),
  );
}
export function dismissTaskNotificationFailures(client: SurfaceClient) {
  publishHealth(client, { ...readNotificationHealth(client), failed: 0 });
  window.dispatchEvent(
    new CustomEvent('elysia.task-notification-dismiss', { detail: { surface: client.surface } }),
  );
}
export async function readTaskNotificationSettings(surface: Surface) {
  const settings = await window.elysia?.readTaskNotifications?.();
  return { enabled: settings?.[surface] === true, available: settings?.available === true };
}
export async function readTaskNotificationPreference(surface: Surface) {
  const settings = await readTaskNotificationSettings(surface);
  return settings.available && settings.enabled;
}
export async function setTaskNotificationPreference(surface: Surface, enabled: boolean) {
  if (!window.elysia?.setTaskNotifications) throw Error('桌面通知不可用');
  const preferences = await window.elysia.setTaskNotifications({ surface, enabled });
  window.dispatchEvent(new CustomEvent('elysia.task-notification-settings', { detail: { surface } }));
  return preferences[surface] === true;
}
/** Lives outside Activity so an explicitly enabled entry can report new background states. */
export function TaskNotifications({ client, ready }: { client: SurfaceClient; ready: boolean }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const read = () =>
      void (() => {
        const current = ++generation;
        return readTaskNotificationPreference(client.surface)
          .then((value) => {
            if (live && current === generation) setEnabled(value);
          })
          .catch(() => {
            if (live && current === generation) setEnabled(false);
          });
      })();
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
    const createBox = () =>
      new NotificationOutbox(
        {
          verify: async (notice) => {
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
          deliver: (notice) =>
            window.elysia!.notifyTaskStatus!({
              surface: client.surface,
              taskId: notice.id,
              status: notice.status,
              revision: notice.revision,
            }),
          changed: (health) => publishHealth(client, health),
        },
        readNotificationHealth(client),
      );
    const dismiss = (event: Event) => {
      if ((event as CustomEvent).detail?.surface === client.surface) box?.dismissFailures();
    };
    window.addEventListener('elysia.task-notification-dismiss', dismiss);
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
          for (const change of result.items) {
            if (controller.signal.aborted) return;
            if (change.item) box.enqueue(change.item, before);
            else box.remove(change.id);
          }
        }
        cursor = result.cursor;
        if (result.hasMore) next = 100;
      } catch {
        /* Reconnect from the last successful cursor; a first read only seeds a baseline. */
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
