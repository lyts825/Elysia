import { useEffect, useId, useRef, useState } from 'react';
import type { Run } from '../../../packages/contracts/src/index';
import type { RunLineage, RunRevisions } from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import './workflow.css';
import './run-revision-links.css';
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
  const readingId = useId();
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
  const [readPage, setReadPage] = useState({ before: '', index: 1 });
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
      if (children.status === 'fulfilled') {
        setRevisions(children.value);
        setReadPage({ before, index: trail.length + 1 });
      } else
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
    setErrors((old) => {
      const { navigation: _previous, ...reads } = old;
      return reads;
    });
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
    <details
      className="workflow-source run-revision-links"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>来源与后续修订</summary>
      {open && (
        <>
          <p className="field-help">
            各修订独立执行，分支之间不会自动替代。已删除来源仍保留当前任务的来源快照。
          </p>
          {loading && (
            <p className="run-revision-read-state" role="status">
              {lineage || revisions ? '正在重新读取关系，已读列表暂时保留。' : '正在读取任务关系…'}
            </p>
          )}
          <h4 className="run-revision-heading">
            来源链 {lineage && <span>已读 {lineage.ancestors.length} 级</span>}
          </h4>
          {!!lineage?.ancestors.length && (
            <div className="run-revision-list" role="region" aria-label="来源链已读列表" tabIndex={0}>
              <ul>
                {lineage.ancestors.map((item, index) => (
                  <li key={item.runId} className="run-revision-item">
                    <p
                      className="run-revision-title"
                      id={readingId + '-source-' + index}
                      role="region"
                      aria-label="来源任务完整标题与标识"
                      tabIndex={0}
                    >
                      {item.title}
                      <br />
                      <code>{item.runId}</code>
                    </p>
                    {item.missing ? (
                      <p className="run-revision-meta">来源记录已删除，快照仍保留</p>
                    ) : (
                      <>
                        <p className="run-revision-meta">
                          {statuses[item.status || ''] || item.status || '执行状态未提供'}
                          {item.archived ? ' · 已归档' : ''}
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          aria-describedby={readingId + '-source-' + index}
                          disabled={!!opening}
                          onClick={() => void navigate(item.runId)}
                        >
                          {opening === item.runId ? '正在打开…' : '打开来源任务'}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {lineage && !lineage.ancestors.length && <p className="field-help">此任务没有来源任务。</p>}
          {lineage?.hasMore && (
            <p className="field-help">这里只显示最近 20 级来源，可打开较早任务继续查看。</p>
          )}
          {lineage?.cycleDetected && (
            <p role="alert" className="field-error">
              来源记录存在循环，已停止继续展开。
            </p>
          )}
          <h4 className="run-revision-heading">
            直接后续修订 {revisions && <span>本页 {revisions.items.length} 条</span>}
          </h4>
          {revisions && readPage.before !== before && (
            <p className="field-help">所选页尚未读取成功，下方保留上次已读修订。</p>
          )}
          {!!revisions?.items.length && (
            <div className="run-revision-list" role="region" aria-label="后续修订已读列表" tabIndex={0}>
              <ul>
                {revisions.items.map((item, index) => (
                  <li key={item.runId} className="run-revision-item">
                    <p
                      className="run-revision-title"
                      id={readingId + '-revision-' + index}
                      role="region"
                      aria-label="修订任务完整标题与标识"
                      tabIndex={0}
                    >
                      {item.title}
                      <br />
                      <code>{item.runId}</code>
                    </p>
                    <p className="run-revision-meta">
                      <span>
                        {statuses[item.status] || item.status}
                        {item.archived ? ' · 已归档' : ''}
                      </span>
                      <span>创建时间：{item.createdAt}</span>
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      aria-describedby={readingId + '-revision-' + index}
                      disabled={!!opening}
                      onClick={() => void navigate(item.runId)}
                    >
                      {opening === item.runId ? '正在打开…' : '打开修订任务'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {revisions && !revisions.items.length && (
            <p className="field-help">{readPage.before ? '此页没有后续修订。' : '尚无后续修订。'}</p>
          )}
          {opening && <p role="status">正在打开所选任务…</p>}
          {Object.entries(errors).map(([key, message]) => (
            <div key={key} role="alert" className="run-revision-feedback">
              <strong>
                {key === 'lineage'
                  ? '来源链读取失败'
                  : key === 'revisions'
                    ? '后续修订读取失败'
                    : '所选任务打开失败'}
              </strong>
              <p
                role="region"
                aria-label={
                  (key === 'lineage' ? '来源链' : key === 'revisions' ? '后续修订' : '打开任务') + '问题全文'
                }
                tabIndex={0}
              >
                {message}
              </p>
            </div>
          ))}
          <nav className="run-revision-pagination" aria-label="后续修订分页与刷新">
            {revisions && (
              <p className="field-help">
                已读第 {readPage.index} 页 · 本页 {revisions.items.length} 条修订
              </p>
            )}
            <div className="workflow-actions">
              {!!trail.length && (
                <button
                  className="secondary"
                  type="button"
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
                  type="button"
                  disabled={loading || readPage.before !== before}
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
                type="button"
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
          </nav>
        </>
      )}
    </details>
  );
}
