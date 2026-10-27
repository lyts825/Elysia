/**
 * 展示上下文窗口用量、预算及详情。
 * 从紧凑占用入口延伸到完整快照和新窗口策略编辑，保留未知指标；读取与修改需依赖当前代理和设置基线。
 * EN: Displays context-window usage, budgets, and detailed measurements. Connects compact usage indicators to full snapshots and new-window policy editing while retaining unknown metrics; reads and changes depend on the current agent and configuration baseline.
 */
import { useState, type CSSProperties } from 'react';
import type { ContextPolicy, ContextProjection, ProviderConfig } from '../../../packages/contracts/src/index';
import { minimumContextWindowTokens } from '../../../packages/contracts/src/index';
import { ContextPolicyEditor, validContextPolicy } from './ContextPolicyEditor';
import { Modal } from './Modal';
import { contextPolicyLabel, contextWindowSizeLabel } from './ContextLabel';
import { TaskWorkingState } from './TaskWorkingState';
import type { WorkbenchCache } from './WorkbenchCache';
import './context-window.css';

export { contextPolicyLabel } from './ContextLabel';
/**
 * 将已知token计数转换为区域化字符串；null和undefined保持未知占位。
 * EN: Formats a known token count with locale separators while preserving a placeholder for null or undefined.
 */
const count = (value: number | null | undefined) => (value == null ? '—' : value.toLocaleString());
/**
 * 将上下文投影中的占用比例四舍五入为百分数；缺少比例时返回null供界面显示未知。
 * EN: Rounds the projection usage ratio to a percentage, returning null when no ratio exists so the UI can show an unknown state.
 */
const percentage = (projection?: ContextProjection) =>
  projection?.usageRatio == null ? null : Math.round(projection.usageRatio * 100);

/**
 * 紧凑入口只展示估算压力；占用未知时显示占位，点击由上层打开完整快照。
 * EN: The compact entry shows estimated pressure only. Show a placeholder for unknown usage and ask the parent to open the complete snapshot on click.
 */
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
  /**
   * 缺少估算时显示占位；圆环限制在 100%，文字保留真实估算比例。
   * EN: Show a placeholder when the estimate is missing. Clamp the ring to 100% while preserving the actual estimate ratio in text.
   */
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
            : '点击读取上下文窗口。'
        }
        onClick={open}
      >
        <i
          className="context-meter-ring"
          aria-hidden="true"
          style={{ '--context-fill': `${Math.min(100, used ?? 0)}%` } as CSSProperties}
        />
        <span>上下文 {used == null ? '—' : `≈${used}%`}</span>
      </button>
      {showStreaming && projection?.metrics?.phase === 'streaming' && (
        <span
          className="context-stream-output"
          title="按回答正文字节估算，不含思考记录；实际用量由供应商返回。"
        >
          生成 ≈{count(projection.streamingOutputTokens)} Token
        </span>
      )}
    </>
  );
}

/**
 * 分开呈现输入估算、运行预留、压缩结果和最近供应商实测，避免将单次窗口等同累计预算。
 * EN: Separate estimated input, runtime reserve, compaction results, and the latest provider measurement; a single request window is not a cumulative budget.
 */
export function ContextWindowDetails({ projection }: { projection: ContextProjection }) {
  const used = percentage(projection);
  const compression = projection.compression;
  return (
    <div className="context-window-details">
      <div className="context-usage-summary">
        <div>
          <span className="context-usage-label">输入占用 · 估算</span>
          <strong>{used == null ? '—' : `${used}%`}</strong>
        </div>
        <div className="context-remaining">
          <span className="context-usage-label">剩余输入 · 估算</span>
          <strong>{count(projection.remainingInputTokens)}</strong>
          <span className="context-token-unit">Token</span>
        </div>
      </div>
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
      <dl className="context-capacity">
        <div>
          <dt>分配窗口</dt>
          <dd>{contextWindowSizeLabel(projection.windowTokens)}</dd>
        </div>
        <div>
          <dt>模型容量</dt>
          <dd>{contextWindowSizeLabel(projection.providerLimit)}</dd>
        </div>
      </dl>
      <p className="context-input-line">
        <span>估算输入 {count(projection.estimatedInputTokens)}</span>
        <span>输入额度 {count(projection.inputBudgetTokens)} Token</span>
      </p>
      <p className="context-status-note">
        {projection.metrics ? '占用随编译与生成更新，为本机估算。' : '尚未编译上下文，当前用量未知。'}
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
      <details className="context-usage-details">
        <summary>生成与实际用量</summary>
        <dl className="context-breakdown">
          <div>
            <dt>本次生成 · 字节估算</dt>
            <dd>{projection.metrics ? count(projection.streamingOutputTokens) : '—'}</dd>
          </div>
          <div>
            <dt>最近供应商输入 · 实际</dt>
            <dd>{count(projection.observedInputTokens)}</dd>
          </div>
          <div>
            <dt>最近供应商输出 · 实际</dt>
            <dd>{count(projection.observedOutputTokens)}</dd>
          </div>
        </dl>
        <p className="context-status-note">
          生成估算仅含回答正文，不含思考记录。实际用量来自最近一次供应商返回；累计调用预算单独统计。
        </p>
      </details>
      <details className="context-reserves">
        <summary>输出与运行预留</summary>
        <p className="context-status-note">
          输出 {count(projection.outputReserveTokens)} · 安全余量 {count(projection.safetyReserveTokens)} ·
          运行指令 {count(projection.runtimeReserveTokens)} Token。
        </p>
      </details>
    </div>
  );
}

/**
 * 展示各代理独立窗口，由上层根据 safeToConfigure 决定具体设置与刷新流程。
 * EN: Display independent agent windows. The parent uses safeToConfigure to control actual configuration and refresh workflows.
 */
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

/**
 * 打开时固定代理与运行修订作为编辑基线；外部快照变化即锁定提交，保留当前草稿供核对。
 * submit 同时携带两层期望修订，最终容量和安全检查点仍由内核验证。
 * EN: Capture agent and run revisions as the editing baseline when opened. Lock submission after an external snapshot change, retaining the draft for review. Submit both expected revisions; the kernel still verifies capacity and safe checkpoints.
 */
export function ContextWindowModal({
  projection,
  runId,
  cache,
  title,
  runRevision,
  busy,
  close,
  submit,
  refresh,
}: {
  projection: ContextProjection;
  runId: string;
  cache: WorkbenchCache;
  title: string;
  runRevision: number;
  busy: boolean;
  close: () => void;
  submit: (policy: ContextPolicy, expectedAgentRevision: number, expectedRevision: number) => void;
  refresh?: () => void;
}) {
  const [policy, setPolicy] = useState(projection.policy);
  const [revision] = useState({ agent: projection.agentRevision, run: runRevision });
  const stale = revision.agent !== projection.agentRevision || revision.run !== runRevision;
  const disabled = busy || !projection.safeToConfigure || stale;
  const changed =
    policy.mode !== projection.policy.mode || policy.windowTokens !== projection.policy.windowTokens;
  const valid = validContextPolicy(policy, projection.minimumWindowTokens, projection.providerLimit);
  return (
    <Modal title="上下文窗口" subtitle={title} close={close} busy={busy} className="context-window-modal">
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
          <TaskWorkingState runId={runId} taskId={projection.taskId} cache={cache} />
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            关闭
          </button>
          {refresh && (!projection.safeToConfigure || stale) && (
            <button type="button" className="secondary" disabled={busy} onClick={refresh}>
              重新读取设置
            </button>
          )}
          <button type="submit" className="primary" disabled={disabled || !changed || !valid}>
            {busy ? '正在保存…' : '保存分配'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/**
 * 新运行的初始窗口选择，没有持久修订；仅在型号可用且草稿满足当前容量限制时提交给上层。
 * EN: Select an initial window for a new run without persistent revisions. Submit to the parent only when the model is usable and the draft satisfies current capacity limits.
 */
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
      className="context-window-modal"
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
          <p className="field-help">用于新会话的总代理。窗口容量与累计调用预算独立。</p>
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
