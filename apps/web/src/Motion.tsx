import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';

const preference = matchMedia('(prefers-reduced-motion: reduce)');
const subscribe = (notify: () => void) => {
  preference.addEventListener('change', notify);
  return () => preference.removeEventListener('change', notify);
};
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, () => preference.matches);
}
const timing = (node: HTMLElement, exit = false): KeyframeAnimationOptions => {
  const css = getComputedStyle(node);
  const duration = css.getPropertyValue(exit ? '--motion-exit' : '--motion-enter').trim();
  return {
    duration: parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000) || (exit ? 160 : 240),
    easing: css.getPropertyValue(exit ? '--ease-exit' : '--ease-enter').trim() || 'ease-out',
    fill: 'both',
  };
};

const PresenceContext = createContext({ present: true, remove: () => {} });

// Retain only the outgoing surface. Its focus and hit testing end immediately.
export function Presence({ children }: { children: ReactElement | null | false }) {
  const [retained, setRetained] = useState(children);
  if (children && children !== retained) setRetained(children);
  const present = !!children;
  const live = useRef(present);
  live.current = present;
  const remove = useCallback(() => {
    if (!live.current) setRetained(null);
  }, []);
  return (
    <PresenceContext.Provider value={{ present, remove }}>{children || retained}</PresenceContext.Provider>
  );
}

export function usePresenceMotion<T extends HTMLElement>(
  ref: RefObject<T | null>,
  kind: 'dialog' | 'panel' | 'scrim',
) {
  const { present, remove } = useContext(PresenceContext);
  const reduced = useReducedMotion();
  const active = useRef<Animation | null>(null);
  const entered = useRef(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const offset =
      kind === 'dialog' ? 'translateY(12px) scale(.985)' : kind === 'panel' ? 'translateX(20px)' : 'none';
    const css = getComputedStyle(node);
    const from = entered.current
      ? { opacity: css.opacity, transform: css.transform }
      : { opacity: '0', transform: offset };
    entered.current = true;
    active.current?.cancel();
    if (reduced) {
      if (!present && kind !== 'scrim') remove();
      return;
    }
    const animation = node.animate(
      [from, { opacity: present ? '1' : '0', transform: present ? 'none' : offset }],
      { ...timing(node, !present), id: `elysia-${kind}-${present ? 'enter' : 'exit'}` },
    );
    active.current = animation;
    animation.onfinish = () => {
      if (present) animation.cancel();
      else if (kind !== 'scrim') remove();
    };
  }, [present, reduced, kind, ref, remove]);
  useLayoutEffect(() => () => active.current?.cancel(), []);
  return present;
}

export function MotionContent({
  motionKey,
  children,
  elementRef,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  motionKey: string;
  children: ReactNode;
  elementRef?: { current: HTMLDivElement | null };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useRef<Animation | null>(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const node = ref.current!;
    const css = getComputedStyle(node);
    const from =
      active.current?.playState === 'running'
        ? { opacity: css.opacity, transform: css.transform }
        : { opacity: '.65', transform: 'translateY(5px)' };
    active.current?.cancel();
    if (reduced) return;
    const animation = node.animate([from, { opacity: 1, transform: 'none' }], {
      ...timing(node),
      id: 'elysia-content',
      fill: 'none',
    });
    active.current = animation;
  }, [motionKey, reduced]);
  useLayoutEffect(() => () => active.current?.cancel(), []);
  return (
    <div
      {...props}
      ref={(node) => {
        ref.current = node;
        if (elementRef) elementRef.current = node;
      }}
    >
      {children}
    </div>
  );
}

// Measure before the React update; successive presses start at the on-screen position.
export function usePositionMotion<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const previous = useRef<DOMRect | null>(null);
  const active = useRef<Animation | null>(null);
  const reduced = useReducedMotion();
  const change = (update: () => void) => {
    previous.current = ref.current?.getBoundingClientRect() || null;
    update();
  };
  useLayoutEffect(() => {
    if (reduced) active.current?.cancel();
    const node = ref.current,
      before = previous.current;
    previous.current = null;
    if (!node || !before) return;
    active.current?.cancel();
    if (reduced) return;
    const after = node.getBoundingClientRect(),
      x = before.left - after.left;
    if (Math.abs(x) < 0.5) return;
    const animation = node.animate([{ transform: `translateX(${x}px)` }, { transform: 'none' }], {
      ...timing(node),
      id: 'elysia-layout',
      fill: 'none',
    });
    active.current = animation;
  });
  useLayoutEffect(() => () => active.current?.cancel(), []);
  return { ref, change };
}

export function MotionTabs({
  value,
  label,
  className,
  children,
}: {
  value: string;
  label: string;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const active = useRef<Animation | null>(null);
  const placed = useRef(false);
  const reduced = useReducedMotion();
  const place = useCallback(
    (animate: boolean) => {
      const nav = ref.current,
        indicator = marker.current;
      const selected = nav?.querySelector<HTMLElement>('button[aria-pressed="true"]');
      if (!nav || !indicator || !selected) return;
      const before = indicator.getBoundingClientRect();
      active.current?.cancel();
      indicator.style.left = `${selected.offsetLeft}px`;
      indicator.style.top = `${selected.offsetTop}px`;
      indicator.style.width = `${selected.offsetWidth}px`;
      indicator.style.height = `${selected.offsetHeight}px`;
      indicator.style.visibility = 'visible';
      const after = indicator.getBoundingClientRect();
      if (animate && placed.current && !reduced && after.width) {
        active.current = indicator.animate(
          [
            { transform: `translateX(${before.left - after.left}px) scaleX(${before.width / after.width})` },
            { transform: 'none' },
          ],
          { ...timing(indicator), id: 'elysia-tab', fill: 'none' },
        );
      }
      placed.current = true;
    },
    [reduced],
  );
  useLayoutEffect(() => {
    place(true);
  }, [value, place]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => place(false));
    observer.observe(ref.current!);
    return () => {
      observer.disconnect();
      active.current?.cancel();
    };
  }, [place]);
  return (
    <nav ref={ref} className={`${className} motion-tabs`} aria-label={label}>
      <span className="tab-indicator" aria-hidden="true" ref={marker} />
      {children}
    </nav>
  );
}
