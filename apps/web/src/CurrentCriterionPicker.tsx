import { useEffect, useState } from 'react';
import type { DeliveryCriterion, DeliveryReview } from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';

export function CurrentCriterionPicker({
  initial,
  selected,
  select,
  disabled = false,
  overall = false,
}: {
  initial: DeliveryReview;
  selected: number | null | undefined;
  select: (criterion: DeliveryCriterion | null) => void;
  disabled?: boolean;
  overall?: boolean;
}) {
  const { api } = useSurfaceClient();
  const [page, setPage] = useState(initial),
    [offset, setOffset] = useState(initial.criteriaPage.offset);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    if (offset === initial.criteriaPage.offset && !retry) {
      setPage(initial);
      setBusy(false);
      setError('');
      return;
    }
    setBusy(true);
    setError('');
    void api<DeliveryReview>(
      `/runs/${initial.runId}/delivery?criteriaOffset=${offset}&expectedRootRevision=${initial.rootRevision}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        if (
          next.runId !== initial.runId ||
          next.fingerprint !== initial.fingerprint ||
          next.rootRevision !== initial.rootRevision ||
          next.criteriaPage.offset !== offset
        )
          throw Error('交付版本已变化，请重新读取后选择；草稿保持不变。');
        setPage(next);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '验收项读取失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [api, initial, offset, retry]);
  return (
    <fieldset disabled={disabled || busy}>
      <legend>手动选择当前验收项</legend>
      {overall && (
        <label className="workflow-note-choice">
          <input type="radio" checked={selected === null} onChange={() => select(null)} />
          <span>整体备注（不关联单项）</span>
        </label>
      )}
      {page.criteria.map((item) => (
        <label className="workflow-note-choice" key={item.index}>
          <input
            type="radio"
            checked={selected === item.index}
            disabled={!!error}
            onChange={() => select(item)}
          />
          <span>
            第 {item.index + 1} 项 · {item.text}
          </span>
        </label>
      ))}
      <div className="workflow-actions">
        <span>
          {page.criteriaPage.offset + 1}–{page.criteriaPage.offset + page.criteria.length} /{' '}
          {page.criteriaPage.total} 项
        </span>
        <button
          type="button"
          className="text-button"
          disabled={!page.criteriaPage.offset || !!error}
          onClick={() => setOffset(Math.max(0, page.criteriaPage.offset - page.criteriaPage.limit))}
        >
          上一页标准
        </button>
        <button
          type="button"
          className="text-button"
          disabled={!page.criteriaPage.hasMore || !!error}
          onClick={() => setOffset(page.criteriaPage.nextOffset!)}
        >
          下一页标准
        </button>
      </div>
      {busy && <p role="status">正在读取验收项…</p>}
      {error && (
        <p role="alert" className="field-error">
          {error}{' '}
          <button type="button" className="secondary" onClick={() => setRetry((n) => n + 1)}>
            重试这一页
          </button>
        </p>
      )}
    </fieldset>
  );
}
