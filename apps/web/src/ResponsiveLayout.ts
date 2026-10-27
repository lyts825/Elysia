/* 提供视口匹配和抽屉焦点管理的 React Hook。 */
import { useSurfaceRoot } from './SurfaceClientContext';
import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';

/** 订阅媒体查询变化，视口改变时触发 React 更新并在卸载时移除监听。 */
export function useViewportMatch(query: string) {
  const media = useMemo(() => matchMedia(query), [query]);
  return useSyncExternalStore(
    useCallback(
      (changed) => {
        media.addEventListener('change', changed);
        return () => media.removeEventListener('change', changed);
      },
      [media],
    ),
    () => media.matches,
  );
}

/**
 * 为保持挂载的响应式抽屉管理焦点。仅当前入口的最上层 dialog 可处理 Tab/Esc，
 * portal 菜单保留自身键盘控制；关闭后只在原元素仍可用且没有遮罩时恢复焦点。
 */
export function useDrawerFocus(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  // 抽屉打开时接管焦点；关闭后仅在原元素可用且没有其他遮罩时恢复焦点。
  const surfaceRoot = useSurfaceRoot();
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const drawer = ref.current;
    if (!open || !drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    drawer.querySelector<HTMLElement>('[data-drawer-close]')?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      const dialogs = (surfaceRoot?.current || document).querySelectorAll('[role="dialog"]');
      if (event.defaultPrevented || dialogs[dialogs.length - 1] !== drawer) return;
      // A portalled session menu owns its keyboard navigation.
      if ((event.target as HTMLElement).closest('[role="menu"]')) return;
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      // Tab 在当前抽屉的可见可用控件之间循环，不将焦点移到背景。
      const elements = [
        ...drawer.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], summary, [tabindex="0"]',
        ),
      ].filter(
        (node) =>
          !node.matches(':disabled, [hidden]') && !node.closest('[inert]') && node.getClientRects().length,
      );
      const first = elements[0],
        last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        drawer.focus();
      } else if (!drawer.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last! : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last!.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      if (
        previous?.isConnected &&
        !previous.closest('[inert]') &&
        !(surfaceRoot?.current || document).querySelector('.overlay')
      )
        previous.focus({ preventScroll: true });
    };
  }, [open, ref]);
}
