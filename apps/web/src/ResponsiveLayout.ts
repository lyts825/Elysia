import { useSurfaceRoot } from './SurfaceClientContext';
import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';

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

// Keep navigation mounted so searches, menus and drafts survive resizing.
export function useDrawerFocus(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
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
