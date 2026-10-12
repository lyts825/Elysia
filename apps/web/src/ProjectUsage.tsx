import { useEffect, useState } from 'react';
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
  const [value, setValue] = useState<ProjectUsageSummary>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [before, setBefore] = useState('');
  const [version, setVersion] = useState('');
  const [trail, setTrail] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const query = before
      ? '?before=' + encodeURIComponent(before) + '&expectedVersion=' + encodeURIComponent(version)
      : '';
    void api<ProjectUsageSummary>(
      `/projects/${projectId}/usage` + query,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.projectId !== projectId || (result.page.before ?? '') !== before)
          throw Error('返回的统计不属于当前项目或页面，请刷新。');
        setValue(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setError(issue instanceof Error ? issue.message : '项目用量读取失败，请刷新。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, projectId, before, retry, version]);
  const refresh = () => {
    setBefore('');
    setVersion('');
    setTrail([]);
    setRetry((n) => n + 1);
  };
  return (
    <section className="project-usage" aria-label="项目用量总览">
      <div className="project-section-heading">
        <div>
          <h2>项目用量</h2>
          <p>按请求当时的模型与连接汇总，包含项目内全部任务及对话。</p>
        </div>
        <button type="button" className="secondary" disabled={loading} onClick={refresh}>
          刷新项目用量
        </button>
      </div>
      <p className="field-help">
        请求重试分别计数。Token
        是已报告部分，未知值不会记作零消耗；费用按请求用量和当时单价估算，只累计已结算且币种明确的记录。USD 与
        CNY 分别展示，订阅未知成本保持未知。
      </p>
      {loading && <p role="status">正在读取项目用量…</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
          {value && ' 下方为上次读取结果，当前统计可能已变化。'}
        </p>
      )}
      {value && (
        <>
          <p className="field-help">
            {value.runCount} 个任务/对话 · 更新于 {new Date(value.generatedAt).toLocaleString()}
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
              disabled={loading || !trail.length}
              onClick={() => {
                setBefore(trail.at(-1) || '');
                setTrail(trail.slice(0, -1));
              }}
            >
              上一页任务
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading || !!error || !value.page.hasMore}
              onClick={() => {
                setVersion(value.version);
                setTrail([...trail, before]);
                setBefore(value.page.nextBefore || '');
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
