import { useEffect, useRef, useState } from 'react';
import type { ProjectUsageSummary, ProjectUsageTotals } from '../../../packages/contracts/src/project-usage';
import { useSurfaceClient } from './SurfaceClientContext';
import './project-usage.css';

function Costs({ value }: { value: ProjectUsageTotals }) {
  return (
    <>
      {value.costs.length ? (
        value.costs.map((fee) => (
          <span key={fee.currency}>
            {fee.currency}{' '}
            {fee.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}（
            {fee.requestCount} 次）
          </span>
        ))
      ) : (
        <span>暂无已知费用</span>
      )}
      {!value.costComplete && <small>费用不完整 · {value.costUnknownCount} 次未结算或费用未知</small>}
    </>
  );
}
function Totals({ value }: { value: ProjectUsageTotals }) {
  return (
    <dl className="project-usage-totals">
      <div>
        <dt>请求次数</dt>
        <dd>
          {value.requestCount.toLocaleString()}
          <small>
            已结算 {value.statuses.settled} · 预留 {value.statuses.reserved} · 结果未知{' '}
            {value.statuses.unknown} · 已释放 {value.statuses.released}
          </small>
        </dd>
      </div>
      <div>
        <dt>已报告 Token</dt>
        <dd>
          {(value.inputTokens + value.outputTokens).toLocaleString()}
          <small>
            输入 {value.inputTokens.toLocaleString()} · 输出 {value.outputTokens.toLocaleString()}
          </small>
          {!value.tokenComplete && <small>用量不完整 · {value.tokenUnknownCount} 次未结算或用量缺失</small>}
        </dd>
      </div>
      <div>
        <dt>已知费用估算</dt>
        <dd>
          <Costs value={value} />
        </dd>
      </div>
      {value.unavailableCount > 0 && (
        <div>
          <dt>读取缺口</dt>
          <dd>{value.unavailableCount} 次请求无法读取</dd>
        </div>
      )}
    </dl>
  );
}
export function ProjectUsage({ projectId, openRun }: { projectId: string; openRun: (id: string) => void }) {
  const { api } = useSurfaceClient();
  type Position = { before: string; version: string; trail: string[] };
  const firstPage = (): Position => ({ before: '', version: '', trail: [] });
  const [display, setDisplay] = useState<{ value: ProjectUsageSummary; position: Position }>();
  const [intent, setIntent] = useState<{ projectId: string; position: Position; attempt: number }>();
  const [read, setRead] = useState<{ status: 'loading' | 'ready' | 'cancelled' | 'failed'; error: string }>({
    status: 'loading',
    error: '',
  });
  const currentRead = useRef<AbortController | undefined>(undefined);
  const visible = display?.value.projectId === projectId ? display : undefined;
  const value = visible?.value;
  const position = visible?.position ?? firstPage();
  const loading = read.status === 'loading';
  const error = read.error;
  useEffect(() => {
    const controller = new AbortController();
    currentRead.current = controller;
    const target = intent?.projectId === projectId ? intent.position : firstPage();
    const active = () => currentRead.current === controller && !controller.signal.aborted;
    setRead({ status: 'loading', error: '' });
    const query = target.before
      ? '?before=' +
        encodeURIComponent(target.before) +
        '&expectedVersion=' +
        encodeURIComponent(target.version)
      : '';
    void api<ProjectUsageSummary>(
      `/projects/${projectId}/usage` + query,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!active()) return;
        if (result.projectId !== projectId || (result.page.before ?? '') !== target.before)
          throw Error('返回的统计不属于当前项目或页面，请刷新。');
        // Only a successful response advances the displayed page and its navigation history.
        setDisplay({ value: result, position: { ...target, version: result.version } });
        setRead({ status: 'ready', error: '' });
      })
      .catch((issue) => {
        if (active())
          setRead({
            status: 'failed',
            error: issue instanceof Error ? issue.message : '项目用量读取失败，请刷新。',
          });
      });
    return () => {
      controller.abort();
      if (currentRead.current === controller) currentRead.current = undefined;
    };
  }, [api, projectId, intent]);
  const request = (target: Position) => {
    currentRead.current?.abort();
    setIntent((previous) => ({ projectId, position: target, attempt: (previous?.attempt ?? 0) + 1 }));
  };
  const cancel = () => {
    currentRead.current?.abort();
    currentRead.current = undefined;
    // Keep the intent for an explicit retry; changing it here would restart the cancelled read.
    setRead({ status: 'cancelled', error: '' });
  };
  return (
    <section className="project-usage" aria-label="项目用量总览">
      <div className="project-section-heading">
        <div>
          <h2>项目用量</h2>
          <p>按请求当时的模型与连接汇总，包含项目内全部任务及对话。</p>
        </div>
        <button type="button" className="secondary" disabled={loading} onClick={() => request(firstPage())}>
          刷新项目用量
        </button>
      </div>
      <p className="field-help">
        请求重试分别计数。Token
        是已报告部分，未知值不会记作零消耗；费用按请求用量和当时单价估算，只累计已结算且币种明确的记录。USD 与
        CNY 分别展示，订阅未知成本保持未知。
      </p>
      {loading && (
        <div className="project-usage-read-state">
          <p role="status">正在读取项目用量…</p>
          <button type="button" className="secondary" onClick={cancel}>
            取消本次读取
          </button>
        </div>
      )}
      {read.status === 'cancelled' && (
        <p role="status">
          本次项目用量读取已取消。{value ? '已读结果和当前页面保留。' : '尚无已读结果。'}可明确重试或刷新。
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {(read.status === 'cancelled' || read.status === 'failed') && (
        <button
          type="button"
          className="secondary"
          onClick={() => request(intent?.projectId === projectId ? intent.position : firstPage())}
        >
          重试本次读取
        </button>
      )}
      {value && (
        <>
          {read.status !== 'ready' && (
            <p className="field-help project-usage-previous" role="status">
              下方为上次读取结果，仍显示第 {position.trail.length + 1} 页；当前统计尚未重新确认。
            </p>
          )}
          <p className="field-help">
            {value.runCount} 个任务/对话 · 第 {position.trail.length + 1} 页 · 更新于{' '}
            {new Date(value.generatedAt).toLocaleString()}
          </p>
          {!value.readCoverage.complete && (
            <p className="field-error">部分记录或项目归属无法读取，汇总不完整。可读部分仍单独保留。</p>
          )}
          {value.unassignedRunCount > 0 && (
            <p className="field-help">
              另有 {value.unassignedRunCount} 条任务记录无法确定项目归属，未分配到此项目。
            </p>
          )}
          <Totals value={value.totals} />
          <h3>请求当时的连接与模型</h3>
          {!value.connections.length && <p>此项目尚无请求记录。</p>}
          <div className="project-usage-connections">
            {value.connections.map((connection, i) => (
              <article key={i}>
                <strong>
                  {connection.label} · {connection.model || '模型未知'}
                </strong>
                <p>
                  {connection.source === 'subscription'
                    ? '订阅连接'
                    : connection.source === 'api'
                      ? 'API 连接'
                      : '连接类型未知'}
                  {connection.account && ` · ${connection.account}`}
                </p>
                <Totals value={connection} />
              </article>
            ))}
          </div>
          <h3>任务明细</h3>
          {!value.runs.length && <p>尚无项目任务。</p>}
          {value.runs.map((run) => (
            <article className="project-usage-run" key={run.runId}>
              <div className="project-section-heading">
                <strong>
                  {run.title}
                  {run.archived && '（已归档）'}
                </strong>
                <button type="button" className="secondary" onClick={() => openRun(run.runId)}>
                  查看任务
                </button>
              </div>
              <p>
                {run.requestCount} 次请求 · 已报告 {(run.inputTokens + run.outputTokens).toLocaleString()}{' '}
                Token{!run.tokenComplete && '（不完整）'}
              </p>
              <div className="project-usage-fees">
                <Costs value={run} />
              </div>
              {run.unavailableCount > 0 && (
                <p className="field-error">{run.unavailableCount} 次请求无法读取</p>
              )}
            </article>
          ))}
          <div className="project-actions">
            <button
              type="button"
              className="secondary"
              disabled={loading || !position.trail.length}
              onClick={() => {
                request({
                  before: position.trail.at(-1) || '',
                  version: position.version,
                  trail: position.trail.slice(0, -1),
                });
              }}
            >
              上一页任务
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading || !!error || !value.page.hasMore}
              onClick={() => {
                request({
                  version: value.version,
                  trail: [...position.trail, position.before],
                  before: value.page.nextBefore || '',
                });
              }}
            >
              下一页任务
            </button>
          </div>
        </>
      )}
    </section>
  );
}
