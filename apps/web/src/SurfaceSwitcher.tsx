import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSurfaceClient, useSurfaceRoot } from './SurfaceClientContext';
import { BrandIcon } from './Brand';
import { Icon } from './Icon';
import './surface.css';
import './surface-switcher.css';

const surfaces = [
  { id: 'native', label: 'Elysia', description: '原生 API · 协作与交付', icon: 'spark' },
  { id: 'terminal', label: 'Agent 终端', description: 'DSH / Codex CLI · Docker 调度', icon: 'terminal' },
] as const;

export function SurfaceSwitcher({
  disabled,
  switching,
  change,
}: {
  disabled: boolean;
  switching: boolean;
  change: (surface: 'native' | 'terminal') => void;
}) {
  const { surface: localSurface } = useSurfaceClient();
  const surfaceRoot = useSurfaceRoot();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = surfaces.find((surface) => surface.id === localSurface)!;
  const dismiss = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const node = menu.current;
    node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - node.offsetHeight - 8))}px`;
    const current = node.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    current?.focus({ preventScroll: true });
    current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        dismiss();
    };
    const moved = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      dismiss();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', moved);
    document.addEventListener('scroll', moved, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', moved);
      document.removeEventListener('scroll', moved, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="surface-trigger"
        aria-label={`切换入口 · ${selected.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={selected.label}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {localSurface === 'native' ? <BrandIcon /> : <Icon name="terminal" size={25} />}
        <span>{selected.label}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            className="surface-menu"
            role="menu"
            aria-label="选择入口"
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'Tab') {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                }
                dismiss(true);
                return;
              }
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
              ];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              let next: number | undefined;
              if (event.key === 'ArrowDown') next = (index + 1) % items.length;
              if (event.key === 'ArrowUp') next = (index + items.length - 1) % items.length;
              if (event.key === 'Home') next = 0;
              if (event.key === 'End') next = items.length - 1;
              if (next !== undefined) {
                event.preventDefault();
                items[next]?.focus({ preventScroll: true });
                items[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              }
            }}
          >
            <p className="surface-menu-heading" role="presentation">
              工作入口
            </p>
            {surfaces.map((surface) => (
              <button
                key={surface.id}
                type="button"
                role="menuitemradio"
                aria-checked={surface.id === localSurface}
                tabIndex={surface.id === localSurface ? 0 : -1}
                aria-disabled={disabled || switching}
                onClick={() => {
                  if (disabled || switching) return;
                  dismiss();
                  change(surface.id);
                }}
              >
                <Icon name={surface.icon} size={20} />
                <span className="surface-option-label">
                  <strong>{surface.label}</strong>
                  <small>{surface.description}</small>
                </span>
                {surface.id === localSurface && <Icon name="check" size={18} />}
              </button>
            ))}
            {(disabled || switching) && (
              <p role="status">{switching ? '正在切换…' : '当前操作完成后可切换'}</p>
            )}
          </div>,
          surfaceRoot?.current || document.body,
        )}
    </>
  );
}
