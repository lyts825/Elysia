import { useEffect, useState } from 'react';
import type { Project } from '../../../packages/contracts/src/index';
import type { TaskCenterCategory, TaskCenterPage } from '../../../packages/contracts/src/task-center';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import { Modal } from './Modal';
import { Icon } from './Icon';
import {
  dismissTaskNotificationFailures,
  readNotificationHealth,
  readTaskNotificationSettings,
  setTaskNotificationPreference,
} from './TaskNotifications';
import './task-center.css';

export type TaskCenterState = { filter: 'all' | TaskCenterCategory; before: string; trail: string[] };
const labels: Record<'all' | TaskCenterCategory, string> = {
  all: '全部',
  running: '执行中',
  waiting: '待回应',
  verification: '待核验',
  done: '已结束',
  failed: '失败',
  paused: '暂停',
};
export function TaskCenter({
  state,
  changeState,
  projects,
  openRun,
  close,
}: {
  state: TaskCenterState;
  changeState: (state: TaskCenterState) => void;
  projects: Project[];
  openRun: (id: string) => Promise<void>;
  close: () => void;
}) {
  const client = useSurfaceClient();
  const { api, surface } = client;
  const [result, setResult] = useState<TaskCenterPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [opening, setOpening] = useState('');
  const [notifications, setNotifications] = useState<boolean>();
  const [notifySupported, setNotifySupported] = useState(false);
  const [notificationError, setNotificationError] = useState('');
  const [notificationHealth, setNotificationHealth] = useState(() => readNotificationHealth(client));
  const [savingNotifications, setSavingNotifications] = useState(false);
  useEffect(() => {
    let live = true;
    void readTaskNotificationSettings(surface)
      .then((value) => {
        if (live) {
          setNotifications(value.enabled);
          setNotifySupported(value.available);
        }
      })
      .catch(() => {
        if (live) setNotificationError('通知设置读取失败，请重新打开任务中心。');
      });
    return () => {
      live = false;
    };
  }, [surface]);
  useEffect(() => {
    const receive = (event: Event) => {
      if ((event as CustomEvent).detail?.surface === surface)
        setNotificationHealth(readNotificationHealth(client));
    };
    window.addEventListener('elysia.task-notification-error', receive);
    return () => window.removeEventListener('elysia.task-notification-error', receive);
  }, [client, surface]);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    setResult(undefined);
    const read = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      setLoading(true);
      try {
        const query = new URLSearchParams({ filter: state.filter, limit: '40' });
        if (state.before) query.set('before', state.before);
        const value = await api<TaskCenterPage>(
          '/task-center?' + query,
          undefined,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setResult(value);
          setError('');
        }
      } catch (issue) {
        if (!controller.signal.aborted) {
          if (issue instanceof ApiError && issue.code === 'RECORD_CURSOR_MISSING' && state.before)
            changeState({ ...state, before: '', trail: [] });
          else setError(issue instanceof Error ? issue.message : '任务读取失败，请重试。');
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, state, changeState, retry]);
  return (
    <Modal
      title="任务中心"
      subtitle={surface === 'terminal' ? 'Agent 终端' : 'Elysia · 原生 API'}
      close={close}
      wide
      className="task-center"
    >
      <div className="task-center-body">
        <nav className="task-center-filters" aria-label="任务状态筛选">
          {(Object.keys(labels) as (keyof typeof labels)[]).map((filter) => (
            <button
              key={filter}
              className="quiet-button"
              aria-pressed={filter === state.filter}
              onClick={() => changeState({ filter, before: '', trail: [] })}
            >
              {labels[filter]}
            </button>
          ))}
        </nav>
        <div className="task-center-options">
          <label>
            <input
              type="checkbox"
              checked={notifications === true}
              disabled={!notifySupported || notifications === undefined || savingNotifications}
              onChange={(event) => {
                const enabled = event.target.checked;
                setSavingNotifications(true);
                void setTaskNotificationPreference(surface, enabled)
                  .then((value) => {
                    setNotifications(value);
                    setNotificationError('');
                  })
                  .catch(() => setNotificationError('通知设置保存失败，原设置已保留。'))
                  .finally(() => setSavingNotifications(false));
              }}
            />
            状态通知
          </label>
          <span>{notifySupported ? '仅通知新的完成、待回应、核验或失败状态' : '桌面版可启用系统通知'}</span>
          <button
            className="icon-button"
            aria-label="刷新任务中心"
            disabled={loading}
            onClick={() => setRetry((value) => value + 1)}
          >
            <Icon name="refresh" size={16} />
          </button>
        </div>
        {notificationError && (
          <p role="alert" className="field-error">
            {notificationError}
          </p>
        )}
        {notificationHealth.failed > 0 && (
          <p role="status" className="field-error">
            {notificationHealth.failed} 项状态通知未送达，可检查系统通知权限。
            <button className="quiet-button" onClick={() => dismissTaskNotificationFailures(client)}>
              知道了
            </button>
          </p>
        )}
        {notificationHealth.pending > 0 && (
          <p role="status" className="task-center-empty">
            {notificationHealth.pending} 项状态通知正在重试…
          </p>
        )}
        {error && (
          <div role="alert" className="task-center-error">
            <span>{error}</span>
            <button className="secondary" disabled={loading} onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          </div>
        )}
        <div className="task-center-list" aria-busy={loading}>
          {result?.items.map((item) => (
            <button
              key={item.id}
              className="task-center-row"
              disabled={!!opening}
              onClick={() => {
                setOpening(item.id);
                void openRun(item.id)
                  .catch((issue) => setError(issue instanceof Error ? issue.message : '无法打开对话。'))
                  .finally(() => setOpening(''));
              }}
            >
              <span className={'task-center-status ' + item.category}>
                {item.status === 'CANCELLED' ? '已取消' : labels[item.category]}
              </span>
              <span className="task-center-description">
                <strong title={item.title}>{item.title}</strong>
                <small>
                  {projects.find((project) => project.id === item.projectId)?.name ||
                    (item.kind === 'chat' ? '独立对话' : '项目任务')}
                </small>
              </span>
              <Icon name={opening === item.id ? 'refresh' : 'chevron'} size={16} />
            </button>
          ))}
          {!result?.items.length && (
            <p className="task-center-empty" role="status">
              {loading ? '正在读取任务…' : error ? '任务暂时无法读取' : '暂无此类任务'}
            </p>
          )}
        </div>
      </div>
      <footer className="modal-footer task-center-pagination">
        <span role="status">{result ? `共 ${result.page.total} 项` : '每页最多 40 项'}</span>
        <button
          className="secondary"
          disabled={loading || !state.trail.length}
          onClick={() =>
            changeState({ ...state, before: state.trail.at(-1)!, trail: state.trail.slice(0, -1) })
          }
        >
          上一页
        </button>
        <button
          className="secondary"
          disabled={loading || !result?.page.nextBefore}
          onClick={() =>
            changeState({ ...state, before: result!.page.nextBefore!, trail: [...state.trail, state.before] })
          }
        >
          下一页
        </button>
      </footer>
    </Modal>
  );
}
