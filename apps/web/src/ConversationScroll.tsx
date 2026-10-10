import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export function ConversationScroll({
  children,
  positionKey,
  startAtLatest = true,
}: {
  children: ReactNode;
  positionKey?: string;
  startAtLatest?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const positioned = useRef('');
  useLayoutEffect(() => {
    const key = JSON.stringify([positionKey, startAtLatest]);
    if (positioned.current === key) return;
    positioned.current = key;
    following.current = startAtLatest;
    const node = viewport.current;
    if (node) node.scrollTop = startAtLatest ? node.scrollHeight : 0;
  }, [positionKey, startAtLatest]);
  const sync = () => {
    const node = viewport.current;
    if (!node) return;
    if (following.current) node.scrollTop = node.scrollHeight;
    setAway(node.scrollHeight - node.clientHeight - node.scrollTop > 96);
  };
  useLayoutEffect(sync, [children]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(sync);
    observer.observe(viewport.current!);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="conversation-history">
      <div
        ref={viewport}
        className="conversation-scroll"
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 96;
          setAway(!following.current);
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
