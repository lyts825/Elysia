import { useId } from 'react';
import { ApiError, type SurfaceClient } from './api';
import './delivery-read-progress.css';

export type DeliveryWarmProgress = {
  jobId: string;
  runId?: string;
  projectId?: string;
  status: 'warming' | 'completed' | 'cancelled' | 'failed';
  scanned: number;
  total: number;
  backfilled: number;
  completedRuns?: number;
  totalRuns?: number;
  unavailableRuns?: number;
  error?: { code: string; message: string };
};
type Target = { kind: 'run' | 'project'; id: string };
const baseFor = (target: Target) =>
  target.kind === 'run'
    ? `/runs/${target.id}/delivery/artifact-warm`
    : `/projects/${target.id}/delivery/artifact-warm`;

/** A reader owns one subscription; cancelling it never selects another window's latest job. */
export async function prepareDeliveryRead(
  api: SurfaceClient['api'],
  target: Target,
  signal: AbortSignal,
  update: (progress: DeliveryWarmProgress) => void,
) {
  signal.throwIfAborted();
  const base = baseFor(target),
    jobId = crypto.randomUUID();
  let completed = false,
    cancellation: Promise<unknown> | undefined;
  // Let creation settle before DELETE, including when the reader closes during POST.
  const creation = api<DeliveryWarmProgress>(base, { jobId }, 'POST', AbortSignal.timeout(15_000));
  const cancel = () => {
    cancellation ??= creation
      .catch(() => undefined)
      .then(() => api(base + '/' + jobId, {}, 'DELETE', AbortSignal.timeout(15_000)).catch(() => undefined));
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let progress = await creation;
    for (;;) {
      signal.throwIfAborted();
      if (
        progress.jobId !== jobId ||
        (target.kind === 'run' ? progress.runId !== target.id : progress.projectId !== target.id)
      )
        throw Error('读取准备结果不属于当前页面，请重试。');
      update(progress);
      if (progress.status === 'completed') {
        completed = true;
        return;
      }
      if (progress.status !== 'warming')
        throw new ApiError(
          progress.error?.message || '本次读取准备已取消，请重新读取。',
          'http',
          progress.error?.code === 'DELIVERY_CHANGED' ? 409 : 422,
          progress.error?.code,
        );
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', stop);
          resolve();
        }, 200);
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      });
      progress = await api<DeliveryWarmProgress>(base + '/' + jobId, undefined, undefined, signal);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!completed) cancel();
  }
}

export function DeliveryReadProgress({
  progress,
  cancel,
  label = '交付读取',
}: {
  progress?: DeliveryWarmProgress;
  cancel: () => void;
  label?: string;
}) {
  const helpId = useId();
  return (
    <div
      className="delivery-read-progress"
      data-state={progress?.status || 'starting'}
      aria-label={label + '准备进度'}
    >
      <h3 className="delivery-read-title" tabIndex={0}>
        {label}
      </h3>
      <p className="delivery-read-state" role={progress?.status === 'failed' ? 'alert' : 'status'}>
        {progress?.status === 'warming'
          ? '正在准备读取…'
          : progress?.status === 'completed'
            ? '准备步骤已结束，正在读取内容…'
            : progress?.status === 'failed'
              ? '读取准备未完成，请核对问题后重新读取。'
              : progress?.status === 'cancelled'
                ? '本次读取准备已取消，已处理的记录仍保留。'
                : '正在开始准备读取…'}
      </p>
      {progress && (
        <dl className="delivery-read-counts">
          <div>
            <dt>已处理产物记录</dt>
            <dd>
              {progress.scanned.toLocaleString()} / {progress.total.toLocaleString()} 份
            </dd>
          </div>
          {progress.totalRuns !== undefined && (
            <div>
              <dt>已处理任务</dt>
              <dd>
                {progress.completedRuns ?? 0} / {progress.totalRuns} 个
              </dd>
            </div>
          )}
        </dl>
      )}
      {progress?.status === 'warming' && (
        <progress
          aria-label={label + '已处理产物记录'}
          max={Math.max(1, progress.total)}
          value={Math.min(progress.scanned, progress.total)}
        />
      )}
      {progress?.status === 'failed' && progress.error?.message && (
        <p className="delivery-read-error" role="region" aria-label="交付读取准备错误全文" tabIndex={0}>
          {progress.error.message}
        </p>
      )}
      <p className="field-help" id={helpId}>
        取消只停止本窗口的读取准备。已处理的记录和历史内容保留，不代表交付已经通过验收。
      </p>
      {!!progress?.unavailableRuns && (
        <p className="field-help delivery-read-gap">
          有 {progress.unavailableRuns} 个任务暂不可读，项目状态将保留读取缺口。
        </p>
      )}
      <button type="button" className="secondary" aria-describedby={helpId} onClick={cancel}>
        取消本次读取
      </button>
    </div>
  );
}
