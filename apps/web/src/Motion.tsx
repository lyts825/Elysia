/**
 * 提供动画过渡、存在状态及减少动态效果的辅助能力。
 * 为入退场、位置变化和标签内容提供Web Animations封装，协调退出子树寿命与减少动态效果偏好；业务状态由调用方控制。
 * EN: Provides motion, presence, and reduced-motion helpers. Wraps Web Animations for presence, position, and tab transitions, coordinating exiting-subtree lifetime and reduced-motion preference while callers own business state.
 */
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
/**
 * 动画偏好作为外部状态订阅，系统设置变化时更新所有使用者。
 * EN: Subscribe to system animation preference as external state for all consumers.
 */
const subscribe = (notify: () => void) => {
  preference.addEventListener('change', notify);
  return () => preference.removeEventListener('change', notify);
};
/**
 * 共享系统减少动态效果偏好；使用外部存储订阅，避免每个组件维护重复媒体状态。
 * EN: Share reduced-motion preference through an external store instead of duplicate component media state.
 */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, () => preference.matches);
}
/**
 * 从节点CSS变量取得入场或退场时长与缓动，兼容秒和毫秒；缺省使用内置值并保持动画最终帧。
 * EN: Reads entry or exit duration and easing from node CSS variables, supporting seconds and milliseconds with defaults and a retained final frame.
 */
const timing = (node: HTMLElement, exit = false): KeyframeAnimationOptions => {
  /**
   * 优先读取 CSS 变量；未配置时使用入场和退场的默认时长。
   * EN: Prefer CSS timing variables, with entry/exit defaults when absent.
   */
  const css = getComputedStyle(node);
  const duration = css.getPropertyValue(exit ? '--motion-exit' : '--motion-enter').trim();
  return {
    duration: parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000) || (exit ? 160 : 240),
    easing: css.getPropertyValue(exit ? '--ease-exit' : '--ease-enter').trim() || 'ease-out',
    fill: 'both',
  };
};

const PresenceContext = createContext({
  present: true,
  /**
   * 提供未处于Presence边界时的空移除操作，保证消费方能够安全调用上下文接口。
   * EN: Provides a no-op removal outside a Presence boundary so consumers can safely call the context interface.
   */
  remove: () => {},
});

/**
 * 子树消失后仅保留一份退出中的元素供动画使用；present 立即变 false，子组件应同时
 * 移除焦点与命中能力。若退出完成前重新显示，旧 remove 不会误删新内容。
 * EN: Retain one exiting subtree for animation while present immediately becomes false, removing focus/hit capability. Reopening before exit finishes prevents old removal from deleting the new content.
 */
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

/**
 * 根据 Presence 状态执行入场/退场；中断时从屏幕上的当前样式继续，而不是跳回起点。
 * 面板或弹窗完成退出后移除保留子树，scrim 不单独移除；减少动态效果时直接完成生命周期。
 * EN: Animate Presence entry/exit from the current onscreen style after interruption. Remove retained panels/dialogs after exit, not scrims separately; reduced motion completes lifecycle directly.
 */
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

/**
 * motionKey 改变时对新内容执行轻微入场；反复切换时从正在显示的位置接续。
 * EN: Apply subtle entry on motionKey change; repeated switches continue from visible position.
 */
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

/**
 * change(update) 在 React 更新前测量位置，布局提交后用反向位移过渡到新位置。
 * 连续点击会取消旧动画并从当前屏幕位置接续；宽度未实际导致横向移动时不创建动画。
 * EN: change(update) measures before React updates, then animates inverse displacement after commit. Repeated actions cancel old motion and continue onscreen; skip when width changes cause no horizontal movement.
 */
export function usePositionMotion<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const previous = useRef<DOMRect | null>(null);
  const active = useRef<Animation | null>(null);
  const reduced = useReducedMotion();
  /**
   * 在状态更新前捕获元素旧边界，再调用外部更新；布局effect以旧新位置差执行FLIP过渡。
   * EN: Captures the element bounds before invoking a state update; the layout effect uses the old/new difference for a FLIP transition.
   */
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

/**
 * 选中按钮的尺寸驱动标签底板；选项切换可动画，ResizeObserver 重排只校正位置。
 * EN: Selected-button dimensions drive the backing; selections may animate, while ResizeObserver corrections update directly.
 */
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
