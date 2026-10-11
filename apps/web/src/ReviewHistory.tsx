import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  DeliveryReviewHistory,
  DeliveryReviewHistoryDetail,
} from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import { ReviewRecord } from './ReviewRecord';

export function ReviewHistory({
  runId,
  version,
  renderNotes,
}: {
  runId: string;
  version: number;
  renderNotes?: (value: DeliveryReviewHistoryDetail) => ReactNode;
}) {
  const { api } = useSurfaceClient();
  const [open, setOpen] = useState(false),
    [before, setBefore] = useState(''),
    [trail, setTrail] = useState<string[]>([]),
    [retry, setRetry] = useState(0);
  const [page, setPage] = useState<DeliveryReviewHistory>(),
    [detail, setDetail] = useState<DeliveryReviewHistoryDetail>();
  const [loading, setLoading] = useState(false),
    [opening, setOpening] = useState(''),
    [error, setError] = useState('');
  const detailRequest = useRef<AbortController | null>(null);
  const visiblePage = page?.runId === runId ? page : undefined;
  const visibleDetail = detail?.runId === runId ? detail : undefined;
  useEffect(() => {
    setDetail(undefined);
    setOpening('');
    return () => {
      detailRequest.current?.abort();
      detailRequest.current = null;
    };
  }, [runId, version, open, before, retry]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<DeliveryReviewHistory>(
      `/runs/${runId}/delivery/reviews${before ? '?before=' + encodeURIComponent(before) : ''}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setPage(value);
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setError(issue instanceof Error ? issue.message : '复核历史读取失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, runId, version, open, before, retry]);
  async function read(id: string) {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setOpening(id);
    setDetail(undefined);
    setError('');
    try {
      const next = await api<DeliveryReviewHistoryDetail>(
        `/runs/${runId}/delivery/reviews/${id}`,
        undefined,
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) setDetail(next);
    } catch (issue) {
      if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '历史复核读取失败。');
    } finally {
      if (!controller.signal.aborted) {
        setOpening('');
        detailRequest.current = null;
      }
    }
  }
  return (
    <details className="workflow-source" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>复核历史</summary>
      {open && (
        <>
          <p className="field-help">历史记录只读，查看或选择备注不会替换当前复核结论。</p>
          {visiblePage?.coverage && (
            <p className="field-help">
              历史记录从 {visiblePage.coverage.sinceVersion} 开始保留。
              {visiblePage.coverage.possibleGaps
                ? '更早版本只可能保留当时最后一份复核快照，不能代表完整历史。'
                : ''}
            </p>
          )}
          {visiblePage?.items.map((item) => (
            <button
              type="button"
              className="workflow-history-row"
              key={item.id}
              disabled={!!opening}
              onClick={() => void read(item.id)}
            >
              <strong>
                {item.decision === 'accepted' ? '已采纳' : '需修改'} · {item.reviewedAt}
              </strong>
              <span>
                {item.origin === 'legacy_snapshot' ? '旧版最后结论快照' : '已保存复核'} ·{' '}
                {item.criteriaNotesCount} 条逐项备注
              </span>
              {!!item.notePreview && <span>{item.notePreview}</span>}
            </button>
          ))}
          {visiblePage && !visiblePage.items.length && <p className="field-help">暂无已保存复核历史。</p>}
          {loading && <p role="status">正在读取复核历史…</p>}
          {opening && <p role="status">正在读取所选复核…</p>}
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <div className="workflow-actions">
            {!!trail.length && (
              <button
                type="button"
                className="secondary"
                disabled={loading}
                onClick={() => {
                  setBefore(trail.at(-1)!);
                  setTrail((old) => old.slice(0, -1));
                }}
              >
                上一页复核
              </button>
            )}
            {visiblePage?.page.hasMore && (
              <button
                type="button"
                className="secondary"
                disabled={loading}
                onClick={() => {
                  setTrail((old) => [...old, before]);
                  setBefore(visiblePage.page.nextBefore!);
                }}
              >
                下一页复核
              </button>
            )}
            <button
              type="button"
              className="text-button"
              disabled={loading}
              onClick={() => {
                setBefore('');
                setTrail([]);
                setRetry((old) => old + 1);
              }}
            >
              刷新复核历史
            </button>
          </div>
          {visibleDetail && (
            <ReviewRecord
              value={visibleDetail}
              renderNotes={renderNotes}
              reload={() => void read(visibleDetail.item.id)}
              reading={!!opening}
            />
          )}
        </>
      )}
    </details>
  );
}
