import { useEffect, useId, useRef, useState } from 'react';
import type { TaskCenterPage } from '../../../packages/contracts/src/task-center';
import { useSurfaceClient } from './SurfaceClientContext';
import './project-run-list.css';
export const executionLabel = (status: string | null) =>
  ({
    DRAFT: '待开始',
    READY: '就绪',
    RUNNING: '执行中',
    WAITING: '等待',
    VERIFYING: '待验收',
    DONE: '已完成',
    FAILED: '失败',
    CANCELLED: '已取消',
  })[status || ''] || '执行状态未知';
export const reviewLabels = {
  unreviewed: '未复核',
  accepted: '已采纳',
  changes_requested: '需修改',
  stale: '需重新复核',
};
export function ProjectRunList({
  projectId,
  query,
  changeQuery,
  openRun,
  choose,
  busy = false,
}: {
  projectId: string;
  query: string;
  changeQuery: (value: string) => void;
  openRun: (id: string, review?: boolean) => void;
  choose?: (id: string) => void;
  busy?: boolean;
}) {
  const { api } = useSurfaceClient();
  const id = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<TaskCenterPage>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [before, setBefore] = useState(''),
    [trail, setTrail] = useState<string[]>([]),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    setBefore('');
    setTrail([]);
  }, [projectId, query]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setPage(undefined);
    const params = new URLSearchParams({ projectId, kind: 'task', filter: 'all', limit: '20', query });
    if (before) params.set('before', before);
    void api<TaskCenterPage>('/task-center?' + params, undefined, undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '项目任务读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, projectId, query, before, retry]);
  return (
    <section className="project-run-list" aria-label={choose ? '关联已有项目任务' : '项目执行记录'}>
      <label>
        搜索项目任务
        <input ref={searchInput} type="search" value={query} onChange={(e) => changeQuery(e.target.value)} />
      </label>
      <p className="field-help">
        {choose
          ? '只关联你明确选择的本项目任务；关联不会改写任务，也不会自动判定交付。'
          : '此处包含本项目任务；未关联交付项的自由任务也可继续使用。'}
      </p>
      {loading && <p role="status">正在读取项目任务…</p>}
      {error && (
        <p className="field-error project-read-error" role="alert" aria-label="项目任务读取问题" tabIndex={0}>
          {error}
        </p>
      )}
      <button
        type="button"
        className="secondary"
        disabled={loading}
        onClick={() => {
          setBefore('');
          setTrail([]);
          setRetry((n) => n + 1);
        }}
      >
        刷新项目任务
      </button>
      {page && (!page.reviewCoverage.complete || page.projectionCoverage?.complete === false) && (
        <p className="field-error">部分记录无法读取，数量与复核状态可能不完整。可在任务中心重试异常记录。</p>
      )}
      {page?.items.map((item, index) => (
        <article className="project-run-row" key={item.id}>
          <div className="project-run-description">
            <p className="project-run-number">本页任务 {index + 1}</p>
            <div
              id={`${id}-title-${index}`}
              className="project-run-reading"
              role="region"
              aria-label={`任务 ${index + 1} 完整名称`}
              tabIndex={0}
            >
              <strong>{item.title}</strong>
            </div>
            <p className="project-run-status">
              <span>{executionLabel(item.status)}</span>
              <span>
                {item.reviewIssue
                  ? '复核无法读取'
                  : item.reviewStatus
                    ? reviewLabels[item.reviewStatus]
                    : '尚无交付复核'}
              </span>
            </p>
            {(item.readIssue || item.reviewIssue) && (
              <div className="project-run-issues">
                {item.readIssue && (
                  <p
                    id={`${id}-issue-${index}`}
                    className="project-run-reading field-error"
                    role="region"
                    aria-label={`任务 ${index + 1} 读取问题`}
                    tabIndex={0}
                  >
                    任务记录暂不可读，不能关联此次执行。{item.readIssue.message}
                  </p>
                )}
                {item.reviewIssue && (
                  <p
                    className="project-run-reading field-error"
                    role="region"
                    aria-label={`任务 ${index + 1} 复核读取问题`}
                    tabIndex={0}
                  >
                    {item.reviewIssue.message}
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="project-actions">
            <button
              type="button"
              className="secondary"
              aria-describedby={`${id}-title-${index}`}
              onClick={() => openRun(item.id)}
            >
              查看任务
            </button>
            {item.reviewStatus && (
              <button
                type="button"
                className="secondary"
                aria-describedby={`${id}-title-${index}`}
                onClick={() => openRun(item.id, true)}
              >
                查看复核
              </button>
            )}
            {choose && (
              <button
                type="button"
                className="primary"
                disabled={busy || !!item.readIssue}
                aria-describedby={`${id}-title-${index}${item.readIssue ? ` ${id}-issue-${index}` : ''}`}
                onClick={() => choose(item.id)}
              >
                关联此次执行
              </button>
            )}
          </div>
        </article>
      ))}
      {page && !page.items.length && (
        <div className="project-run-empty">
          <p className="field-help">{query.trim() ? '没有符合搜索条件的任务。' : '当前范围没有任务。'}</p>
          {query.trim() && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                changeQuery('');
                searchInput.current?.focus();
              }}
            >
              清除搜索
            </button>
          )}
        </div>
      )}
      <nav className="project-run-pagination" aria-label="项目执行记录翻页">
        {page && (
          <p className="field-help">
            第 {trail.length + 1} 页 · 本页 {page.items.length} 条 · 共 {page.page.total} 条
          </p>
        )}
        <div className="project-actions">
          <button
            type="button"
            className="secondary"
            disabled={!trail.length || loading}
            onClick={() => {
              setBefore(trail.at(-1) || '');
              setTrail(trail.slice(0, -1));
            }}
          >
            上一页
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!page?.page.hasMore || loading}
            onClick={() => {
              setTrail([...trail, before]);
              setBefore(page?.page.nextBefore || '');
            }}
          >
            下一页
          </button>
        </div>
      </nav>
    </section>
  );
}
