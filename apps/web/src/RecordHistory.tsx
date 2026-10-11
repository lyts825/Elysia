import { useEffect, useState, type ReactNode } from 'react';
import type { RecordPage, ProjectionReadCoverage } from '../../../packages/contracts/src/run-reads';
import { useSurfaceClient } from './SurfaceClientContext';

type HistoryPage = { items: any[]; page: RecordPage; readCoverage?: ProjectionReadCoverage };

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
        {label} · {total} 条
      </summary>
      {open && (
        <>
          {error && (
            <p role="alert">
              {error}{' '}
              <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
                重试
              </button>
            </p>
          )}
          {page?.readCoverage && !page.readCoverage.complete && (
            <p className="field-error" role="status">
              另有 {page.readCoverage.unavailable} 条记录暂不可读取。此页仅显示可读取记录，完整结果仍未知。
            </p>
          )}
          <nav className="conversation-page-nav" aria-label={label + '分页'}>
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
            <span>{busy ? '读取中…' : `本页 ${page?.items.length ?? 0} 条`}</span>
          </nav>
          {page?.items.map((record) =>
            render ? (
              <div key={record.id}>{render(record)}</div>
            ) : (
              <RecordItem key={record.id} runId={runId} kind={kind} record={record} />
            ),
          )}
        </>
      )}
    </details>
  );
}
function RecordItem({ runId, kind, record }: { runId: string; kind: string; record: any }) {
  const { api } = useSurfaceClient();
  const [value, setValue] = useState<any>(null),
    [error, setError] = useState('');
  const [open, setOpen] = useState(false),
    [retry, setRetry] = useState(0);
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
        <span>{record.providerBinding?.model || record.name || record.id}</span>
        <small>{record.status}</small>
      </summary>
      {error && (
        <p role="alert">
          {error}{' '}
          <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
      <pre>
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
