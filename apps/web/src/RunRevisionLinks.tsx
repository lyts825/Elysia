import { useEffect, useRef, useState } from 'react';
import type { Run } from '../../../packages/contracts/src/index';
import type { RunLineage, RunRevisions } from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import './workflow.css';
const statuses: Record<string, string> = {
  DONE: '执行完成',
  WAITING: '等待处理',
  READY: '就绪',
  RUNNING: '执行中',
  FAILED: '失败',
  CANCELLED: '已取消',
  VERIFYING: '待核验',
  DRAFT: '待开始',
};
export function RunRevisionLinks({ runId, openRun }: { runId: string; openRun: (run: Run) => void }) {
  const { api } = useSurfaceClient();
  const navigation = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false),
    [lineage, setLineage] = useState<RunLineage>(),
    [revisions, setRevisions] = useState<RunRevisions>();
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [loading, setLoading] = useState(false),
    [opening, setOpening] = useState('');
  const [before, setBefore] = useState(''),
    [trail, setTrail] = useState<string[]>([]),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    setOpening('');
    return () => {
      navigation.current?.abort();
      navigation.current = null;
    };
  }, [runId, open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setErrors({});
    void Promise.allSettled([
      api<RunLineage>(`/runs/${runId}/lineage`, undefined, undefined, controller.signal),
      api<RunRevisions>(
        `/runs/${runId}/revisions${before ? '?before=' + encodeURIComponent(before) : ''}`,
        undefined,
        undefined,
        controller.signal,
      ),
    ]).then(([ancestors, children]) => {
      if (controller.signal.aborted) return;
      if (ancestors.status === 'fulfilled') setLineage(ancestors.value);
      else
        setErrors((old) => ({
          ...old,
          lineage: ancestors.reason instanceof Error ? ancestors.reason.message : '来源读取失败',
        }));
      if (children.status === 'fulfilled') setRevisions(children.value);
      else
        setErrors((old) => ({
          ...old,
          revisions: children.reason instanceof Error ? children.reason.message : '修订读取失败',
        }));
      setLoading(false);
    });
    return () => controller.abort();
  }, [api, runId, open, before, retry]);
  async function navigate(id: string) {
    if (navigation.current || !open) return;
    const controller = new AbortController();
    navigation.current = controller;
    setOpening(id);
    try {
      const run = await api<Run>(`/runs/${id}/header`, undefined, undefined, controller.signal);
      if (!controller.signal.aborted) openRun(run);
    } catch (issue) {
      if (controller.signal.aborted) return;
      setErrors((old) => ({
        ...old,
        navigation: issue instanceof Error ? issue.message : '记录已不可用，请刷新关系。',
      }));
    } finally {
      if (!controller.signal.aborted) {
        setOpening('');
        navigation.current = null;
      }
    }
  }
  return (
    <details className="workflow-source" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>来源与后续修订</summary>
      {open && (
        <>
          <p className="field-help">
            各修订独立执行，分支之间不会自动替代。已删除来源仍保留当前任务的来源快照。
          </p>
          <h4>来源链</h4>
          {lineage?.ancestors.map((item) => (
            <p key={item.runId} className="workflow-revision-row">
              {item.missing ? (
                <span>{item.title} · 来源记录已删除，快照仍保留</span>
              ) : (
                <>
                  <button
                    className="text-button"
                    disabled={!!opening}
                    onClick={() => void navigate(item.runId)}
                  >
                    {item.title}
                  </button>
                  <span>
                    {statuses[item.status || ''] || item.status}
                    {item.archived ? ' · 已归档' : ''}
                  </span>
                </>
              )}
            </p>
          ))}
          {lineage && !lineage.ancestors.length && <p className="field-help">此任务没有来源任务。</p>}
          {lineage?.hasMore && (
            <p className="field-help">这里只显示最近 20 级来源，可打开较早任务继续查看。</p>
          )}
          {lineage?.cycleDetected && (
            <p role="alert" className="field-error">
              来源记录存在循环，已停止继续展开。
            </p>
          )}
          <h4>直接后续修订</h4>
          {revisions?.items.map((item) => (
            <p key={item.runId} className="workflow-revision-row">
              <button className="text-button" disabled={!!opening} onClick={() => void navigate(item.runId)}>
                {item.title}
              </button>
              <span>
                {statuses[item.status] || item.status}
                {item.archived ? ' · 已归档' : ''} · {item.createdAt}
              </span>
            </p>
          ))}
          {revisions && !revisions.items.length && <p className="field-help">尚无后续修订。</p>}
          <div className="workflow-actions">
            {!!trail.length && (
              <button
                className="secondary"
                disabled={loading}
                onClick={() => {
                  setBefore(trail.at(-1)!);
                  setTrail((old) => old.slice(0, -1));
                }}
              >
                上一页修订
              </button>
            )}
            {revisions?.page.hasMore && (
              <button
                className="secondary"
                disabled={loading}
                onClick={() => {
                  setTrail((old) => [...old, before]);
                  setBefore(revisions.page.nextBefore!);
                }}
              >
                下一页修订
              </button>
            )}
            <button
              className="text-button"
              disabled={loading}
              onClick={() => {
                setBefore('');
                setTrail([]);
                setRetry((old) => old + 1);
              }}
            >
              刷新关系
            </button>
          </div>
          {loading && <p role="status">正在读取任务关系…</p>}
          {Object.entries(errors).map(([key, message]) => (
            <p key={key} role="alert" className="field-error">
              {message}
            </p>
          ))}
        </>
      )}
    </details>
  );
}
