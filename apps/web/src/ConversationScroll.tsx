import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { captureHistoryAnchor, historyViewportVisible, restoreHistoryAnchor } from './HistoryScroll';

export function ConversationScroll({
  children,
  positionKey,
  startAtLatest = true,
  onLoadOlder,
  olderCursor,
  olderLoading = false,
  olderError,
}: {
  children: ReactNode;
  positionKey?: string;
  startAtLatest?: boolean;
  onLoadOlder?: () => void;
  olderCursor?: string | null;
  olderLoading?: boolean;
  olderError?: string;
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
  useLayoutEffect(() => {
    const key = JSON.stringify([positionKey]);
    if (positioned.current === key) return;
    positioned.current = key;
    following.current = startAtLatest;
    anchor.current = undefined;
    requestedOlder.current = '';
    pendingOlder.current = undefined;
    const node = viewport.current;
    if (node) {
      node.scrollTop = startAtLatest ? node.scrollHeight : 0;
      lastScroll.current = node.scrollTop;
      anchor.current = captureHistoryAnchor(node);
    }
  }, [positionKey, startAtLatest]);
  const sync = () => {
    const node = viewport.current;
    if (!node) return;
    if (following.current) node.scrollTop = node.scrollHeight;
    else if (!restoreHistoryAnchor(node, anchor.current)) {
      const pending = pendingOlder.current;
      if (pending && pending.cursor !== olderCursor)
        node.scrollTop = pending.top + node.scrollHeight - pending.height;
    }
    if (pendingOlder.current && !olderLoading) pendingOlder.current = undefined;
    lastScroll.current = node.scrollTop;
    anchor.current = captureHistoryAnchor(node);
    setAway(node.scrollHeight - node.clientHeight - node.scrollTop > 96);
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
    anchor.current = captureHistoryAnchor(node);
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
          following.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 96;
          anchor.current = captureHistoryAnchor(node);
          setAway(!following.current);
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
