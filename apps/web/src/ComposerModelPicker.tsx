import { useSurfaceRoot } from './SurfaceClientContext';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { ModelPicker, type ModelChoice, type SelectableProvider } from './ModelPicker';
import './composer-model-picker.css';

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
  const position = () => {
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
  useEffect(() => {
    const node = panel.current;
    if (!node) return;
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
  useEffect(() => {
    if (!open) return;
    const observer = new ResizeObserver(position);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) panel.current?.hidePopover();
  }, [disabled]);
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
