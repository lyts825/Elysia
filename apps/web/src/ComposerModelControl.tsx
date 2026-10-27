/* 提供消息输入区的模型选择控件。 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ContextProjection, ProviderConfig } from '../../../packages/contracts/src/index';
import { Icon } from './Icon';
import { useSurfaceRoot } from './SurfaceClientContext';
import './composer-model-control.css';

const finiteCount = (value: number | null | undefined) =>
  value != null && Number.isFinite(value) && value >= 0 ? value : null;
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

/** The caller supplies live projections and owns reads; opening details is separate. */
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
  const ratio = input != null && budget != null && budget > 0 ? input / budget : null;
  const used = ratio == null ? null : Math.round(ratio * 100);
  const effort = reasoningEffort ? effortLabels[reasoningEffort] || reasoningEffort : '';
  const updatedAt = projection?.updatedAt ? new Date(projection.updatedAt) : undefined;
  const timestamp = updatedAt && Number.isFinite(updatedAt.getTime()) ? updatedAt : undefined;
  const dismiss = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (projection?.agentId && previousAgent.current && previousAgent.current !== projection.agentId)
      setOpen(false);
    if (projection?.agentId) previousAgent.current = projection.agentId;
  }, [projection?.agentId]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    let frame: number | undefined;
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
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        dismiss();
    };
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
