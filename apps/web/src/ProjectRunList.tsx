import { useEffect, useState } from 'react';
import type { TaskCenterPage } from '../../../packages/contracts/src/task-center';
import { useSurfaceClient } from './SurfaceClientContext';
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
        <input type="search" value={query} onChange={(e) => changeQuery(e.target.value)} />
      </label>
      <p className="field-help">
        {choose
          ? '只关联你明确选择的本项目任务；关联不会改写任务，也不会自动判定交付。'
          : '此处包含本项目任务；未关联交付项的自由任务也可继续使用。'}
      </p>
      {loading && <p role="status">正在读取项目任务…</p>}
      {error && (
        <p className="field-error" role="alert">
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
      {page?.items.map((item) => (
        <article className="project-run-row" key={item.id}>
          <div>
            <strong>{item.title}</strong>
            <p>
              {executionLabel(item.status)} ·{' '}
              {item.reviewIssue
                ? '复核无法读取'
                : item.reviewStatus
                  ? reviewLabels[item.reviewStatus]
                  : '尚无交付复核'}
            </p>
          </div>
          <div className="project-actions">
            <button type="button" className="secondary" onClick={() => openRun(item.id)}>
              查看任务
            </button>
            {item.reviewStatus && (
              <button type="button" className="secondary" onClick={() => openRun(item.id, true)}>
                查看复核
              </button>
            )}
            {choose && (
              <button
                type="button"
                className="primary"
                disabled={busy || !!item.readIssue}
                onClick={() => choose(item.id)}
              >
                关联此次执行
              </button>
            )}
          </div>
        </article>
      ))}
      {page && !page.items.length && <p className="field-help">当前范围没有任务。</p>}
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
        <span>{page ? `共 ${page.page.total} 条` : ''}</span>
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
    </section>
  );
}
