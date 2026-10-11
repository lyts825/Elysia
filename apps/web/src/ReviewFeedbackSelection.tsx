import { useEffect, useState } from 'react';
import type { DeliveryReview } from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';

export function ReviewFeedbackSelection({
  runId,
  feedback,
  change,
  disabled,
}: {
  runId: string;
  feedback: string;
  change: (value: string) => void;
  disabled: boolean;
}) {
  const { api } = useSurfaceClient();
  const [value, setValue] = useState<DeliveryReview>(),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<DeliveryReview>(`/runs/${runId}/delivery`, undefined, undefined, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setValue(next);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '复核备注读取失败');
      });
    return () => controller.abort();
  }, [api, runId, retry]);
  const review = value?.userReview;
  const items = review
    ? [
        ...(review.note ? [{ id: 'summary', title: '整体备注', text: review.note }] : []),
        ...review.criteriaNotes.map((note) => ({
          id: String(note.index),
          title: `第 ${note.index + 1} 项复核备注`,
          text: note.note,
        })),
      ]
    : [];
  const chosen = items.filter((item) => selected.includes(item.id));
  const addition = chosen.length
    ? `用户复核备注（交付指纹 ${review!.fingerprint}）：\n${chosen.map((item) => item.title + '：' + item.text).join('\n')}`
    : '';
  const combined = [feedback.trim(), addition].filter(Boolean).join('\n\n');
  if (!items.length && !error) return null;
  return (
    <details className="workflow-source">
      <summary>选择已保存的复核备注</summary>
      {error && (
        <p className="field-error" role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((old) => old + 1)}>
            重试读取备注
          </button>
        </p>
      )}
      {review?.stale && <p className="field-help">这些备注属于旧交付版本，请核对后选择带入。</p>}
      {items.map((item) => (
        <label className="check-label" key={item.id}>
          <input
            type="checkbox"
            checked={selected.includes(item.id)}
            disabled={disabled}
            onChange={(event) =>
              setSelected((old) =>
                event.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id),
              )
            }
          />
          <span>
            {item.title}
            <p className="workflow-prose">{item.text}</p>
          </span>
        </label>
      ))}
      {combined.length > 4000 && chosen.length > 0 && (
        <p className="field-error">加入后超过修改意见的 4000 字限制，请减少选择或精简已有意见。</p>
      )}
      <button
        type="button"
        className="secondary"
        disabled={disabled || !chosen.length || combined.length > 4000}
        onClick={() => {
          change(combined);
          setSelected([]);
        }}
      >
        将所选备注加入修改意见
      </button>
    </details>
  );
}
