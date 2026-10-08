import { useState, type CSSProperties } from 'react';
import type { ContextPolicy, ContextProjection, ProviderConfig } from '../../../packages/contracts/src/index';
import { minimumContextWindowTokens } from '../../../packages/contracts/src/index';
import { ContextPolicyEditor, validContextPolicy } from './ContextPolicyEditor';
import { Modal } from './Modal';
import './context-window.css';

export const contextPolicyLabel = (policy: ContextPolicy, child = false) =>
  policy.mode === 'manual'
    ? `手动 · ${(policy.windowTokens || 0).toLocaleString()} Token`
    : child
      ? '托管 · 上级分配'
      : '托管 · 模型容量';
const count = (value: number | null | undefined) => (value == null ? '—' : value.toLocaleString());
const percentage = (projection?: ContextProjection) =>
  projection?.usageRatio == null ? null : Math.round(projection.usageRatio * 100);

export function ContextMeter({
  projection,
  open,
  disabled = false,
  showStreaming = false,
}: {
  projection?: ContextProjection;
  open: () => void;
  disabled?: boolean;
  showStreaming?: boolean;
}) {
  const used = percentage(projection);
  return (
    <>
      <button
        type="button"
        className="context-meter"
        data-pressure={used != null && used >= 75 ? 'high' : 'normal'}
        aria-label="查看上下文窗口"
        disabled={disabled}
        title={
          projection
            ? `输入空间占用${used == null ? '尚未估算' : `约 ${used}%`}；已分配 ${count(projection.windowTokens)} Token。点击查看或调整。`
            : '上下文数据正在读取。'
        }
        onClick={open}
      >
        <i
          className="context-meter-ring"
          aria-hidden="true"
          style={{ '--context-fill': `${Math.min(100, used ?? 0)}%` } as CSSProperties}
        />
        <span>输入空间 {used == null ? '—' : `${used}%`}</span>
        {used != null && <small>估算</small>}
      </button>
      {showStreaming && projection?.metrics?.phase === 'streaming' && (
        <span
          className="context-stream-output"
          title="按可见生成文本字节估算，不含隐藏思考；实际用量由供应商返回。"
        >
          生成 ≈{count(projection.streamingOutputTokens)} Token
        </span>
      )}
    </>
  );
}

export function ContextWindowDetails({ projection }: { projection: ContextProjection }) {
  const used = percentage(projection);
  const compression = projection.compression;
  return (
    <div className="context-window-details">
      <div
        className="context-progress"
        data-pressure={used != null && used >= 75 ? 'high' : 'normal'}
        role="meter"
        aria-label="输入空间估算占用"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used == null ? undefined : Math.min(100, used)}
        aria-valuetext={used == null ? '尚未估算' : `约 ${used}%`}
      >
        <i style={{ transform: `scaleX(${Math.min(1, Math.max(0, projection.usageRatio ?? 0))})` }} />
      </div>
      <dl className="context-breakdown">
        <div>
          <dt>已分配窗口 / 模型容量</dt>
          <dd>
            {count(projection.windowTokens)} / {count(projection.providerLimit)}
          </dd>
        </div>
        <div>
          <dt>估算输入 / 输入额度</dt>
          <dd>
            {count(projection.estimatedInputTokens)} / {count(projection.inputBudgetTokens)}
          </dd>
        </div>
        <div>
          <dt>本次生成（字节估算）</dt>
          <dd>{projection.metrics ? count(projection.streamingOutputTokens) : '—'}</dd>
        </div>
        <div>
          <dt>剩余输入空间（估算）</dt>
          <dd>{count(projection.remainingInputTokens)}</dd>
        </div>
        <div>
          <dt>最近供应商输入（实际）</dt>
          <dd>{count(projection.observedInputTokens)}</dd>
        </div>
        <div>
          <dt>最近供应商输出（实际）</dt>
          <dd>{count(projection.observedOutputTokens)}</dd>
        </div>
      </dl>
      <p className="context-status-note">
        {projection.metrics ? '窗口占用随编译与生成更新，数值为本机估算。' : '尚未编译上下文，当前用量未知。'}
        供应商实际用量来自最近一次返回，累计调用预算另行统计。 生成估算只包含可见文本，不含隐藏思考。
      </p>
      {compression?.status === 'completed' && (
        <p className="context-status-note" role="status">
          已压缩 {compression.summarizedMessages} 条历史、精简 {compression.prunedToolMessages} 条工具结果；
          估算输入 {count(compression.beforeTokens)} → {count(compression.afterTokens)} Token。原始记录保留。
        </p>
      )}
      {compression?.status === 'blocked' && (
        <p className="inline-warning" role="status">
          当前必要内容仍超出窗口，请扩大分配或减少资料。
        </p>
      )}
      <details className="context-reserves">
        <summary>查看输出与运行预留</summary>
        <p className="context-status-note">
          输出 {count(projection.outputReserveTokens)} · 安全余量 {count(projection.safetyReserveTokens)} ·
          运行指令 {count(projection.runtimeReserveTokens)} Token。
        </p>
      </details>
    </div>
  );
}

export function ContextOverview({
  contexts,
  titleFor,
  configure,
}: {
  contexts: ContextProjection[];
  titleFor: (projection: ContextProjection) => string;
  configure: (projection: ContextProjection) => void;
}) {
  return (
    <>
      <div className="panel-heading">
        <h3>上下文窗口</h3>
        <span>每个代理独立分配</span>
      </div>
      <div className="context-overview">
        {contexts.map((projection) => (
          <div className="context-agent-row" key={projection.agentId}>
            <div className="context-agent-head">
              <strong>{titleFor(projection)}</strong>
              <ContextMeter projection={projection} open={() => configure(projection)} />
            </div>
            <small>{contextPolicyLabel(projection.policy, !!projection.parentAgentId)}</small>
            <ContextWindowDetails projection={projection} />
          </div>
        ))}
        {!contexts.length && <p className="context-status-note">上下文数据尚未读取。</p>}
      </div>
    </>
  );
}

export function ContextWindowModal({
  projection,
  title,
  runRevision,
  busy,
  close,
  submit,
}: {
  projection: ContextProjection;
  title: string;
  runRevision: number;
  busy: boolean;
  close: () => void;
  submit: (policy: ContextPolicy, expectedAgentRevision: number, expectedRevision: number) => void;
}) {
  const [policy, setPolicy] = useState(projection.policy);
  const [revision] = useState({ agent: projection.agentRevision, run: runRevision });
  const stale = revision.agent !== projection.agentRevision || revision.run !== runRevision;
  const disabled = busy || !projection.safeToConfigure || stale;
  const changed =
    policy.mode !== projection.policy.mode || policy.windowTokens !== projection.policy.windowTokens;
  const valid = validContextPolicy(policy, projection.minimumWindowTokens, projection.providerLimit);
  return (
    <Modal title="上下文窗口" subtitle={title} close={close} busy={busy}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && valid && changed) submit(policy, revision.agent, revision.run);
        }}
      >
        <div className="form-body">
          <div className="context-current">
            <ContextWindowDetails projection={projection} />
          </div>
          <ContextPolicyEditor
            value={policy}
            change={setPolicy}
            minimumWindowTokens={projection.minimumWindowTokens}
            providerLimit={projection.providerLimit}
            disabled={disabled}
            child={!!projection.parentAgentId}
          />
          {projection.assignedByAgentId && projection.policy.mode === 'managed' && (
            <p className="field-help">当前窗口已由上级模型分配。</p>
          )}
          {!projection.safeToConfigure && (
            <p className="inline-warning" role="status">
              {projection.configureReason || '当前仅可查看窗口，暂停后再调整。'}
            </p>
          )}
          {stale && (
            <p className="inline-warning" role="status">
              会话已更新，请重新打开窗口设置后修改。
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            关闭
          </button>
          <button type="submit" className="primary" disabled={disabled || !changed || !valid}>
            {busy ? '正在保存…' : '保存分配'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function NewContextWindowModal({
  policy: initial,
  provider,
  busy,
  close,
  submit,
}: {
  policy: ContextPolicy;
  provider?: ProviderConfig;
  busy: boolean;
  close: () => void;
  submit: (policy: ContextPolicy) => void;
}) {
  const [policy, setPolicy] = useState(initial);
  const minimum = provider ? minimumContextWindowTokens(provider) : 4096;
  const limit = provider?.contextLimit ?? minimum;
  const valid = validContextPolicy(policy, minimum, limit);
  return (
    <Modal
      title="上下文窗口"
      subtitle={provider ? `${provider.label} · ${provider.model}` : '新会话'}
      close={close}
      busy={busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && valid) submit(policy);
        }}
      >
        <div className="form-body">
          <ContextPolicyEditor
            value={policy}
            change={setPolicy}
            minimumWindowTokens={minimum}
            providerLimit={limit}
            disabled={busy || !provider}
          />
          <p className="field-help">此设置用于新会话的总代理，窗口容量不增加累计调用预算。</p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy || !provider || !valid}>
            保存分配
          </button>
        </footer>
      </form>
    </Modal>
  );
}
