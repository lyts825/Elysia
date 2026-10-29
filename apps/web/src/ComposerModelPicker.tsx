/**
 * 在消息输入区选择模型。
 * 在入口根节点中挂载原生popover，维护展开、定位和焦点；模型目录、有效性与选值由ModelPicker和父组件共同管理。
 * EN: Selects a model from the message composer. Mounts a native popover under the surface root and owns opening, placement, and focus; ModelPicker and the parent manage catalog validity and selected values.
 */
import { useSurfaceRoot } from './SurfaceClientContext';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { ModelPicker, type ModelChoice, type SelectableProvider } from './ModelPicker';
import './composer-model-picker.css';

/**
 * 在输入区通过原生 popover 提供模型选择，具体值和有效性仍由父组件与 ModelPicker 管理。
 * 打开后依据上下可用空间定位，滚动/尺寸变化重算；禁用或卸载关闭浮层，显式关闭恢复触发焦点。
 * EN: Use a native popover for model selection; the parent and ModelPicker own the actual value and validity. Position against available space above and below, and recalculate on scrolling or resizing. Disable or unmount closes it, while explicit closure restores trigger focus.
 */
export function ComposerModelPicker({
  providers,
  value,
  change,
  ready,
  disabled,
  settings,
}: {
  providers: SelectableProvider[];
  value: ModelChoice;
  change: (choice: ModelChoice) => void;
  ready: (valid: boolean) => void;
  disabled: boolean;
  settings: () => void;
}) {
  const surfaceRoot = useSurfaceRoot();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = providers.find((provider) => provider.id === value.providerId);
  /**
   * 依据按钮上下可用空间决定浮层方向并限制尺寸；直接更新样式，使滚动和窗口变化后选择器仍可访问。
   * EN: Chooses a popup direction from the space above and below the trigger and constrains its dimensions. Direct style updates keep the picker reachable after scrolling or resizing.
   */
  const position = () => {
    /**
     * 根据触发按钮上下空间定位浮层；窗口过小时限制宽高以保持可访问。
     * EN: Position the popup using space around the trigger; constrain its dimensions in a small viewport to keep it reachable.
     */
    if (!trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const node = panel.current;
    const margin = 16;
    const gap = 8;
    const width = Math.min(360, window.innerWidth - 32);
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
    node.style.width = `${width}px`;
    const viewportHeight = Math.max(0, window.innerHeight - margin * 2);
    const desiredHeight = Math.min(node.scrollHeight + 2, viewportHeight);
    const above = Math.max(0, Math.min(anchor.top - gap - margin, viewportHeight));
    const below = Math.max(0, Math.min(window.innerHeight - anchor.bottom - gap - margin, viewportHeight));
    let height = viewportHeight;
    let top = margin;
    if (desiredHeight <= above || (above >= below && above >= 120)) {
      height = Math.min(desiredHeight, above);
      top = Math.min(window.innerHeight - margin - height, Math.max(margin, anchor.top - gap - height));
    } else if (desiredHeight <= below || below >= 120) {
      height = Math.min(desiredHeight, below);
      top = Math.min(window.innerHeight - margin - height, Math.max(margin, anchor.bottom + gap));
    }
    Object.assign(node.style, {
      left: `${left}px`,
      top: `${top}px`,
      bottom: 'auto',
      maxHeight: `${height}px`,
    });
  };
  /**
   * 挂载时订阅原生popover开关，打开后定位并聚焦选择框；卸载时解除监听并隐藏原生浮层。
   * EN: Subscribes to native popover toggles on mount, positioning/focusing the select on opening; teardown removes the listener and hides the popover.
   */
  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    /**
     * 从原生popover状态同步React展开标志；打开后重新定位并将焦点交给首个选择框。
     * EN: Synchronizes React open state from the native popover; opening repositions it and focuses the first select control.
     */
    const toggled = () => {
      const visible = node.matches(':popover-open');
      setOpen(visible);
      if (visible) {
        position();
        node.querySelector<HTMLSelectElement>('select')?.focus();
      }
    };
    node.addEventListener('toggle', toggled);
    return () => {
      node.removeEventListener('toggle', toggled);
      node.hidePopover();
    };
  }, []);
  /**
   * 展开期间观察浮层尺寸并监听窗口与滚动变化重新定位；关闭后解除全部几何监听。
   * EN: Observes popup size and viewport/scroll changes for repositioning while open, removing geometry listeners on closure.
   */
  useEffect(() => {
    if (!open) return;
    let frame: number | undefined;
    /**
     * 尺寸观测回调延后到下一帧定位，避免在同一观测周期内再次改变浮层尺寸。
     * EN: Coalesce observed size changes into the next frame to avoid resizing the popup within its observation cycle.
     */
    const schedulePosition = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (panel.current?.matches(':popover-open')) position();
      });
    };
    const observer = new ResizeObserver(schedulePosition);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, [open]);
  /**
   * 禁用状态变化时隐藏原生popover，防止上层禁止切换后遗留仍可操作的菜单。
   * EN: Hides the native popover when disabled so an interactive menu cannot remain after the parent forbids switching.
   */
  useEffect(() => {
    if (disabled) panel.current?.hidePopover();
  }, [disabled]);
  /**
   * 通过原生API隐藏模型选择器并恢复触发器焦点；preventScroll避免关闭时页面跳动。
   * EN: Hides the model picker through the native API and restores trigger focus with preventScroll to avoid a page jump.
   */
  const close = () => {
    panel.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <button
        type="button"
        className="composer-model composer-picker-trigger"
        ref={trigger}
        disabled={disabled}
        aria-label={`选择模型${selected ? `：${selected.label} · ${value.model || selected.model}` : ''}`}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        popoverTarget={id}
        popoverTargetAction="toggle"
        title={selected ? `${selected.label} · ${value.model || selected.model}` : '选择模型'}
        onClick={position}
      >
        <Icon name="spark" size={16} />
        <span className="composer-picker-label">
          <span>{selected ? value.model || selected.label : '选择模型'}</span>
          <small>{selected?.label || (value.providerId ? '原连接不可用' : '未选择连接')}</small>
        </span>
        <Icon name="chevron" size={13} />
      </button>
      {createPortal(
        <div
          className="composer-model-panel composer-picker-panel"
          id={id}
          ref={panel}
          popover="auto"
          role="dialog"
          aria-label="选择模型"
        >
          <div className="composer-model-heading">
            <h3>选择模型</h3>
            <button type="button" className="icon-button" aria-label="关闭模型选择" onClick={close}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <ModelPicker
            providers={providers}
            value={value}
            change={change}
            ready={ready}
            disabled={disabled}
          />
          <div className="composer-model-footer">
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => {
                close();
                settings();
              }}
            >
              模型与连接设置
            </button>
            <button type="button" className="secondary" disabled={disabled} onClick={close}>
              完成
            </button>
          </div>
        </div>,
        surfaceRoot?.current || document.body,
      )}
    </>
  );
}
