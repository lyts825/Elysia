/**
 * 提供消息输入区的模型选择控件。
 * 消费父组件传入的模型及上下文投影，仅管理轻量浮层的定位、焦点和关闭；切换和读取通过回调交回上层。
 * EN: Provides model-selection controls in the message composer. Consumes model/context projections and owns only popup placement, focus, and dismissal; callbacks delegate switching and reads to the parent.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ContextProjection, ProviderConfig } from '../../../packages/contracts/src/index';
import { Icon } from './Icon';
import { useSurfaceRoot } from './SurfaceClientContext';
import './composer-model-control.css';

/**
 * 只接受有限且非负的计数；缺失和非法值统一返回null，使界面能够区分未知与零。
 * EN: Accepts only finite nonnegative counts; missing or invalid input returns null so the UI distinguishes unknown values from zero.
 */
const finiteCount = (value: number | null | undefined) =>
  value != null && Number.isFinite(value) && value >= 0 ? value : null;
/**
 * 将有效计数按浏览器区域格式显示；未知值显示占位符，避免显示NaN或伪造零。
 * EN: Formats a valid count with the browser locale and renders a placeholder for unknown input instead of NaN or a fabricated zero.
 */
const count = (value: number | null | undefined) => finiteCount(value)?.toLocaleString() ?? '—';
const effortLabels: Record<string, string> = {
  none: '关闭思考',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: 'Max',
  ultra: 'Ultra',
};

export type ComposerModelControlProps = {
  /**
   * 父组件持有连接选择和上下文读取；控件仅显示投影并发出打开请求。
   * EN: The parent owns the connection choice and context reads; this control displays the projection and requests the full picker.
   */
  modelLabel: string;
  providerLabel?: string;
  reasoningEffort?: ProviderConfig['reasoningEffort'];
  modelDisabledReason?: string;
  onOpenModel?: () => void;
  projection?: ContextProjection;
  contextLoading?: boolean;
  contextError?: string;
  contextDisabled?: boolean;
  onRequestContext?: () => void;
  onOpenContext?: () => void;
};

/**
 * 显示当前模型和上下文估算。父组件拥有读取、型号切换和设置操作；本控件只管理轻量弹层。
 * 弹层使用入口根节点 portal，按 visualViewport 与触发按钮布局，支持缩放、滚动和软键盘；
 * 切换代理会关闭旧投影，点击外部或焦点离开关闭，Esc 关闭并恢复触发器焦点。
 * EN: Display the current model and context estimate. The parent owns reads, model changes, and settings; this control owns only a lightweight popup. Portal it under the surface root and position it against visualViewport and the trigger, accounting for zoom, scrolling, and soft keyboards. Switching agents, outside clicks, or focus departure closes it; Escape also restores trigger focus.
 */
export function ComposerModelControl({
  modelLabel,
  providerLabel,
  reasoningEffort,
  modelDisabledReason,
  onOpenModel,
  projection,
  contextLoading = false,
  contextError,
  contextDisabled = false,
  onRequestContext,
  onOpenContext,
}: ComposerModelControlProps) {
  const surfaceRoot = useSurfaceRoot();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const previousAgent = useRef(projection?.agentId);
  const id = useId();
  const input = finiteCount(projection?.estimatedInputTokens);
  const budget = finiteCount(projection?.inputBudgetTokens);
  /**
   * 缺失或非法计数保留为未知，不用零伪造上下文占用率。
   * EN: Keep missing or invalid counts unknown instead of presenting a fabricated zero utilization.
   */
  const ratio = input != null && budget != null && budget > 0 ? input / budget : null;
  const used = ratio == null ? null : Math.round(ratio * 100);
  const effort = reasoningEffort ? effortLabels[reasoningEffort] || reasoningEffort : '';
  const updatedAt = projection?.updatedAt ? new Date(projection.updatedAt) : undefined;
  const timestamp = updatedAt && Number.isFinite(updatedAt.getTime()) ? updatedAt : undefined;
  /**
   * 关闭上下文浮层；仅显式键盘关闭等需要时恢复触发按钮焦点，避免外部点击抢焦点。
   * EN: Closes the context popup and optionally restores trigger focus; outside clicks can close it without stealing focus.
   */
    const dismiss = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  /**
   * 代理身份变化时关闭旧上下文浮层并更新身份记录，避免把旧代理投影继续展示在新选择上。
   * EN: Closes the old context popup and records the new agent identity so a previous projection is not shown for a new selection.
   */
  useEffect(() => {
    if (projection?.agentId && previousAgent.current && previousAgent.current !== projection.agentId)
      setOpen(false);
    if (projection?.agentId) previousAgent.current = projection.agentId;
  }, [projection?.agentId]);
  /**
   * 只在浮层展开时测量和订阅尺寸、滚动及visualViewport事件，动画帧合并定位；关闭时解除观察器和监听并取消待执行帧。
   * EN: Measures and subscribes to size, scroll, and visualViewport events only while open, coalescing placement per frame; closure disconnects observers/listeners and cancels the queued frame.
   */
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    let frame: number | undefined;
    /**
     * 测量按钮与visualViewport后直接更新浮层位置及高度；将边界夹在可见视口内以适应缩放和软键盘。
     * EN: Measures the trigger and visualViewport, then updates popup position and height directly. Clamping to the visible viewport accommodates zoom and the software keyboard.
     */
        const place = () => {
      const button = trigger.current,
        popup = panel.current;
      if (!button || !popup) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0,
        top = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth,
        height = viewport?.height || window.innerHeight;
      popup.style.maxHeight = `${Math.max(100, height - 16)}px`;
      const bounds = button.getBoundingClientRect();
      popup.style.left = `${Math.max(left + 8, Math.min(bounds.right - popup.offsetWidth, left + width - popup.offsetWidth - 8))}px`;
      popup.style.top = `${Math.max(top + 8, Math.min(bounds.top - popup.offsetHeight - 10, top + height - popup.offsetHeight - 8))}px`;
    };
    /**
     * 将同一帧内的尺寸和滚动事件合并为一次定位；已有帧时跳过，清理由所属effect取消。
     * EN: Coalesces resize and scroll events into one positioning pass per animation frame. It skips an already queued frame, which the owning effect cancels on cleanup.
     */
        const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        place();
      });
    };
    place();
    panel.current.querySelector<HTMLButtonElement>('[aria-label="关闭上下文预览"]')?.focus();
    const observer = new ResizeObserver(schedule);
    observer.observe(panel.current);
    observer.observe(trigger.current);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [open]);
  /**
   * 浮层打开期间监听外部指针、焦点和Escape；关闭或卸载时移除监听，显式Escape关闭才归还触发焦点。
   * EN: Listens for outside pointer/focus and Escape only while the popup is open; cleanup removes listeners and Escape dismissal restores trigger focus.
   */
  useEffect(() => {
    if (!open) return;
    /**
     * 检查指针或焦点是否同时位于浮层和触发器之外；仅外部交互关闭，以保留内部操作。
     * EN: Closes only when a pointer or focus event occurs outside both popup and trigger, preserving interactions inside either element.
     */
        const outside = (event: PointerEvent | FocusEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        dismiss();
    };
    /**
     * 拦截Escape并关闭浮层、恢复触发焦点；阻止继续传播以免同一按键关闭更外层界面。
     * EN: Intercepts Escape, closes the popup, and restores trigger focus; stopping propagation prevents the same key from dismissing an outer interface.
     */
        const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return (
    <div className="composer-model-control">
      <button
        type="button"
        className="composer-model-chip"
        aria-label="查看或切换当前模型"
        title={[providerLabel, modelLabel, effort, modelDisabledReason].filter(Boolean).join(' · ')}
        disabled={!onOpenModel}
        onClick={onOpenModel}
      >
        <span className="composer-model-name">{modelLabel || '选择模型'}</span>
        {effort && <span className="composer-model-effort">{effort}</span>}
        <Icon name="chevron" size={12} />
      </button>
      <button
        ref={trigger}
        type="button"
        className="composer-context-chip"
        aria-label="预览上下文窗口"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={contextDisabled}
        title={
          contextDisabled
            ? '此会话没有可预览的上下文窗口'
            : used == null
              ? '上下文占用尚未估算，点击查看'
              : `输入空间估算占用 ${used}%，点击查看`
        }
        data-pressure={ratio != null && ratio >= 0.75 ? 'high' : 'normal'}
        onClick={() => {
          if (open) {
            dismiss();
            return;
          }
          setOpen(true);
          if (!projection && !contextLoading && !contextError) onRequestContext?.();
        }}
      >
        <i
          className="composer-context-ring"
          aria-hidden="true"
          data-known={ratio != null}
          style={
            ratio == null
              ? undefined
              : ({ '--composer-context-fill': `${Math.min(1, ratio) * 100}%` } as CSSProperties)
          }
        />
        <span>{used == null ? '—' : `${used}%`}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            className="composer-context-popover"
            role="dialog"
            aria-modal="false"
            aria-labelledby={id + '-title'}
            aria-busy={contextLoading}
          >
            <div className="composer-context-heading">
              <div>
                <h3 id={id + '-title'}>上下文窗口</h3>
                <small title={modelLabel}>{modelLabel}</small>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭上下文预览"
                onClick={() => dismiss(true)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <div
              className="composer-context-usage"
              data-pressure={ratio != null && ratio >= 0.75 ? 'high' : 'normal'}
            >
              <div className="composer-context-percent">
                <strong>{used == null ? '—' : `${used}%`}</strong>
                <span>
                  输入空间占用<small>估算</small>
                </span>
              </div>
              <div
                className="composer-context-progress"
                data-known={ratio != null}
                role="meter"
                aria-label="输入空间估算占用"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={used == null ? undefined : Math.min(100, used)}
                aria-valuetext={used == null ? '尚未估算' : `约 ${used}%`}
              >
                {ratio != null && <i style={{ transform: `scaleX(${Math.min(1, ratio)})` }} />}
              </div>
              <p>
                <span>估算输入 / 输入额度</span>
                <strong>
                  {count(input)} / {count(budget)} Token
                </strong>
              </p>
            </div>
            <dl className="composer-context-metrics">
              <div>
                <dt>窗口 / 模型上限</dt>
                <dd>
                  {count(projection?.windowTokens)} / {count(projection?.providerLimit)}
                </dd>
              </div>
              <div>
                <dt>剩余输入空间 · 估算</dt>
                <dd>{count(projection?.remainingInputTokens)}</dd>
              </div>
              <div>
                <dt>本次生成 · 估算</dt>
                <dd>{count(projection?.metrics ? projection.streamingOutputTokens : null)}</dd>
              </div>
              <div>
                <dt>最近供应商输入 · 实际</dt>
                <dd>{count(projection?.observedInputTokens)}</dd>
              </div>
              <div>
                <dt>最近供应商输出 · 实际</dt>
                <dd>{count(projection?.observedOutputTokens)}</dd>
              </div>
            </dl>
            <p className="composer-context-updated" role="status">
              {contextLoading
                ? '正在刷新预览…'
                : timestamp
                  ? `更新于 ${timestamp.toLocaleTimeString()}`
                  : '尚未编译上下文'}
            </p>
            {contextError && (
              <p className="composer-context-error" role="alert">
                {contextError}
              </p>
            )}
            <div className="composer-context-actions">
              {onRequestContext && (
                <button
                  type="button"
                  className="text-button"
                  disabled={contextLoading}
                  onClick={onRequestContext}
                >
                  {contextError ? '重试读取' : '刷新预览'}
                </button>
              )}
              {onOpenContext && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    dismiss();
                    onOpenContext();
                  }}
                >
                  窗口详情
                  <Icon name="arrow" size={12} />
                </button>
              )}
            </div>
          </div>,
          surfaceRoot?.current || document.body,
        )}
    </div>
  );
}
