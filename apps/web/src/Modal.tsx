/**
 * 提供通用弹窗及其错误提示上下文。
 * 统一入口内弹窗的焦点捕获、Escape/Tab处理、滚动锁定及错误提示作用域；仅最上层弹窗响应键盘。
 * EN: Provides shared modal layout and error context. Centralizes surface-local modal focus, Escape/Tab handling, scroll locking, and error-feedback scope, allowing only the top modal to handle keys.
 */
import { useSurfaceRoot } from './SurfaceClientContext';
import { createContext, useContext, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { usePresenceMotion } from './Motion';

export const ModalErrorContext = createContext('');

/**
 * 通用模态容器：在当前入口内隔离背景交互，顶层弹窗拥有 Tab 环和 Esc 行为。
 * busy 阻止背景点击和 Esc 关闭；退出动画期间立即取消交互，销毁后恢复原 inert 和焦点。
 * 最新 close/busy 保存在 ref 中，使长期键盘监听不捕获过期回调。
 * EN: Isolate background interaction per surface. Only the top modal traps Tab/Escape; busy blocks backdrop/Escape closure. Disable interaction at exit start, then restore prior inert/focus state on removal. Refs keep keyboard handlers on the latest close/busy values.
 */
export function Modal({
  title,
  subtitle,
  close,
  children,
  wide = false,
  className = '',
  busy = false,
}: {
  title: string;
  subtitle?: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  busy?: boolean;
}) {
  const surfaceRoot = useSurfaceRoot();
  const ref = useRef<HTMLElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const present = usePresenceMotion(ref, 'dialog');
  usePresenceMotion(overlay, 'scrim');
  const closeRef = useRef(close);
  const busyRef = useRef(busy);
  const titleId = useId();
  const descriptionId = useId();
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [descriptionOverflow, setDescriptionOverflow] = useState(false);
  /**
   * 说明溢出时才加入键盘阅读顺序；窗口缩放或文本变化后重新测量，不改变当前焦点。
   * EN: Add overflowing descriptions to keyboard navigation, remeasuring after resize/text changes without moving focus.
   */
  useLayoutEffect(() => {
    const node = descriptionRef.current;
    if (!node) return;
    const measure = () => setDescriptionOverflow(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [subtitle, present]);
  const error = useContext(ModalErrorContext);
  closeRef.current = close;
  busyRef.current = busy;
  useLayoutEffect(() => {
    if (!present) return;
    /**
     * 弹窗展示时使主内容和侧栏不可交互，关闭时恢复它们原本的 inert 状态。
     * EN: Make main content and sidebar inert while displayed, restoring their original inert values on close.
     */
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    const shell = (surfaceRoot?.current || document).querySelector<HTMLElement>('.main');
    const sidebar = (surfaceRoot?.current || document).querySelector<HTMLElement>('.sidebar');
    const targets = [shell, sidebar].filter((node): node is HTMLElement => !!node);
    const inert = targets.map((node) => node.inert);
    targets.forEach((node) => {
      node.inert = true;
    });
    dialog.focus();
    /**
     * 只让当前入口最上层弹窗响应键盘：非输入法组合状态下处理Escape，并将Tab焦点循环限制在可操作控件内。
     * EN: Lets only the top dialog in the current surface handle keys: Escape closes outside IME composition, and Tab cycles through usable controls inside the dialog.
     */
    const keydown = (event: KeyboardEvent) => {
      const dialogs = (surfaceRoot?.current || document).querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
      /**
       * 仅顶层弹窗处理键盘导航，Tab 循环在可见且可操作的控件之间。
       * EN: Only the top modal handles keys; cycle Tab among visible, usable controls.
       */
      const elements = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], summary, [tabindex="0"]',
        ),
      ].filter((node) => !node.matches(':disabled, [hidden]') && node.getClientRects().length);
      const first = elements[0],
        last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        dialog.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last! : first).focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last!.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      targets.forEach((node, i) => {
        node.inert = inert[i];
      });
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, [present]);
  return (
    <div
      ref={overlay}
      className="overlay"
      data-leaving={!present || undefined}
      inert={!present}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) close();
      }}
    >
      <section
        ref={ref}
        className={`modal ${wide ? 'wide' : ''} ${className}`}
        role={present ? 'dialog' : undefined}
        aria-modal={present ? 'true' : undefined}
        aria-labelledby={titleId}
        aria-describedby={subtitle ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && (
              <p
                ref={descriptionRef}
                className="modal-description"
                id={descriptionId}
                title={subtitle}
                tabIndex={descriptionOverflow ? 0 : undefined}
                role={descriptionOverflow ? 'region' : undefined}
                aria-label={descriptionOverflow ? '窗口完整说明' : undefined}
              >
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            disabled={busy}
            aria-label="关闭"
            title="关闭 · Esc"
          >
            <Icon name="close" />
          </button>
        </header>
        {error && (
          <div className="modal-operation-error" role="alert" aria-label="操作失败详情" tabIndex={0}>
            {error}
          </div>
        )}
        {children}
      </section>
    </div>
  );
}
