/* 管理对话列表的滚动行为。 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import {
  captureHistoryAnchor,
  HistoryAnchorIndex,
  historyViewportVisible,
  restoreHistoryAnchor,
} from './HistoryScroll';
import type { HistoryAnchor } from './HistoryScroll';

/**
 * 对话视口区分“跟随最新”和“查看历史”两种模式：流式增高时前者贴底，后者恢复可见锚点。
 * positionKey 改变会重建位置；initialAnchor 可等待异步消息出现后再定位。
 * 自动加载旧页需要近期真实滚动意图和可见视口，尺寸变化本身不会连续拉取历史。
 */
export function ConversationScroll({
  children,
  positionKey,
  startAtLatest = true,
  onLoadOlder,
  olderCursor,
  olderLoading = false,
  olderError,
  initialAnchor,
  onCheckpoint,
  onReturnLatest,
}: {
  children: ReactNode;
  positionKey?: string;
  startAtLatest?: boolean;
  onLoadOlder?: () => void;
  olderCursor?: string | null;
  olderLoading?: boolean;
  olderError?: string;
  initialAnchor?: HistoryAnchor;
  onCheckpoint?: (position: { anchor?: HistoryAnchor; following: boolean }) => void;
  onReturnLatest?: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const positioned = useRef('');
  const anchor = useRef<ReturnType<typeof captureHistoryAnchor>>(undefined);
  const requestedOlder = useRef('');
  const intentUntil = useRef(0);
  const lastScroll = useRef(0);
  const touchY = useRef(0);
  const pendingOlder = useRef<{ cursor: string; top: number; height: number } | undefined>(undefined);
  const restoring = useRef(false);
  const index = useRef<HistoryAnchorIndex | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const queuedSync = useRef(false);
  const scrolled = useRef(false);
  const geometry = useRef('');
  const checkpointRef = useRef(onCheckpoint);
  checkpointRef.current = onCheckpoint;
  const captureAnchor = (node: HTMLDivElement) => captureHistoryAnchor(node, index.current, anchor.current);
  useLayoutEffect(() => {
    const anchors = new HistoryAnchorIndex(viewport.current!);
    index.current = anchors;
    geometry.current = '';
    return () => {
      anchors.disconnect();
      index.current = undefined;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      queuedSync.current = false;
      scrolled.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const key = JSON.stringify([positionKey]);
    if (positioned.current === key) return;
    positioned.current = key;
    following.current = startAtLatest && !initialAnchor;
    anchor.current = initialAnchor;
    restoring.current = !!initialAnchor;
    requestedOlder.current = '';
    pendingOlder.current = undefined;
    geometry.current = '';
    scrolled.current = false;
    queuedSync.current = false;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    const node = viewport.current;
    if (node) {
      node.scrollTop = following.current ? node.scrollHeight : 0;
      if (restoreHistoryAnchor(node, initialAnchor, index.current)) restoring.current = false;
      lastScroll.current = node.scrollTop;
      if (!restoring.current) anchor.current = captureAnchor(node);
    }
  }, [positionKey, startAtLatest, initialAnchor]);
  /**
   * 在内容或几何变化后校正位置。真实滚动优先于旧锚点；旧页插入时若找不到锚点，
   * 以插入前后总高度差回退定位。恢复完成前不发布新的阅读检查点。
   */
  const sync = () => {
    const node = viewport.current;
    if (!node) return;
    const nextGeometry = `${node.scrollHeight}:${node.clientHeight}:${node.clientWidth}:${index.current?.version()}:${olderCursor}:${olderLoading}`;
    if (!queuedSync.current && !scrolled.current && !restoring.current && geometry.current === nextGeometry)
      return;
    geometry.current = nextGeometry;
    queuedSync.current = false;
    // Native scrolling establishes a new reading position; never restore the
    // preceding frame's anchor over the user's movement.
    // 跟随最新消息时贴底；用户查看历史时恢复可见锚点，避免内容插入造成跳动。
    if (scrolled.current) scrolled.current = false;
    else if (following.current) node.scrollTop = node.scrollHeight;
    else if (restoreHistoryAnchor(node, anchor.current, index.current)) restoring.current = false;
    else if (!restoring.current) {
      const pending = pendingOlder.current;
      if (pending && pending.cursor !== olderCursor)
        node.scrollTop = pending.top + node.scrollHeight - pending.height;
    }
    if (pendingOlder.current && !olderLoading) pendingOlder.current = undefined;
    lastScroll.current = node.scrollTop;
    if (!restoring.current) anchor.current = captureAnchor(node);
    setAway(!following.current || node.scrollHeight - node.clientHeight - node.scrollTop > 96);
    scheduleFrame();
  };
  const syncRef = useRef(sync);
  syncRef.current = sync;
  /** 一帧内合并尺寸同步与检查点回调，避免每个流片段都查询布局和写入位置。 */
  const scheduleFrame = () => {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      if (queuedSync.current) syncRef.current();
      const node = viewport.current;
      if (node && !restoring.current && historyViewportVisible(node))
        checkpointRef.current?.({ anchor: anchor.current, following: following.current });
      frame.current = undefined;
    });
  };
  useLayoutEffect(sync, [children, olderCursor, olderLoading]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      queuedSync.current = true;
      scheduleFrame();
    });
    observer.observe(viewport.current!);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);
  const requestOlder = () => {
    // 只在可见且接近顶部时请求一次旧页，并记录插入前的尺寸用于回退定位。
    const node = viewport.current;
    if (
      !onLoadOlder ||
      !olderCursor ||
      olderLoading ||
      olderError ||
      requestedOlder.current === olderCursor ||
      !historyViewportVisible(node) ||
      node!.scrollTop > 100
    )
      return;
    following.current = false;
    anchor.current = captureAnchor(node!);
    scrolled.current = false;
    pendingOlder.current = { cursor: olderCursor, top: node!.scrollTop, height: node!.scrollHeight };
    requestedOlder.current = olderCursor;
    onLoadOlder();
  };
  return (
    <div className="conversation-history">
      <div
        ref={viewport}
        className="conversation-scroll"
        aria-busy={olderLoading || undefined}
        onScroll={(event) => {
          const node = event.currentTarget;
          const upward = node.scrollTop < lastScroll.current;
          lastScroll.current = node.scrollTop;
          if (restoring.current && performance.now() >= intentUntil.current) return;
          restoring.current = false;
          following.current = startAtLatest && node.scrollHeight - node.clientHeight - node.scrollTop <= 96;
          scrolled.current = true;
          queuedSync.current = true;
          scheduleFrame();
          if (upward && performance.now() < intentUntil.current) requestOlder();
        }}
        onWheel={(event) => {
          if (event.deltaY >= 0) return;
          following.current = false;
          intentUntil.current = performance.now() + 1000;
          requestOlder();
        }}
        onPointerDown={() => {
          intentUntil.current = performance.now() + 2000;
        }}
        onTouchStart={(event) => {
          touchY.current = event.touches[0]?.clientY || 0;
        }}
        onTouchMove={(event) => {
          const next = event.touches[0]?.clientY ?? touchY.current;
          if (next > touchY.current) {
            following.current = false;
            intentUntil.current = performance.now() + 1000;
            requestOlder();
          }
          touchY.current = next;
        }}
        onKeyDown={(event) => {
          if (!['ArrowUp', 'PageUp', 'Home'].includes(event.key)) return;
          following.current = false;
          intentUntil.current = performance.now() + 1000;
          requestOlder();
        }}
      >
        <div ref={content}>{children}</div>
      </div>
      {away && (
        <button
          type="button"
          className="latest-message secondary"
          onClick={() => {
            if (onReturnLatest) {
              onReturnLatest();
              return;
            }
            following.current = true;
            sync();
          }}
        >
          <Icon name="arrow" size={14} /> 回到最新消息
        </button>
      )}
    </div>
  );
}
