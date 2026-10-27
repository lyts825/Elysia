/**
 * 展示记录历史。
 * 分页呈现运行相关历史记录和原文阅读入口，保留截断、失败和重试状态；不据有限窗口推断缺失事件。
 * EN: Displays request, operation, and artifact history. Presents paginated run history and raw-record reading with truncation/failure/retry feedback, without inferring events missing from a bounded window.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { RecordPage, ProjectionReadCoverage } from '../../../packages/contracts/src/run-reads';
import { useSurfaceClient } from './SurfaceClientContext';
import './record-history.css';

type HistoryPage = { items: any[]; page: RecordPage; readCoverage?: ProjectionReadCoverage };

/**
 * 请求/操作/产物的按需历史列表，before 游标配合 trail 支持返回上一页。
 * 外部版本或总数变化触发当前页重读；readCoverage 另行展示无法读取记录，不把可读页当作全集。
 * EN: Lazy history uses before/trail for back navigation. Version/total changes reread current page. readCoverage separately shows unreadable gaps; a readable page is not the whole set.
 */
export function RecordHistory({
  runId,
  kind,
  label,
  version,
  total,
  render,
}: {
  runId: string;
  kind: 'requests' | 'operations' | 'artifacts';
  label: string;
  version: number | string;
  total: number;
  render?: (record: any) => ReactNode;
}) {
  const { api } = useSurfaceClient();
  /**
   * 历史分页按运行、记录类型和版本管理；展开后才读取。
   * EN: Track history paging by run/type/version and read only after expansion.
   */
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [before, setBefore] = useState(''),
    [trail, setTrail] = useState<string[]>([]),
    [error, setError] = useState('');
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setBefore('');
    setTrail([]);
    setPage(null);
  }, [runId, kind]);
  useEffect(() => setPage(null), [before]);
  useEffect(() => {
    if (!open) return;
    const request = new AbortController();
    setBusy(true);
    setError('');
    void api<HistoryPage>(
      `/runs/${runId}/records/${kind}?limit=40${before ? '&before=' + encodeURIComponent(before) : ''}`,
      undefined,
      undefined,
      request.signal,
    )
      .then((value) => {
        if (!request.signal.aborted) setPage(value);
      })
      .catch((issue) => {
        if (!request.signal.aborted) setError(issue instanceof Error ? issue.message : '读取失败');
      })
      .finally(() => {
        if (!request.signal.aborted) setBusy(false);
      });
    return () => request.abort();
  }, [runId, kind, before, open, version, total, api, retry]);
  return (
    <details className="record-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{label}</span>
        <small>共 {total} 条</small>
      </summary>
      {open && (
        <>
          {error && (
            <div className="record-history-feedback" role="alert">
              <p role="region" aria-label={label + '读取问题全文'} tabIndex={0}>
                {error}
              </p>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setRetry((value) => value + 1)}
              >
                重试
              </button>
            </div>
          )}
          {page?.readCoverage && !page.readCoverage.complete && (
            <p className="field-error" role="status">
              另有 {page.readCoverage.unavailable} 条记录暂不可读取。此页仅显示可读取记录，完整结果仍未知。
            </p>
          )}
          <nav className="record-history-pagination" aria-label={label + '分页'}>
            <p role="status">
              第 {trail.length + 1} 页 · {busy ? '读取中…' : `本页 ${page?.items.length ?? 0} 条`}
            </p>
            <div>
              <button
                className="secondary"
                type="button"
                disabled={busy || !trail.length}
                onClick={() => {
                  const prior = [...trail];
                  setBefore(prior.pop()!);
                  setTrail(prior);
                }}
              >
                更新记录
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy || !page?.page.hasMore}
                onClick={() => {
                  setTrail([...trail, before]);
                  setBefore(page!.page.nextBefore!);
                }}
              >
                更早记录
              </button>
              <button
                className="text-button"
                type="button"
                disabled={busy || !before}
                onClick={() => {
                  setBefore('');
                  setTrail([]);
                }}
              >
                返回最新
              </button>
            </div>
          </nav>
          {page && !page.items.length && !busy && <p className="field-help">此页暂无可读取记录。</p>}
          {!!page?.items.length && (
            <div className="record-history-list" role="region" aria-label={label + '本页记录'} tabIndex={0}>
              {page.items.map((record) =>
                render ? (
                  <div className="record-history-custom" key={record.id}>
                    {render(record)}
                  </div>
                ) : (
                  <RecordItem key={record.id} runId={runId} kind={kind} record={record} />
                ),
              )}
            </div>
          )}
        </>
      )}
    </details>
  );
}
/**
 * 展开时才读取完整记录，记录修订变化清空旧正文；读取失败仍保留上层已有摘要。
 * EN: Read full record on expansion; revision changes clear old body. Failed reads retain parent summary.
 */
function RecordItem({ runId, kind, record }: { runId: string; kind: string; record: any }) {
  const { api } = useSurfaceClient();
  const [value, setValue] = useState<any>(null),
    [error, setError] = useState('');
  const [open, setOpen] = useState(false),
    [retry, setRetry] = useState(0);
  const title = record.providerBinding?.model || record.name || record.id;
  useEffect(() => {
    setValue(null);
  }, [record.id, record.revision]);
  useEffect(() => {
    if (!open) return;
    const request = new AbortController();
    setError('');
    void api<any>(`/runs/${runId}/records/${kind}/${record.id}`, undefined, undefined, request.signal)
      .then((data) => {
        if (!request.signal.aborted) setValue(data);
      })
      .catch((issue) => {
        if (!request.signal.aborted) setError(issue instanceof Error ? issue.message : '读取失败');
      });
    return () => request.abort();
  }, [open, runId, kind, record.id, record.revision, retry, api]);
  return (
    <details
      className="request-detail"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="record-history-name">{title}</span>
        <small>{record.status}</small>
      </summary>
      <p className="record-history-identity" role="region" aria-label="记录完整标识" tabIndex={0}>
        {title}
        {title !== record.id && (
          <>
            <br />
            {record.id}
          </>
        )}
      </p>
      {error && (
        <div className="record-history-feedback" role="alert">
          <p role="region" aria-label="完整记录读取问题全文" tabIndex={0}>
            {error}
          </p>
          <button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </div>
      )}
      <pre role="region" aria-label="完整记录正文" tabIndex={0}>
        {value
          ? JSON.stringify(
              kind === 'requests'
                ? { requestId: value.id, manifest: value.manifest, usage: value.usage, error: value.error }
                : value,
              null,
              2,
            )
          : error
            ? '完整记录暂不可读，已读摘要仍保留。'
            : '正在读取完整记录…'}
      </pre>
    </details>
  );
}
