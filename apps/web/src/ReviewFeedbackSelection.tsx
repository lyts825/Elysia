import { useEffect, useState } from 'react';
import type { DeliveryReview } from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import { readLocalReviewDraft, reviewCandidates } from './ReviewDraft';

export function ReviewFeedbackSelection({
  runId,
  feedback,
  change,
  disabled,
  localDraft,
}: {
  runId: string;
  feedback: string;
  change: (value: string) => void;
  disabled: boolean;
  localDraft?: unknown;
}) {
  const { api } = useSurfaceClient();
  const [value, setValue] = useState<DeliveryReview>(),
    [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState(''),
    [retry, setRetry] = useState(0),
    [reading, setReading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setReading(true);
    setValue(undefined);
    setSelected([]);
    void api<DeliveryReview>(`/runs/${runId}/delivery`, undefined, undefined, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setValue(next);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '复核备注读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
  }, [api, runId, retry]);
  const local = readLocalReviewDraft(localDraft);
  const items = value ? reviewCandidates(value.userReview, local, value.fingerprint) : [];
  const chosen = items.filter((item) => selected.includes(item.id));
  const addition = chosen
    .map(
      (item) =>
        `${item.origin}${item.stale ? ' · 旧版本' : ''} · ${item.title}（交付指纹 ${item.fingerprint || '未记录'}）\n${item.text ? '原标准：' + item.text + '\n' : ''}备注：${item.note}`,
    )
    .join('\n\n');
  const combined = [feedback.trim(), addition].filter(Boolean).join('\n\n');
  return (
    <details className="workflow-source" open={!!local}>
      <summary>选择复核备注（已保存／本机未保存／旧版本）</summary>
      <p className="field-help">
        仅将勾选内容加入修改意见，不会保存或改变复核结论。旧备注按当时的标准文字带入，不映射到当前项号。
      </p>
      {reading && <p role="status">正在核对来源交付版本…</p>}
      {error && (
        <p className="field-error" role="alert">
          {error} 来源版本尚未核对，备注草稿仍保留。
          <button type="button" onClick={() => setRetry((old) => old + 1)}>
            重试读取备注
          </button>
        </p>
      )}
      {!reading && !error && !items.length && <p className="field-help">当前没有可带入的复核备注。</p>}
      {items.map((item) => (
        <label className="check-label workflow-note-choice" key={item.id}>
          <input
            type="checkbox"
            checked={selected.includes(item.id)}
            disabled={disabled || reading || !!error}
            onChange={(event) =>
              setSelected((old) =>
                event.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id),
              )
            }
          />
          <span>
            <strong>
              {item.origin}
              {item.stale ? ' · 旧版本' : ' · 当前版本'} · {item.title}
            </strong>
            {item.text && <p className="workflow-prose">原标准：{item.text}</p>}
            <p className="workflow-prose">{item.note}</p>
            <small>交付指纹 {item.fingerprint ? item.fingerprint.slice(0, 12) : '未记录'}</small>
          </span>
        </label>
      ))}
      {!!chosen.length && (
        <section aria-label="所选复核备注预览">
          <strong>将加入修改意见的内容</strong>
          <p className="workflow-prose">{addition}</p>
        </section>
      )}
      {combined.length > 4000 && !!chosen.length && (
        <p className="field-error">加入后超过修改意见的 4000 字限制，请减少选择或精简已有意见。</p>
      )}
      <button
        type="button"
        className="secondary"
        disabled={disabled || reading || !!error || !chosen.length || combined.length > 4000}
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
