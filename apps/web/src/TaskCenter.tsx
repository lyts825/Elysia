/**
 * 展示任务中心及其任务状态。
 *
 * EN: Displays the task center and its task states.
 *
 * 本模块负责任务列表的筛选、游标分页、周期刷新、打开详情及通知偏好交互；筛选轨迹由父层持有，列表投影只供展示，实际导航由外层读取完整详情后处理。
 * EN: Owns task-list filtering, cursor paging, periodic refresh, detail opening, and notification preferences. The parent retains filter history; list projections support display while outer navigation rereads full detail.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../../packages/contracts/src/index';
import type { TaskCenterCategory, TaskCenterPage } from '../../../packages/contracts/src/task-center';
import type { DeliveryReviewStatus } from '../../../packages/contracts/src/workflow';
import { reviewStatusLabels } from './ReviewStatus';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { taskCenterCategoryLabels, taskCenterPresentation } from './TaskCenterPresentation';
import {
  dismissTaskNotificationFailures,
  readNotificationHealth,
  readTaskNotificationSettings,
  setTaskNotificationPreference,
} from './TaskNotifications';
import './task-center.css';

export type TaskCenterState = {
  /**
   * 筛选条件与分页轨迹由父组件持有，关闭面板后仍可恢复。
   *
   * EN: The parent owns filters and paging history so they survive closing the panel.
   */
  filter: 'all' | TaskCenterCategory;
  before: string;
  trail: string[];
  projectId?: string;
  query?: string;
  reviewFilter?: DeliveryReviewStatus;
};
const labels: Record<'all' | TaskCenterCategory, string> = {
  all: '全部',
  ...taskCenterCategoryLabels,
};
/**
 * 按父组件持有的筛选/游标状态读取任务中心，五秒刷新当前页并支持异常投影显式重试。
 * 行展示使用列表快照，openRun 再读取完整详情决定导航；通知偏好独立从桌面桥读取和保存。
 * 请求失效、分页失效和焦点恢复各自处理，避免错误页面覆盖用户正在操作的控件。
 *
 * EN: Reads using parent-held filters/cursors, refreshes every five seconds, and supports explicit retry of faulty projections. Rows are snapshots; openRun rereads details for navigation. Notification preferences are independent. Request/cursor invalidation and focus restoration are handled separately so errors do not overwrite active user interaction.
 */
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
  openRun: (id: string, category: TaskCenterCategory | 'review') => Promise<void>;
  close: () => void;
}) {
  const client = useSurfaceClient();
  const { api, surface } = client;
  /**
   * 项目接口返回新数组时重建索引，保留 find 的首匹配语义，并复用未归档列表。
   * EN: Rebuilds for a new API project array, preserves find's first match, and reuses active projects.
   */
  const { projectsById, activeProjects } = useMemo(() => {
    const projectsById = new Map<string | null, Project>();
    const activeProjects: Project[] = [];
    for (const project of projects) {
      const id = project.id;
      if (!projectsById.has(id)) projectsById.set(id, project);
      if (!project.archived) activeProjects.push(project);
    }
    return { projectsById, activeProjects };
  }, [projects]);
  const [result, setResult] = useState<TaskCenterPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const retryReviews = useRef(false);
  const retryProjections = useRef(false);
  const [opening, setOpening] = useState('');
  const [openingError, setOpeningError] = useState<{ id: string; message: string }>();
  const openingErrorRef = useRef<HTMLParagraphElement>(null);
  const queryInput = useRef<HTMLInputElement>(null);
  const openingFocus = useRef<{
    origin: HTMLButtonElement;
    active: boolean;
    controller: AbortController;
  }>(undefined);
  const [notifications, setNotifications] = useState<boolean>();
  const [notifySupported, setNotifySupported] = useState(false);
  const [notificationError, setNotificationError] = useState('');
  const [notificationHealth, setNotificationHealth] = useState(() => readNotificationHealth(client));
  const [savingNotifications, setSavingNotifications] = useState(false);
  useEffect(
    () => () => {
      openingFocus.current?.controller.abort();
      openingFocus.current = undefined;
    },
    [],
  );
  /**
   * 导航失败只在用户尚未离开触发按钮时聚焦错误；后续选择或窗口失焦会取消该意图。
   *
   * EN: Focuses navigation errors only while the user remains at the initiating button; later selection or window blur cancels that intent.
   */
  useLayoutEffect(() => {
    if (!openingError) return;
    const request = openingFocus.current;
    if (
      request?.active &&
      request.origin.isConnected &&
      (document.activeElement === document.body || document.activeElement === request.origin)
    ) {
      openingErrorRef.current?.focus();
      openingErrorRef.current?.scrollIntoView({ block: 'nearest' });
    }
    request?.controller.abort();
    openingFocus.current = undefined;
  }, [openingError]);
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
    /**
     * 只接收当前入口的通知健康事件，按当前客户端重新读缓存，避免其他入口的提示串入面板。
     * EN: Accepts health events for this surface only and rereads its client cache so other surfaces do not affect this panel.
     */
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
    /**
     * 切换筛选清空旧页，当前查询定时刷新失败则保留已读结果和明确错误。
     *
     * EN: Changing filters clears the old page; refresh failures retain the successful current-query page with an explicit error.
     */
    setResult(undefined);
    openingFocus.current?.controller.abort();
    openingFocus.current = undefined;
    setOpeningError(undefined);
    /**
     * 读取当前筛选页并消费一次性的重试标志；并发门闩阻止慢请求叠加，取消后不发布结果。
     * 游标失效回到首页，其他失败保留已读页并显示错误；finally 只结束本次仍有效的加载状态。
     * EN: Reads the filtered page and consumes one-shot retry flags. A latch prevents overlapping slow reads and cancellation suppresses updates.
     * Invalid cursors return to page one; other failures retain the last page with an error, and finally clears loading only for a live read.
     */
    const read = async () => {
      /**
       * 定时器可能在慢请求期间触发，pending 防止同一查询并行叠加。
       *
       * EN: pending prevents timer ticks from stacking parallel reads while a slow request remains active.
       */
      if (pending || controller.signal.aborted) return;
      pending = true;
      setLoading(true);
      try {
        const query = new URLSearchParams({ filter: state.filter, limit: '40' });
        if (state.projectId) query.set('projectId', state.projectId);
        if (state.query?.trim()) query.set('query', state.query.trim());
        if (surface === 'native' && state.reviewFilter) query.set('reviewFilter', state.reviewFilter);
        if (surface === 'native' && retryReviews.current) query.set('retryReviews', 'true');
        retryReviews.current = false;
        if (retryProjections.current) query.set('retryProjections', 'true');
        retryProjections.current = false;
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
            /**
             * 删除或重建使旧游标失效时回到首页，不能把旧页码套在新结果上。
             *
             * EN: Returns to page one if deletion/rebuilding invalidates a cursor instead of attaching an old page number to new results.
             */
            changeState({ ...state, before: '', trail: [] });
          else setError(issue instanceof Error ? issue.message : '任务读取失败，请重试。');
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    const start = setTimeout(() => void read(), state.query ? 200 : 0);
    const timer = setInterval(() => void read(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
      clearTimeout(start);
    };
  }, [api, state, changeState, retry, surface]);
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
              onClick={() => changeState({ ...state, filter, before: '', trail: [] })}
            >
              {labels[filter]}
            </button>
          ))}
        </nav>
        {surface === 'native' && (
          <label className="task-center-review-filter">
            用户复核状态
            <select
              aria-label="筛选用户复核状态"
              value={state.reviewFilter || ''}
              onChange={(event) =>
                changeState({
                  ...state,
                  reviewFilter: (event.target.value || undefined) as DeliveryReviewStatus | undefined,
                  before: '',
                  trail: [],
                })
              }
            >
              <option value="">全部复核状态</option>
              {Object.entries(reviewStatusLabels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
            <small>与执行状态、项目和搜索共同筛选。</small>
          </label>
        )}
        <div className="task-center-search">
          <label>
            搜索任务
            <input
              type="search"
              ref={queryInput}
              aria-label="搜索任务"
              placeholder="搜索任务…"
              maxLength={200}
              value={state.query || ''}
              onChange={(event) =>
                changeState({ ...state, query: event.target.value, before: '', trail: [] })
              }
            />
          </label>
          <label>
            所属项目
            <select
              aria-label="筛选任务项目"
              value={state.projectId || ''}
              onChange={(event) =>
                changeState({ ...state, projectId: event.target.value, before: '', trail: [] })
              }
            >
              <option value="">全部项目</option>
              {!!state.projectId && !projectsById.has(state.projectId) && (
                <option value={state.projectId} disabled>
                  原项目不可用
                </option>
              )}
              {activeProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {state.projectId && (
          <p className="task-center-project-summary">
            当前项目：{projectsById.get(state.projectId)?.name || '原项目不可用'}
          </p>
        )}
        {(state.filter !== 'all' || state.query || state.projectId || state.reviewFilter) && (
          <div className="task-center-filter-summary">
            <span>正在按所选条件筛选任务</span>
            <button
              type="button"
              className="quiet-button"
              aria-label="清除任务筛选"
              onClick={() => {
                changeState({
                  ...state,
                  filter: 'all',
                  query: '',
                  projectId: '',
                  reviewFilter: undefined,
                  before: '',
                  trail: [],
                });
                queryInput.current?.focus({ preventScroll: true });
              }}
            >
              <Icon name="close" size={14} />
              清除筛选
            </button>
          </div>
        )}
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
            <p className="task-center-error-detail" role="region" aria-label="任务读取失败详情" tabIndex={0}>
              {error}
            </p>
            <button className="secondary" disabled={loading} onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          </div>
        )}
        {result?.projectionCoverage && !result.projectionCoverage.complete && (
          <div className="task-center-review-issue" role="status">
            <p>
              {result.projectionCoverage.unavailable} 项任务信息暂不可读取，无法判断其执行状态。
              当前筛选、搜索与总数可能不完整，健康记录仍可使用。
            </p>
            <button
              className="secondary"
              disabled={loading}
              onClick={() => {
                retryProjections.current = true;
                setRetry((value) => value + 1);
              }}
            >
              重试读取异常任务
            </button>
          </div>
        )}
        {result?.reviewCoverage && !result.reviewCoverage.complete && (
          <div className="task-center-review-issue" role="status">
            <p>
              {result.reviewCoverage.unavailable} 项复核状态暂不可读取。
              {state.reviewFilter
                ? '当前结果与总数仅包含已知状态的匹配项，筛选结果可能不完整。'
                : '任务记录仍可打开，暂不归入任何复核状态。'}
            </p>
            <button
              className="secondary"
              disabled={loading}
              onClick={() => {
                retryReviews.current = true;
                setRetry((value) => value + 1);
              }}
            >
              重试读取异常复核
            </button>
          </div>
        )}
        <div className="task-center-list" aria-busy={loading}>
          {result?.items.map((item) => {
            const presentation = taskCenterPresentation(item);
            return (
              <div key={item.id} className="task-center-item">
                <button
                  className="task-center-row"
                  aria-label={`${item.title}，${presentation.status}，${presentation.action}`}
                  disabled={!!opening}
                  onClick={(event) => {
                    /**
                     * 跟踪导航期间的焦点/指针变化；失败反馈不能打断用户已开始的其他操作。
                     *
                     * EN: Tracks focus/pointer changes during navigation so failure feedback does not interrupt another action.
                     */
                    openingFocus.current?.controller.abort();
                    const focus = {
                      origin: event.currentTarget,
                      active: true,
                      controller: new AbortController(),
                    };
                    openingFocus.current = focus;
                    const options = { signal: focus.controller.signal, capture: true };
                    document.addEventListener(
                      'focusin',
                      (event) => {
                        if (event.target !== focus.origin && event.target !== document.body)
                          focus.active = false;
                      },
                      options,
                    );
                    document.addEventListener(
                      'pointerdown',
                      (event) => {
                        if (!focus.origin.contains(event.target as Node)) focus.active = false;
                      },
                      options,
                    );
                    window.addEventListener(
                      'blur',
                      (event) => {
                        if (event.target === window) focus.active = false;
                      },
                      options,
                    );
                    setOpening(item.id);
                    setOpeningError(undefined);
                    void openRun(item.id, presentation.target)
                      .then(() => {
                        focus.controller.abort();
                        if (openingFocus.current === focus) openingFocus.current = undefined;
                      })
                      .catch((issue) => {
                        if (openingFocus.current !== focus) return;
                        setOpeningError({
                          id: item.id,
                          message: issue instanceof Error ? issue.message : '无法打开对话。',
                        });
                      })
                      .finally(() => setOpening(''));
                  }}
                >
                  <span className={'task-center-status ' + item.category}>{presentation.status}</span>
                  <span className="task-center-description">
                    <strong title={item.title}>{item.title}</strong>
                    <small>
                      {projectsById.get(item.projectId)?.name ||
                        (item.kind === 'chat' ? '独立对话' : '项目任务')}
                    </small>
                    {!item.readIssue && !item.reviewIssue && presentation.review && item.reviewStatus && (
                      <small className="task-center-review-status">
                        用户复核：{reviewStatusLabels[item.reviewStatus]}
                      </small>
                    )}
                    {presentation.hint && <small>{presentation.hint}</small>}
                  </span>
                  <span className="task-center-action" role={opening === item.id ? 'status' : undefined}>
                    {opening === item.id ? '正在打开…' : presentation.action}
                  </span>
                  <Icon name={opening === item.id ? 'refresh' : 'chevron'} size={16} />
                </button>
                {(item.readIssue || (presentation.review && item.reviewIssue)) && (
                  <p
                    className="task-center-item-issue"
                    role="region"
                    aria-label={`${item.title}的读取问题`}
                    tabIndex={0}
                  >
                    {item.readIssue
                      ? item.readIssue.message
                      : `用户复核：暂不可读 · ${item.reviewIssue!.message}`}
                  </p>
                )}
                {openingError?.id === item.id && (
                  <div className="task-center-open-error" role="alert">
                    <strong>无法打开此任务，请重试上方入口。</strong>
                    <p
                      ref={openingErrorRef}
                      className="task-center-error-detail"
                      role="region"
                      aria-label="任务打开失败详情"
                      tabIndex={0}
                    >
                      {openingError.message}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
          {!result?.items.length && (
            <p className="task-center-empty" role="status">
              {loading ? '正在读取任务…' : error ? '任务暂时无法读取' : '暂无此类任务'}
            </p>
          )}
        </div>
      </div>
      <footer className="modal-footer task-center-pagination">
        <span role="status">
          {result
            ? `${result.projectionCoverage && !result.projectionCoverage.complete ? '当前可列出' : state.reviewFilter && result.reviewCoverage && !result.reviewCoverage.complete ? '已知匹配' : '共'} ${result.page.total} 项`
            : '每页最多 40 项'}
          {result && (
            <small>
              第 {state.trail.length + 1} 页 · 本页 {result.items.length} 项
            </small>
          )}
        </span>
        <div className="task-center-page-actions">
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
              changeState({
                ...state,
                before: result!.page.nextBefore!,
                trail: [...state.trail, state.before],
              })
            }
          >
            下一页
          </button>
        </div>
      </footer>
    </Modal>
  );
}
