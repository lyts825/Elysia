/** 按消息展示原生收件状态；读回失败保留上次结果，分页成功后才推进位置。
 * EN: Displays per-message native receipts; failed reads preserve the previous page and position.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  NativeInboxReceipt,
  NativeInboxReceiptDetail,
  NativeInboxReceiptPage,
} from '../../../packages/contracts/src/inbox-receipts';
import { useSurfaceClient } from './SurfaceClientContext';
import './native-inbox-receipts.css';

function Receipt({ runId, item }: { runId: string; item: NativeInboxReceipt }) {
  const { api } = useSurfaceClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open || !item.truncated) return;
    const controller = new AbortController();
    setText(undefined);
    setError('');
    void api<NativeInboxReceiptDetail>(
      `/runs/${runId}/inbox-receipts/${item.id}`,
      undefined,
      'GET',
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setText(value.text);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '消息读取失败');
      });
    return () => controller.abort();
  }, [api, runId, item.id, item.revision, item.truncated, open, retry]);
  return (
    <li>
      <div className="inbox-receipt-heading">
        <strong>
          {item.status === 'applied'
            ? '已加入上下文'
            : item.status === 'dismissed'
              ? '已结束处理'
              : '已保存，等待应用'}
        </strong>
        <time dateTime={item.receivedAt}>{new Date(item.receivedAt).toLocaleString()}</time>
        {item.intent === 'replan' && <span>重新规划</span>}
      </div>
      <p className="field-help">{item.reason}</p>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>查看消息{item.truncated && !open ? '（长文按需读取）' : ''}</summary>
        {error ? (
          <div className="inbox-receipt-error" role="alert">
            <p>{error}</p>
            <button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>
              重试读取
            </button>
          </div>
        ) : (
          <pre tabIndex={0} aria-label="补充消息原文">
            {item.truncated ? (text ?? '正在读取原文…') : item.preview}
          </pre>
        )}
      </details>
    </li>
  );
}

export function NativeInboxReceipts({ runId }: { runId: string }) {
  const { api } = useSurfaceClient();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<NativeInboxReceiptPage>();
  const [before, setBefore] = useState<string>();
  const [trail, setTrail] = useState<(string | undefined)[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const current = useRef<{ controller: AbortController; target?: string } | undefined>(undefined);
  const cursor = useRef(before);
  cursor.current = before;

  const read = async (target: string | undefined, navigation?: 'next' | 'previous' | 'latest') => {
    current.current?.controller.abort();
    const request = { controller: new AbortController(), target };
    current.current = request;
    setLoading(true);
    try {
      const value = await api<NativeInboxReceiptPage>(
        `/runs/${runId}/inbox-receipts${target ? '?before=' + encodeURIComponent(target) : ''}`,
        undefined,
        'GET',
        request.controller.signal,
      );
      if (request.controller.signal.aborted || current.current !== request) return;
      if (navigation === 'next') setTrail((values) => [...values, cursor.current]);
      else if (navigation === 'previous') setTrail((values) => values.slice(0, -1));
      else if (navigation === 'latest') setTrail([]);
      setBefore(target);
      setResult(value);
      setError('');
    } catch (issue) {
      if (!request.controller.signal.aborted && current.current === request)
        setError(issue instanceof Error ? issue.message : '消息状态读取失败，保留上次已读内容。');
    } finally {
      if (!request.controller.signal.aborted && current.current === request) {
        current.current = undefined;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    if (!open) return;
    void read(cursor.current);
    const timer = setInterval(() => {
      if (!current.current) void read(cursor.current);
    }, 5000);
    return () => {
      clearInterval(timer);
      current.current?.controller.abort();
      current.current = undefined;
    };
  }, [api, runId, open, refresh]);

  return (
    <details
      className="native-inbox-receipts"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>补充消息状态{result ? ` · 待应用 ${result.pending}` : ''}</summary>
      <p className="field-help">加入上下文表示执行器已保存这条消息，不代表模型已读或工作已完成。</p>
      {error && (
        <div className="inbox-receipt-error" role="alert">
          <p>
            {error}
            {result ? ' 当前显示上次已读状态。' : ''}
          </p>
          <button type="button" className="secondary" onClick={() => setRefresh((value) => value + 1)}>
            重试
          </button>
        </div>
      )}
      {result && !result.coverage.complete && (
        <p className="inbox-receipt-error" role="status">
          本页有 {result.coverage.unavailable} 条记录无法核验，不能据此判断全部消息已处理。
        </p>
      )}
      {!result && loading && <p role="status">正在读取消息状态…</p>}
      {result && (
        <>
          <p className="field-help">
            共 {result.total} 条，当前已读 {result.items.length} 条。状态读取于{' '}
            {new Date(result.capturedAt).toLocaleTimeString()}。
          </p>
          {!result.total && <p>尚无补充消息。</p>}
          <ol className="inbox-receipt-list">
            {result.items.map((item) => (
              <Receipt key={item.id} runId={runId} item={item} />
            ))}
          </ol>
          <div className="inbox-receipt-pages">
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => void read(undefined, 'latest')}
            >
              最新消息
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading || !trail.length}
              onClick={() => void read(trail.at(-1), 'previous')}
            >
              上一页
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading || !result.page.hasMore}
              onClick={() => void read(result.page.nextBefore ?? undefined, 'next')}
            >
              更早消息
            </button>
          </div>
        </>
      )}
    </details>
  );
}
