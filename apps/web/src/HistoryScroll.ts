/* 捕获和恢复历史列表的滚动锚点。 */
export type HistoryAnchor = { id: string; offset: number };

/** One bounded viewport index; text updates do not invalidate its anchor nodes. */
export class HistoryAnchorIndex {
  private dirty = true;
  private entries: HTMLElement[] = [];
  private byId = new Map<string, HTMLElement>();
  private revision = 0;
  private observer: MutationObserver;
  constructor(private viewport: HTMLElement) {
    this.observer = new MutationObserver((records) => this.changed(records));
    this.observer.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-history-anchor'],
    });
  }
  private changed(records: MutationRecord[]) {
    if (this.dirty) return;
    this.dirty = records.some(
      (record) =>
        record.type === 'attributes' ||
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.hasAttribute('data-history-anchor') || !!node.querySelector('[data-history-anchor]')),
        ),
    );
  }
  nodes() {
    // React layout effects run before the observer callback after a DOM commit.
    this.changed(this.observer.takeRecords());
    if (this.dirty) {
      this.entries = [...this.viewport.querySelectorAll<HTMLElement>('[data-history-anchor]')];
      this.byId = new Map(this.entries.map((node) => [node.dataset.historyAnchor!, node]));
      this.dirty = false;
      this.revision++;
    }
    return this.entries;
  }
  find(id: string) {
    this.nodes();
    return this.byId.get(id);
  }
  version() {
    this.nodes();
    return this.revision;
  }
  disconnect() {
    this.observer.disconnect();
    this.entries = [];
    this.byId.clear();
  }
}

export function historyViewportVisible(viewport: HTMLElement | null) {
  return !!(
    viewport &&
    document.visibilityState !== 'hidden' &&
    viewport.getClientRects().length &&
    viewport.clientHeight &&
    !viewport.closest('[inert]')
  );
}

export function captureHistoryAnchor(
  viewport: HTMLElement | null,
  index?: HistoryAnchorIndex,
  preferred?: HistoryAnchor,
): HistoryAnchor | undefined {
  if (!viewport) return;
  const bounds = viewport.getBoundingClientRect();
  const nodes = index?.nodes() || viewport.querySelectorAll<HTMLElement>('[data-history-anchor]');
  const target =
    preferred &&
    (index
      ? index.find(preferred.id)
      : [...nodes].find((node) => node.dataset.historyAnchor === preferred.id));
  if (target) {
    const rect = target.getBoundingClientRect();
    if (rect.bottom > bounds.top && rect.top < bounds.bottom)
      return { id: preferred!.id, offset: rect.top - bounds.top };
  }
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { id: node.dataset.historyAnchor!, offset: rect.top - bounds.top };
    }
  }
}

export function restoreHistoryAnchor(
  viewport: HTMLElement,
  anchor: HistoryAnchor | undefined,
  index?: HistoryAnchorIndex,
) {
  if (!anchor) return false;
  const node = index
    ? index.find(anchor.id)
    : [...viewport.querySelectorAll<HTMLElement>('[data-history-anchor]')].find(
        (item) => item.dataset.historyAnchor === anchor.id,
      );
  if (!node) return false;
  const delta = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
  return true;
}
