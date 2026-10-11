import { detailReadReason, type DetailReadState } from './DetailReadState';
import { useState } from 'react';
import type { RunStopCurrentResult } from '../../../packages/contracts/src/run-reads';

export function DetailReadNotice({
  detail,
  retry,
  busy,
  stop,
}: {
  detail: DetailReadState;
  retry: () => void;
  busy: boolean;
  stop?: () => Promise<RunStopCurrentResult>;
}) {
  const [stopping, setStopping] = useState(false),
    [stopped, setStopped] = useState<RunStopCurrentResult>();
  const [error, setError] = useState('');
  const reason = detailReadReason(detail);
  if (!reason && !detail.localExecutionStopped) return null;
  return (
    <section className="detail-read-notice" role="status" aria-label="详情读取不完整">
      <strong>{reason ? '部分执行记录无法读取' : '本机调度已停止'}</strong>
      <p>{reason || '记录已可读取，但此次本机调度仍已停止。请核验待处理事项，再明确恢复执行。'}</p>
      {reason && (
        <details>
          <summary>查看分区读取情况</summary>
          <p>已读消息和记录可继续查看，输入草稿仍保留；运行状态未更改。</p>
          <ul>
            {(['tasks', 'requests', 'operations'] as const).map((key) => {
              const coverage = detail.detailCoverage?.[key];
              if (!coverage) return null;
              return (
                <li key={key}>
                  {{ tasks: '任务', requests: '请求', operations: '操作' }[key]}：
                  {coverage.complete ? '已检查记录可读' : `${coverage.unavailable} 条暂不可读，完整情况未知`}
                  {coverage.scope === 'selected' ? '（仅检查已加载记录）' : `（共 ${coverage.total} 条）`}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {reason && (
        <button type="button" className="secondary" disabled={busy || stopping} onClick={retry}>
          {busy ? '正在重试读取…' : '重试读取此任务的异常记录'}
        </button>
      )}
      {stop && !!reason && (
        <>
          <button
            type="button"
            className="secondary danger"
            disabled={busy || stopping}
            onClick={async () => {
              if (busy || stopping) return;
              setStopping(true);
              setError('');
              try {
                setStopped(await stop());
              } catch (issue) {
                setError(issue instanceof Error ? issue.message : '停止请求未确认，请重试。');
              } finally {
                setStopping(false);
              }
            }}
          >
            {stopping ? '正在停止当前执行…' : '停止当前执行'}
          </button>
          <p className="field-help">仅停止此任务的本机执行，不记录持久暂停或取消；现有请求仍可能结算。</p>
        </>
      )}
      {(stop || detail.localExecutionStopped) && (
        <p className="field-help">应用重启后不会保留此次调度抑制。修复记录不会自动恢复执行。</p>
      )}
      {stopped && (
        <p className={stopped.interrupted ? 'field-help' : 'field-error'} role="status">
          {stopped.replayed
            ? '这是先前停止请求的结果，本次未再次停止执行。'
            : stopped.interrupted
              ? '本机中断路径已确认。'
              : '部分本机中断路径尚未确认，请重试停止。'}{' '}
          {stopped.message}
          {stopped.replayed && !stopped.localExecutionStopped && ' 当前没有本机调度抑制。'}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
