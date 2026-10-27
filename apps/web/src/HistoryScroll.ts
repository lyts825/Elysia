/**
 * 捕获和恢复历史列表的滚动锚点。
 * 建立按需失效的DOM锚点索引，并捕获、恢复视口位置；只在有布局且非inert的可见历史区域执行自动定位。
 * EN: Captures and restores scroll anchors in history lists. Provides a lazily invalidated DOM-anchor index and viewport capture/restoration, applying automatic positioning only to visible laid-out non-inert history regions.
 */
export type HistoryAnchor = { id: string; offset: number };

/**
 * 为一个历史视口缓存锚点节点及 ID 索引。只在锚点节点增删或标识改变时重建，
 * 流式文字与普通属性更新不使索引失效；使用者卸载时必须 disconnect。
 * EN: Cache anchor nodes and an ID index for one history viewport. Rebuild only after anchor nodes or identities change; streaming text and ordinary attribute updates do not invalidate it. The owner must disconnect on unmount.
 */
export class HistoryAnchorIndex {
  private dirty = true;
  private entries: HTMLElement[] = [];
  private byId = new Map<string, HTMLElement>();
  private revision = 0;
  private observer: MutationObserver;
  /**
   * 观察视口中锚点相关DOM变更；只记录索引失效，真正查询时再重建，降低流式文本更新成本。
   * EN: Observes anchor-related DOM changes in the viewport. It marks the index dirty and rebuilds only on demand, reducing work during streamed text updates.
   */
  constructor(private viewport: HTMLElement) {
    this.observer = new MutationObserver((records) => this.changed(records));
    this.observer.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-history-anchor'],
    });
  }
  /**
   * 检查变更是否新增、移除或改名锚点；只让相关结构变化使索引失效，普通文本变化不触发重建。
   * EN: Checks whether mutations add, remove, or rename anchors; only relevant structural changes invalidate the index, while ordinary text updates do not.
   */
  private changed(records: MutationRecord[]) {
    /**
     * 只在锚点节点增删或标识变化时失效；文字流更新不需要重建索引。
     * EN: Invalidate only when anchor nodes are added, removed, or renamed; streaming text does not require rebuilding the index.
     */
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
  /**
   * 同步消费尚未回调的 DOM 变更，保证 React layout effect 能读到本次提交的新锚点。
   * EN: Consume pending DOM mutations synchronously so a React layout effect can see anchors from the current commit.
   */
  nodes() {
    /**
     * React 布局 effect 在 DOM 提交后早于观察器回调执行。
     * EN: React layout effects run before the observer callback after a DOM commit.
     */
    this.changed(this.observer.takeRecords());
    if (this.dirty) {
      this.entries = [...this.viewport.querySelectorAll<HTMLElement>('[data-history-anchor]')];
      this.byId = new Map(this.entries.map((node) => [node.dataset.historyAnchor!, node]));
      this.dirty = false;
      this.revision++;
    }
    return this.entries;
  }
  /**
   * 先按需刷新锚点索引，再按稳定ID返回DOM节点；不存在时返回undefined。
   * EN: Refreshes the anchor index on demand and returns the DOM node for a stable ID, or undefined if absent.
   */
  find(id: string) {
    this.nodes();
    return this.byId.get(id);
  }
  /**
   * 返回按需重建后的索引修订号，供布局同步判断锚点结构是否变化。
   * EN: Returns the index revision after any on-demand rebuild so layout synchronization can detect anchor-structure changes.
   */
  version() {
    this.nodes();
    return this.revision;
  }
  /**
   * 解除DOM观察并清空节点引用和索引，避免视口卸载后继续持有历史元素。
   * EN: Disconnects DOM observation and clears nodes and lookup entries so unmounted history elements are no longer retained.
   */
  disconnect() {
    this.observer.disconnect();
    this.entries = [];
    this.byId.clear();
  }
}

/**
 * 只有文档可见、节点有布局尺寸且不位于 inert 子树时，才允许自动分页或保存位置。
 * EN: Allow automatic paging or checkpoint saves only while the document is visible, the node has layout dimensions, and it is outside inert subtrees.
 */
export function historyViewportVisible(viewport: HTMLElement | null) {
  return !!(
    viewport &&
    document.visibilityState !== 'hidden' &&
    viewport.getClientRects().length &&
    viewport.clientHeight &&
    !viewport.closest('[inert]')
  );
}

/**
 * 返回可视消息及其距视口顶部的像素偏移；优先复用仍可见的指定锚点。
 * EN: Return the visible message and its pixel offset from the viewport top, preferring a requested anchor that is still visible.
 */
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

/**
 * 按锚点当前位置修正滚动量；目标不存在时返回 false，交由调用方选择回退。
 * EN: Adjust scrolling using the current anchor position. Return false if the target is absent, letting the caller choose a fallback.
 */
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
