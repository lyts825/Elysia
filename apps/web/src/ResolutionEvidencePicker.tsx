import { useEffect, useState } from 'react';
import type {
  DeliveryEvidence,
  DeliveryEvidencePage,
  DeliveryReview,
} from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
export type ChosenEvidence = DeliveryEvidence & { index: number };
export function ResolutionEvidencePicker({
  delivery,
  criterion,
  selected,
  change,
  disabled,
}: {
  delivery: DeliveryReview;
  criterion: number;
  selected: ChosenEvidence[];
  change: (items: ChosenEvidence[]) => void;
  disabled: boolean;
}) {
  const { api } = useSurfaceClient();
  const [page, setPage] = useState<DeliveryEvidencePage>(),
    [offset, setOffset] = useState(0),
    [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    void api<DeliveryEvidencePage>(
      `/runs/${delivery.runId}/delivery/criteria/${criterion}/evidence?offset=${offset}&expectedRootRevision=${delivery.rootRevision}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        if (
          next.runId !== delivery.runId ||
          next.rootRevision !== delivery.rootRevision ||
          next.runRevision !== delivery.runRevision ||
          next.criterion !== criterion ||
          next.page.offset !== offset
        )
          throw Error('证据版本已变化，请重新读取交付后再选；原草稿保持不变。');
        setPage(next);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '证据读取失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [api, delivery.runId, delivery.rootRevision, delivery.runRevision, criterion, offset, retry]);
  return (
    <fieldset disabled={disabled || busy}>
      <legend>手动选择已登记证据（最多 10 条）</legend>
      {page?.evidence.map((item, i) => {
        const index = page.page.offset + i,
          checked = selected.some((e) => e.index === index);
        return (
          <label className="workflow-note-choice" key={index}>
            <input
              type="checkbox"
              checked={checked}
              disabled={!!error || (!checked && selected.length >= 10)}
              onChange={() =>
                change(
                  checked ? selected.filter((e) => e.index !== index) : [...selected, { ...item, index }],
                )
              }
            />
            <span>
              {item.type} · {item.note || item.ref}
              <br />
              <small>
                {item.ref}
                {item.hash ? ` · SHA256 ${item.hash.slice(0, 12)}` : ''}
              </small>
            </span>
          </label>
        );
      })}
      {page && !page.page.total && (
        <p className="field-help">当前验收项尚无登记证据；可保留待复验或说明判断依据。</p>
      )}
      {page && (
        <div className="workflow-actions">
          <button
            type="button"
            className="secondary"
            disabled={!page.page.offset || !!error}
            onClick={() => setOffset(Math.max(0, page.page.offset - page.page.limit))}
          >
            上一页证据
          </button>
          <span>{page.page.total} 条证据</span>
          <button
            type="button"
            className="secondary"
            disabled={!page.page.hasMore || !!error}
            onClick={() => setOffset(page.page.nextOffset!)}
          >
            下一页证据
          </button>
        </div>
      )}
      {busy && <p role="status">正在读取证据…</p>}
      {error && (
        <p role="alert" className="field-error">
          {error}{' '}
          <button type="button" className="secondary" onClick={() => setRetry((n) => n + 1)}>
            重试证据
          </button>
        </p>
      )}
      {!!selected.length && (
        <p className="field-help">已手选 {selected.length} 条；保存时将核对并冻结证据引用。</p>
      )}
    </fieldset>
  );
}
