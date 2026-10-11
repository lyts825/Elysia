import { useEffect, useState } from 'react';
import type { DeliveryReviewSummary } from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import { reviewStatusLabels } from './ReviewStatus';
import { Icon } from './Icon';
import './workflow.css';

export function DeliveryStatusCard({
  runId,
  version,
  open,
}: {
  runId: string;
  version: string;
  open: () => void;
}) {
  const { api } = useSurfaceClient();
  const [snapshot, setSnapshot] = useState<{ version: string; value: DeliveryReviewSummary }>();
  const [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const value = snapshot?.version === version ? snapshot.value : undefined;
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    setError('');
    const read = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const next = await api<DeliveryReviewSummary>(
          `/runs/${runId}/delivery/summary`,
          undefined,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setSnapshot({ version, value: next });
          setError('');
        }
      } catch (issue) {
        if (!controller.signal.aborted) {
          setSnapshot(undefined);
          setError(issue instanceof Error ? issue.message : '复核状态无法读取');
        }
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, runId, version, retry]);
  return (
    <div
      className="delivery-card"
      data-review-status={value?.reviewStatus || 'unknown'}
      aria-label="交付复核状态"
    >
      <Icon name="check" size={24} />
      <div>
        <h3>
          执行已完成 ·{' '}
          {value?.reviewStatus
            ? `用户复核：${reviewStatusLabels[value.reviewStatus]}`
            : error
              ? '复核状态暂不可读'
              : value
                ? '当前任务不适用人工复核'
                : '正在读取复核状态…'}
        </h3>
        <p>
          {value?.reviewStatus === 'stale'
            ? '交付内容已变化，原结论不再适用，请重新核对。'
            : value?.reviewStatus === 'changes_requested'
              ? '复核已记录需修改，可查看意见后建立后续修订。'
              : '执行完成与用户采纳分别记录，请按验收项核对交付。'}
        </p>
        {error && (
          <p className="field-error" role="alert">
            {error}{' '}
            <button className="text-button" onClick={() => setRetry((v) => v + 1)}>
              重试读取复核状态
            </button>
          </p>
        )}
        <button className="text-button" onClick={open}>
          逐项查看交付与验收
        </button>
      </div>
    </div>
  );
}
