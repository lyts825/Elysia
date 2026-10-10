import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { captureHistoryAnchor, historyViewportVisible, restoreHistoryAnchor } from './HistoryScroll';
import type { HistoryAnchor } from './HistoryScroll';

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
  const captureAnchor = (node: HTMLDivElement) => {
    const preferred = anchor.current;
    if (preferred) {
      const bounds = node.getBoundingClientRect();
      const target = [...node.querySelectorAll<HTMLElement>('[data-history-anchor]')].find(
        (item) => item.dataset.historyAnchor === preferred.id,
      );
      const rect = target?.getBoundingClientRect();
      // A visible tool card has its own anchor inside an assistant message.
      // Preserve the selected card until the reader scrolls past it.
      if (rect && rect.bottom > bounds.top && rect.top < bounds.bottom)
        return { id: preferred.id, offset: rect.top - bounds.top };
    }
    return captureHistoryAnchor(node);
  };
  useLayoutEffect(() => {
    const key = JSON.stringify([positionKey]);
    if (positioned.current === key) return;
    positioned.current = key;
    following.current = startAtLatest && !initialAnchor;
    anchor.current = initialAnchor;
    restoring.current = !!initialAnchor;
    requestedOlder.current = '';
    pendingOlder.current = undefined;
    const node = viewport.current;
    if (node) {
      node.scrollTop = following.current ? node.scrollHeight : 0;
      if (restoreHistoryAnchor(node, initialAnchor)) restoring.current = false;
      lastScroll.current = node.scrollTop;
      if (!restoring.current) anchor.current = captureAnchor(node);
    }
  }, [positionKey, startAtLatest, initialAnchor]);
  const sync = () => {
    const node = viewport.current;
    if (!node) return;
    if (following.current) node.scrollTop = node.scrollHeight;
    else if (restoreHistoryAnchor(node, anchor.current)) restoring.current = false;
    else if (!restoring.current) {
      const pending = pendingOlder.current;
      if (pending && pending.cursor !== olderCursor)
        node.scrollTop = pending.top + node.scrollHeight - pending.height;
    }
    if (pendingOlder.current && !olderLoading) pendingOlder.current = undefined;
    lastScroll.current = node.scrollTop;
    if (!restoring.current) anchor.current = captureAnchor(node);
    setAway(node.scrollHeight - node.clientHeight - node.scrollTop > 96);
    if (!restoring.current && historyViewportVisible(node))
      onCheckpoint?.({ anchor: anchor.current, following: following.current });
  };
  const syncRef = useRef(sync);
  syncRef.current = sync;
  useLayoutEffect(sync, [children, olderCursor, olderLoading]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => syncRef.current());
    observer.observe(viewport.current!);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);
  const requestOlder = () => {
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
          anchor.current = captureAnchor(node);
          setAway(!following.current);
          if (historyViewportVisible(node))
            onCheckpoint?.({ anchor: anchor.current, following: following.current });
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
