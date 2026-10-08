import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { ModelPicker, type ModelChoice, type SelectableProvider } from './ModelPicker';

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
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = providers.find((provider) => provider.id === value.providerId);
  const position = () => {
    if (!trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 32);
    const left = Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16));
    Object.assign(panel.current.style, {
      width: `${width}px`,
      left: `${left}px`,
      bottom: `${Math.max(16, window.innerHeight - anchor.top + 8)}px`,
      maxHeight: `${Math.max(120, anchor.top - 24)}px`,
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
    return () => node.removeEventListener('toggle', toggled);
  }, []);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
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
        className="composer-model"
        ref={trigger}
        disabled={disabled}
        aria-label={`选择模型${selected ? `：${value.model || selected.label}` : ''}`}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        popoverTarget={id}
        popoverTargetAction="toggle"
        title={selected ? `${selected.label} · ${value.model || selected.model}` : '选择模型'}
        onClick={position}
      >
        <Icon name="spark" size={16} />
        <span>{selected ? value.model || selected.label : '选择模型'}</span>
        <Icon name="chevron" size={13} />
      </button>
      {createPortal(
        <div
          className="composer-model-panel"
          id={id}
          ref={panel}
          popover="auto"
          role="dialog"
          aria-label="选择模型"
        >
          <div className="composer-model-heading">
            <strong>选择模型</strong>
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
        document.body,
      )}
    </>
  );
}
