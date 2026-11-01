/** 后台命令的启动回执、进程结束与副作用核验分开展示，失败读回不清空既有结果。 */
import { useEffect, useRef, useState } from 'react';
import type { BackgroundJob, BackgroundJobSummary } from '../../../packages/contracts/src/background-jobs';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import './native-inbox-receipts.css';

type JobPage = { jobs: BackgroundJobSummary[]; nextBefore: string | null; hasMore: boolean; total: number };
const statusLabels: Record<BackgroundJobSummary['status'], string> = {
  RUNNING: '命令运行中',
  SUCCEEDED: '命令成功退出',
  FAILED: '命令失败',
  UNCERTAIN: '结果待核验',
  RESOLVED: '已人工核验',
};
function JobDetails({ runId, job }: { runId: string; job: BackgroundJobSummary }) {
  const { api } = useSurfaceClient();
  const [open, setOpen] = useState(false),
    [value, setValue] = useState<BackgroundJob>(),
    [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<BackgroundJob>(`/runs/${runId}/jobs/${job.id}`, undefined, 'GET', controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setValue(next);
          setError('');
        }
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '读取失败');
      });
    return () => controller.abort();
  }, [api, runId, job.id, job.revision, open, retry]);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>命令与结果</summary>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((v) => v + 1)}>
            重试读取
          </button>
        </p>
      )}
      {value && (
        <>
          <pre tabIndex={0}>{JSON.stringify(value.command, null, 2)}</pre>
          {value.result ? (
            <>
              <p>
                退出码：{value.result.exitCode ?? '未知'}
                {value.result.timedOut ? ' · 已超时' : ''}
                {value.result.truncated ? ' · 输出已截断' : ''}
              </p>
              <pre tabIndex={0} aria-label="命令输出">
                {value.result.stdout || '无标准输出'}
                {value.result.stderr ? '\n错误输出：\n' + value.result.stderr : ''}
              </pre>
            </>
          ) : (
            <p>尚无已保存的最终输出。</p>
          )}
        </>
      )}
    </details>
  );
}

export function BackgroundJobs({
  runId,
  revision,
  disabledReason,
  verify,
}: {
  runId: string;
  revision: number;
  disabledReason: string;
  verify: (operationId: string) => void;
}) {
  const { api, mutation } = useSurfaceClient();
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<JobPage>();
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [before, setBefore] = useState<string>(),
    [trail, setTrail] = useState<(string | undefined)[]>([]);
  const cursor = useRef(before);
  cursor.current = before;
  const active = useRef<AbortController | undefined>(undefined);
  const cancellation = useRef<{ jobId: string; commandId: string; expectedRevision: number } | undefined>(
    undefined,
  );
  const read = async (target: string | undefined, direction?: 'next' | 'previous' | 'latest') => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    try {
      const value = await api<JobPage>(
        `/runs/${runId}/jobs${target ? '?before=' + encodeURIComponent(target) : ''}`,
        undefined,
        'GET',
        controller.signal,
      );
      if (controller.signal.aborted || active.current !== controller) return;
      if (direction === 'next') setTrail((items) => [...items, cursor.current]);
      if (direction === 'previous') setTrail((items) => items.slice(0, -1));
      if (direction === 'latest') setTrail([]);
      setBefore(target);
      setPage(value);
      setError('');
    } catch (issue) {
      if (!controller.signal.aborted)
        setError(issue instanceof Error ? issue.message : '读取失败，保留上次作业状态。');
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    if (!open) return;
    void read(cursor.current);
    const timer = setInterval(() => {
      if (!active.current) void read(cursor.current);
    }, 3000);
    return () => {
      clearInterval(timer);
      active.current?.abort();
      active.current = undefined;
    };
  }, [api, runId, open]);
  const cancel = async (jobId: string) => {
    setBusy(true);
    const receipt =
      cancellation.current?.jobId === jobId
        ? cancellation.current
        : { jobId, commandId: crypto.randomUUID(), expectedRevision: revision };
    cancellation.current = receipt;
    try {
      await mutation(`/runs/${runId}/jobs/${jobId}/cancel`, {
        commandId: receipt.commandId,
        expectedRevision: receipt.expectedRevision,
      });
      cancellation.current = undefined;
      setActionError('');
      await read(cursor.current);
    } catch (issue) {
      const rejected =
        issue instanceof ApiError &&
        issue.kind === 'http' &&
        [
          'REVISION_CONFLICT',
          'INVALID_STATE',
          'DELETE_IN_PROGRESS',
          'NATIVE_JOBS_ONLY',
          'JOB_SCOPE',
          'JOB_NOT_FOUND',
        ].includes(issue.code ?? '');
      if (rejected) cancellation.current = undefined;
      setActionError(
        (issue instanceof Error ? issue.message : '取消结果待核对') +
          (rejected ? '；请求未执行，请刷新运行状态后重试。' : '；请刷新作业状态，重试会使用原命令。'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="native-inbox-receipts background-jobs"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>后台作业{page ? ` · ${page.total}` : ''}</summary>
      <p className="field-help">作业登记、命令退出和任务完成分别记录。取消不会撤销已发生的副作用。</p>
      {actionError && (
        <p className="inbox-receipt-error" role="alert">
          {actionError}
        </p>
      )}
      {error && (
        <p className="inbox-receipt-error" role="alert">
          {error}{' '}
          <button type="button" disabled={loading} onClick={() => void read(cursor.current)}>
            刷新
          </button>
        </p>
      )}
      {!page && loading && <p role="status">正在读取后台作业…</p>}
      {page && (
        <>
          {!page.total && <p>尚无后台作业。</p>}
          <ol className="inbox-receipt-list">
            {page.jobs.map((job) => (
              <li key={job.id}>
                <div className="inbox-receipt-heading">
                  <strong>{statusLabels[job.status]}</strong>
                  <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
                </div>
                <p>{job.command.program}</p>
                <p className="field-help">
                  {job.stopConfirmed ? '进程停止已确认' : '尚未确认进程停止'} ·{' '}
                  {job.deliveredAt ? '结果已加入上下文' : '结果尚未加入上下文'}
                </p>
                {job.error && <p>{job.error}</p>}
                <JobDetails runId={runId} job={job} />
                <div className="inbox-receipt-pages">
                  {job.status === 'RUNNING' && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !!disabledReason}
                      title={disabledReason}
                      onClick={() => void cancel(job.id)}
                    >
                      停止作业
                    </button>
                  )}
                  {job.status === 'UNCERTAIN' && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !!disabledReason}
                      title={disabledReason}
                      onClick={() => verify(job.executionOperationId)}
                    >
                      核验进程与结果
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="inbox-receipt-pages">
            <button type="button" disabled={loading} onClick={() => void read(undefined, 'latest')}>
              最新作业
            </button>
            <button
              type="button"
              disabled={loading || !trail.length}
              onClick={() => void read(trail.at(-1), 'previous')}
            >
              上一页
            </button>
            <button
              type="button"
              disabled={loading || !page.hasMore}
              onClick={() => void read(page.nextBefore ?? undefined, 'next')}
            >
              更早作业
            </button>
          </div>
        </>
      )}
    </details>
  );
}
