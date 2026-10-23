import { detailReadReason, type DetailReadState } from './DetailReadState';
import { useState } from 'react';
import type { RunStopCurrentResult } from '../../../packages/contracts/src/run-reads';
import './detail-read-notice.css';

export function DetailReadNotice({
  detail,
  retry,
  retryPreview = retry,
  busy,
  stop,
  finished = false,
  clearHold,
}: {
  detail: DetailReadState;
  retry: () => void;
  retryPreview?: () => void;
  busy: boolean;
  stop?: () => Promise<RunStopCurrentResult>;
  finished?: boolean;
  clearHold?: () => Promise<boolean>;
}) {
  const [stopping, setStopping] = useState(false),
    [stopped, setStopped] = useState<RunStopCurrentResult>();
  const [error, setError] = useState('');
  const [clearing, setClearing] = useState(false);
  const reason = detailReadReason(detail);
  const preview = detail.eventPreviewCoverage;
  const executionNotice = !!reason || detail.localExecutionStopped;
  if (!executionNotice && preview?.complete !== false) return null;
  return (
    <div className="detail-read-stack" role="region" aria-label="执行读取与调度提示" tabIndex={0}>
      {preview?.complete === false && (
        <section className="detail-read-notice" role="status" aria-label="近期进度读取不完整">
          <h3>部分近期进度未能完整读取</h3>
          <p>
            {preview.limited
              ? `${preview.unavailable} 条进度内容超出本次读取范围，其余记录仍可查看。`
              : `${preview.unavailable} 条进度内容暂时无法读取，其余记录仍可查看。`}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy || stopping || clearing}
            onClick={retryPreview}
          >
            {busy ? '正在核对近期进度…' : '重新核对近期进度'}
          </button>
        </section>
      )}
      {executionNotice && (
        <section className="detail-read-notice" role="status" aria-label="详情读取不完整">
          <h3>
            {reason
              ? '部分执行记录无法读取'
              : detail.executionHold?.reason === 'recovery_unreadable'
                ? '异常恢复已停止自动执行'
                : '本机调度已停止'}
          </h3>
          <p className="detail-read-prose">
            {reason ||
              (finished
                ? '任务已结束，仍保留停止标记。核验后可明确解除标记；不会重新执行，也不会改变已完成或已取消状态。'
                : '记录已可读取，但此次本机调度仍已停止。请核验待处理事项，再明确恢复执行。')}
          </p>
          {detail.executionHold && (
            <p className="field-help detail-read-prose">
              {finished
                ? detail.executionHold.reason === 'recovery_unreadable'
                  ? '先前因记录无法核验而保存了停止调度标记。'
                  : '先前已保存停止调度标记。'
                : detail.executionHold.message}
              {detail.executionHold.issueCount > 0 && `（${detail.executionHold.issueCount} 项需核对）`}
            </p>
          )}
          {reason && (
            <details>
              <summary>查看分区读取情况</summary>
              <p>已读消息和记录可继续查看，输入草稿仍保留；运行状态未更改。</p>
              <dl className="detail-read-coverage">
                {(['tasks', 'requests', 'operations'] as const).map((key) => {
                  const coverage = detail.detailCoverage?.[key];
                  if (!coverage) return null;
                  return (
                    <div key={key}>
                      <dt>{{ tasks: '任务', requests: '请求', operations: '操作' }[key]}</dt>
                      <dd>
                        <span>
                          {coverage.complete
                            ? '已检查记录可读'
                            : `${coverage.unavailable} 条暂不可读，完整情况未知`}
                        </span>
                        <small>
                          {coverage.scope === 'selected' ? '仅检查已加载记录' : `共 ${coverage.total} 条记录`}
                        </small>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </details>
          )}
          {reason && (
            <button
              type="button"
              className="secondary"
              disabled={busy || stopping || clearing}
              onClick={retry}
            >
              {busy ? '正在重试读取…' : '重试读取此任务的异常记录'}
            </button>
          )}
          {finished && clearHold && detail.localExecutionStopped && (
            <>
              <button
                type="button"
                className="secondary"
                disabled={busy || stopping || clearing || !!reason}
                onClick={async () => {
                  if (busy || stopping || clearing || reason) return;
                  setClearing(true);
                  setError('');
                  try {
                    if (!(await clearHold())) setError('解除停止标记尚未确认，请查看错误提示后重试。');
                  } catch (issue) {
                    setError(issue instanceof Error ? issue.message : '解除停止标记尚未确认，请重试。');
                  } finally {
                    setClearing(false);
                  }
                }}
              >
                {clearing ? '正在核验并解除标记…' : '解除停止标记（不执行）'}
              </button>
              {reason && <p className="field-help">请先修复并重试读取异常记录，再解除停止标记。</p>}
            </>
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
              <p className="field-help">
                先保存此任务的停止调度记录，再中断本机执行；不会把原任务状态改为已取消，现有请求仍可能结算。
              </p>
            </>
          )}
          {(stop || detail.localExecutionStopped) && (
            <p className="field-help">
              {finished
                ? '停止标记在重开应用后仍有效。修复记录不会自动解除；解除已结束任务的标记不会启动执行。'
                : '停止调度记录在重开应用后仍有效。修复记录不会自动恢复，核验通过后需明确恢复执行。'}
            </p>
          )}
          {stopped && (
            <p
              className={'detail-read-result ' + (stopped.interrupted ? 'field-help' : 'field-error')}
              role="status"
              aria-label="停止请求完整结果"
              tabIndex={0}
            >
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
            <p className="detail-read-error" role="alert" aria-label="读取或调度操作失败全文" tabIndex={0}>
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
