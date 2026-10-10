export type HistoryAnchor = { id: string; offset: number };

export function historyViewportVisible(viewport: HTMLElement | null) {
  return !!(
    viewport &&
    document.visibilityState !== 'hidden' &&
    viewport.getClientRects().length &&
    viewport.clientHeight &&
    !viewport.closest('[inert]')
  );
}

export function captureHistoryAnchor(viewport: HTMLElement | null): HistoryAnchor | undefined {
  if (!viewport) return;
  const bounds = viewport.getBoundingClientRect();
  for (const node of viewport.querySelectorAll<HTMLElement>('[data-history-anchor]')) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { id: node.dataset.historyAnchor!, offset: rect.top - bounds.top };
    }
  }
}

export function restoreHistoryAnchor(viewport: HTMLElement, anchor: HistoryAnchor | undefined) {
  if (!anchor) return false;
  const node = [...viewport.querySelectorAll<HTMLElement>('[data-history-anchor]')].find(
    (item) => item.dataset.historyAnchor === anchor.id,
  );
  if (!node) return false;
  const delta = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
  return true;
}
