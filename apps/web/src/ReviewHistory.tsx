/* 展示交付评审历史。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  DeliveryReviewHistory,
  DeliveryReviewHistoryDetail,
} from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import { ReviewRecord } from './ReviewRecord';
import { DeliveryReadProgress, prepareDeliveryRead, type DeliveryWarmProgress } from './DeliveryReadProgress';
import './review-history.css';

/**
 * 懒读取人工复核历史，列表游标与所选详情分别保存；version 变化刷新列表并取消旧详情读取。
 * renderNotes 可把只读记录嵌入来源选择流程，查看历史本身不替换当前复核或草稿。
 */
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
  // 列表分页和单条详情分别读取；切换详情时取消先前的在途请求。
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
  const selectedDetail = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState<DeliveryWarmProgress>();
  const visiblePage = page?.runId === runId ? page : undefined;
  const visibleDetail = detail?.runId === runId ? detail : undefined;
  useEffect(() => {
    setDetail(undefined);
    setOpening('');
    setProgress(undefined);
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
  /** 先取消此前所选详情，准备交付读模型后读取新记录；失败保留上次已读详情供参考。 */
  async function read(id: string) {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setOpening(id);
    setProgress(undefined);
    setError('');
    try {
      await prepareDeliveryRead(api, { kind: 'run', id: runId }, controller.signal, setProgress);
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
        setProgress(undefined);
        detailRequest.current = null;
      }
    }
  }
  return (
    <details
      className="workflow-source review-history"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
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
          {!!visiblePage?.items.length && (
            <div className="review-history-list" role="region" aria-label="复核历史列表" tabIndex={0}>
              {visiblePage.items.map((item) => (
                <button
                  type="button"
                  className="workflow-history-row"
                  key={item.id}
                  aria-current={visibleDetail?.item.id === item.id ? 'true' : undefined}
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
                  {visibleDetail?.item.id === item.id && (
                    <span className="review-history-current">当前已读</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {visiblePage && !visiblePage.items.length && <p className="field-help">暂无已保存复核历史。</p>}
          {loading && <p role="status">正在读取复核历史…</p>}
          {opening && (
            <DeliveryReadProgress
              label="所选复核"
              progress={progress}
              cancel={() => {
                detailRequest.current?.abort();
                detailRequest.current = null;
                setOpening('');
                setProgress(undefined);
                setError('本次复核读取已取消，已读历史内容保留。可再次选择复核记录。');
              }}
            />
          )}
          {opening && visibleDetail && (
            <p className="field-help">下方保留上次读取的复核，所选记录尚未完成读取。</p>
          )}
          {error && (
            <p
              role="alert"
              className="field-error review-history-error"
              aria-label="复核历史读取问题全文"
              tabIndex={0}
            >
              {error}
            </p>
          )}
          <nav className="workflow-pagination" aria-label="复核历史翻页">
            {visiblePage && (
              <span className="workflow-pagination-summary">已读列表 {visiblePage.items.length} 条</span>
            )}
            <div className="workflow-pagination-actions">
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
          </nav>
          {visibleDetail && (
            <button
              type="button"
              className="secondary review-history-jump"
              onClick={() => {
                selectedDetail.current?.focus({ preventScroll: true });
                selectedDetail.current?.scrollIntoView({ block: 'start' });
              }}
            >
              定位已读复核
            </button>
          )}
          {visibleDetail && (
            <div
              className="review-history-selected"
              ref={selectedDetail}
              role="region"
              aria-label="已读复核详情"
              tabIndex={-1}
            >
              <ReviewRecord
                value={visibleDetail}
                renderNotes={renderNotes}
                reload={() => void read(visibleDetail.item.id)}
                reading={!!opening}
              />
            </div>
          )}
        </>
      )}
    </details>
  );
}
