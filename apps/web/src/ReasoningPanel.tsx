import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import './reasoning.css';

export type ReasoningPanelProps = {
  /** Stable identity of this public reasoning record, including its run. */
  identity: string;
  /** Undefined means the historical content has not been read yet. */
  text?: string;
  kind: 'reasoning_content' | 'summary';
  status: 'streaming' | 'complete' | 'interrupted' | 'failed';
  loading?: boolean;
  error?: string;
  hasMore?: boolean;
  truncated?: boolean;
  onLoad?: () => void;
  onRetry?: () => void;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Restored once, when this record first has visible text. */
  initialScrollTop?: number;
  onScrollTopChange?: (top: number) => void;
};

/** Only renders public text supplied by the caller; never reads provider-native payloads. */
export function ReasoningPanel(props: ReasoningPanelProps) {
  return <ReasoningRecord key={props.identity} {...props} />;
}

function ReasoningRecord({
  identity,
  text,
  kind,
  status,
  loading = false,
  error,
  hasMore = false,
  truncated = false,
  onLoad,
  onRetry,
  expanded,
  onExpandedChange,
  initialScrollTop = 0,
  onScrollTopChange,
}: ReasoningPanelProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const open = expanded ?? localExpanded;
  const contentId = useId(),
    toggleId = useId();
  const content = useRef<HTMLPreElement>(null),
    viewport = useRef<HTMLDivElement>(null);
  const requested = useRef(false),
    alive = useRef(true),
    copying = useRef(false);
  const readingPosition = useRef({
    top: Number.isFinite(initialScrollTop) ? Math.max(0, initialScrollTop) : 0,
    left: 0,
  });
  const wasReadable = useRef(false);
  const [copy, setCopy] = useState<{ state: 'idle' | 'pending' | 'copied' | 'failed'; text?: string }>({
    state: 'idle',
  });
  const label = kind === 'summary' ? '思考摘要' : '思考记录';
  const stateLabel = { streaming: '正在思考', complete: '已结束', interrupted: '已中断', failed: '生成失败' }[
    status
  ];
  const preview = (text || '')
    .slice(0, 180)
    .replace(/[\uD800-\uDBFF]$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const retry = onRetry || onLoad;
  const partial = hasMore || truncated;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open || text !== undefined || loading || error || !onLoad || requested.current) return;
    requested.current = true;
    onLoad();
  }, [open, text, loading, error, onLoad]);

  useLayoutEffect(() => {
    const element = content.current,
      scroller = viewport.current;
    if (!element || !scroller) return;
    const value = text || '';
    let node = element.firstChild;
    if (!node) {
      node = document.createTextNode('');
      element.appendChild(node);
    }
    const leaf = node as Text;
    const position =
      open && wasReadable.current
        ? { top: scroller.scrollTop, left: scroller.scrollLeft }
        : readingPosition.current;
    if (leaf.data === value) {
      // Keep the same node when only the disclosure state changes.
    } else if (value.startsWith(leaf.data)) {
      // Appending to the same Text node preserves an existing browser selection.
      leaf.appendData(value.slice(leaf.length));
    } else {
      const selection = window.getSelection();
      const selected =
        selection && (selection.anchorNode === leaf || selection.focusNode === leaf)
          ? {
              anchor: selection.anchorNode,
              anchorOffset: selection.anchorOffset,
              focus: selection.focusNode,
              focusOffset: selection.focusOffset,
            }
          : null;
      leaf.data = value;
      if (selection && selected?.anchor?.isConnected && selected.focus?.isConnected) {
        selection.setBaseAndExtent(
          selected.anchor,
          selected.anchor === leaf ? Math.min(selected.anchorOffset, value.length) : selected.anchorOffset,
          selected.focus,
          selected.focus === leaf ? Math.min(selected.focusOffset, value.length) : selected.focusOffset,
        );
      }
    }
    // A hidden scroller reports zero: retain its last readable position until reopened.
    wasReadable.current = open && !!text;
    if (wasReadable.current) {
      scroller.scrollTop = position.top;
      scroller.scrollLeft = position.left;
      readingPosition.current = { top: scroller.scrollTop, left: scroller.scrollLeft };
    }
  }, [text, open]);

  return (
    <section
      className="reasoning-panel"
      data-testid="reasoning-panel"
      data-reasoning-identity={identity}
      data-reasoning-state={status}
    >
      <button
        type="button"
        id={toggleId}
        className="reasoning-toggle"
        data-testid="reasoning-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => {
          const next = !open;
          if (expanded === undefined) setLocalExpanded(next);
          onExpandedChange?.(next);
        }}
      >
        <span className="reasoning-mark" aria-hidden="true">
          <Icon name="history" size={15} />
        </span>
        <span className="reasoning-title">{label}</span>
        <span
          className="reasoning-state"
          data-testid="reasoning-status"
          aria-live="polite"
          aria-atomic="true"
        >
          {stateLabel}
        </span>
        <span className="reasoning-chevron" aria-hidden="true">
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {!open && status === 'streaming' && (
        <p className="reasoning-preview" aria-hidden="true">
          {error
            ? '思考记录暂时无法读取，展开后重试。'
            : preview || (hasMore ? '思考内容已保存，展开后读取。' : '等待可展示的思考文本…')}
        </p>
      )}
      <div
        id={contentId}
        className="reasoning-content"
        data-testid="reasoning-content"
        role="region"
        aria-labelledby={toggleId}
        aria-busy={loading}
        hidden={!open}
      >
        {text && (
          <div className="reasoning-tools">
            <button
              type="button"
              data-testid="reasoning-copy"
              className="reasoning-copy"
              disabled={copy.state === 'pending'}
              aria-label={partial ? '复制已显示内容' : `复制${label}`}
              onClick={async () => {
                if (copying.current) return;
                const value = text;
                copying.current = true;
                setCopy({ state: 'pending' });
                try {
                  await navigator.clipboard.writeText(value);
                  if (alive.current) setCopy({ state: 'copied', text: value });
                } catch {
                  if (alive.current) setCopy({ state: 'failed' });
                } finally {
                  copying.current = false;
                }
              }}
            >
              <Icon name="copy" size={13} />
              {copy.state === 'pending' ? '正在复制…' : partial ? '复制已显示内容' : '复制'}
            </button>
          </div>
        )}
        <div
          ref={viewport}
          className="reasoning-viewport"
          tabIndex={text ? 0 : undefined}
          aria-label={`${label}正文`}
          data-testid="reasoning-viewport"
          hidden={!text}
          onScroll={(event) => {
            if (!open || !text) return;
            const scroller = event.currentTarget;
            readingPosition.current = { top: scroller.scrollTop, left: scroller.scrollLeft };
            onScrollTopChange?.(scroller.scrollTop);
          }}
        >
          <pre ref={content} />
        </div>
        {copy.state === 'copied' && (
          <p className="reasoning-notice" role="status">
            {copy.text === text ? '已复制显示的内容。' : '已复制点击时显示的内容；新内容尚未复制。'}
          </p>
        )}
        {copy.state === 'failed' && (
          <p className="reasoning-error" role="alert">
            复制失败，请重试或选中文字手动复制。
          </p>
        )}
        {loading && (
          <p className="reasoning-notice" role="status">
            {text === undefined ? '正在读取思考内容…' : '正在读取更多内容…'}
          </p>
        )}
        {error && (
          <div className="reasoning-read-error" role="alert">
            <p>{error}</p>
            {retry && (
              <button type="button" data-testid="reasoning-retry" disabled={loading} onClick={retry}>
                重试读取
              </button>
            )}
          </div>
        )}
        {!loading && !error && text === undefined && (
          <p className="reasoning-notice">
            尚未读取思考内容。
            {onLoad && (
              <button type="button" onClick={onLoad}>
                读取内容
              </button>
            )}
          </p>
        )}
        {!loading && !error && text === '' && (
          <p className="reasoning-notice">
            {status === 'streaming' ? '等待可展示的思考文本…' : '未返回可展示的思考文本。'}
          </p>
        )}
        {truncated && <p className="reasoning-notice">内容超过展示上限，仅显示可读取部分。</p>}
        {hasMore && onLoad && (
          <button
            type="button"
            className="reasoning-more"
            data-testid="reasoning-load-more"
            disabled={loading}
            onClick={onLoad}
          >
            读取更多
          </button>
        )}
      </div>
    </section>
  );
}
