import { useEffect, useState } from 'react';
import type { SurfaceClient } from './api';
import type { TaskCenterChanges } from '../../../packages/contracts/src/task-center';

type Surface = 'native' | 'terminal';
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
    const read = () =>
      void readTaskNotificationPreference(client.surface)
        .then((value) => {
          if (live) setEnabled(value);
        })
        .catch(() => {
          if (live) setEnabled(false);
        });
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
    const poll = async () => {
      let next = 5000;
      try {
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
            const notification = change.item?.notification;
            if (!notification || notification.revision <= before) continue;
            try {
              await window.elysia?.notifyTaskStatus?.({
                surface: client.surface,
                taskId: change.id,
                status: notification.status,
                revision: notification.revision,
              });
            } catch {
              window.dispatchEvent(
                new CustomEvent('elysia.task-notification-error', { detail: { surface: client.surface } }),
              );
            }
          }
        }
        cursor = result.cursor;
        if (result.hasMore) next = 100;
      } catch {
        /* Reconnect from the last successful cursor; a first read only seeds a baseline. */
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), next);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, ready, enabled]);
  return null;
}
