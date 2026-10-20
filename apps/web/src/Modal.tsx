import { useSurfaceRoot } from './SurfaceClientContext';
import { createContext, useContext, useLayoutEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { usePresenceMotion } from './Motion';

export const ModalErrorContext = createContext('');

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
  const error = useContext(ModalErrorContext);
  closeRef.current = close;
  busyRef.current = busy;
  useLayoutEffect(() => {
    if (!present) return;
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
    const keydown = (event: KeyboardEvent) => {
      const dialogs = (surfaceRoot?.current || document).querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
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
              <p id={descriptionId} title={subtitle}>
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
          <div className="modal-operation-error" role="alert">
            {error}
          </div>
        )}
        {children}
      </section>
    </div>
  );
}
