/**
 * 切换可用的界面视图。
 * 展示原生与终端入口选择菜单并管理视口定位、外部关闭和焦点恢复；入口切换的状态保存与导航由父组件完成。
 * EN: Selects between available workspace surfaces. Displays native/terminal choices with viewport placement, outside dismissal, and focus return; parents preserve state and perform surface navigation.
 */
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

/**
 * 按当前客户端显示入口菜单，change 只在未忙碌时发出目标入口选择。
 * portal 限定在当前入口根，菜单支持方向键/Home/End；外部点击、滚动或尺寸变化关闭，
 * Esc/Tab 关闭时恢复触发焦点，避免已改变布局的菜单仍悬在旧位置。
 * EN: Show menu for current client; change reports target only when not busy. Portal inside surface root with arrows/Home/End. Outside click/scroll/resize closes it; Escape/Tab restores trigger focus so stale-position menus do not remain.
 */
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
  const statusId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = surfaces.find((surface) => surface.id === localSurface)!;
  /**
   * 关闭入口切换菜单，按调用场景选择是否归还触发焦点，避免外部交互时抢焦点。
   * EN: Closes the surface menu and optionally restores trigger focus according to the dismissal context, avoiding focus theft on outside interaction.
   */
  const dismiss = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    /**
     * 菜单定位受视口边界约束，打开后将焦点移到当前入口。
     * EN: Constrain placement to viewport and focus current surface after opening.
     */
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
    /**
     * 仅当指针位于菜单与触发按钮之外时关闭，保留菜单内部操作。
     * EN: Closes only for pointer events outside both menu and trigger, preserving interaction within them.
     */
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        dismiss();
    };
    /**
     * 窗口调整或外部滚动时关闭已定位菜单；菜单内部滚动仍允许，以免选项较多时无法操作。
     * EN: Closes the positioned menu after resize or outside scrolling while allowing internal menu scrolling when options overflow.
     */
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
            {(disabled || switching) && (
              <p className="surface-menu-status" id={statusId} role="status">
                {switching ? '正在切换入口…' : '当前操作完成后可切换入口'}
              </p>
            )}
            {surfaces.map((surface) => (
              <button
                key={surface.id}
                type="button"
                role="menuitemradio"
                aria-checked={surface.id === localSurface}
                tabIndex={surface.id === localSurface ? 0 : -1}
                aria-disabled={disabled || switching}
                aria-describedby={disabled || switching ? statusId : undefined}
                onClick={() => {
                  if (disabled || switching) return;
                  dismiss();
                  change(surface.id);
                }}
              >
                <Icon name={surface.icon} size={20} />
                <span className="surface-option-label">
                  <span className="surface-option-title">
                    <strong>{surface.label}</strong>
                    {surface.id === localSurface && (
                      <span className="surface-option-current" aria-hidden="true">
                        当前入口
                      </span>
                    )}
                  </span>
                  <small>{surface.description}</small>
                </span>
                {surface.id === localSurface && <Icon name="check" size={18} />}
              </button>
            ))}
          </div>,
          surfaceRoot?.current || document.body,
        )}
    </>
  );
}
