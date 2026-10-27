/* 提供对话内容搜索界面。 */
import { useEffect, useId, useRef, useState } from 'react';
import type { MessageSearchPage } from '../../../packages/contracts/src/task-center';
import { Icon } from './Icon';
import { useSurfaceClient } from './SurfaceClientContext';
import './conversation-search.css';

const roleLabels: Record<string, string> = {
  user: '你',
  assistant: '助手',
  tool: '工具',
  system: '系统',
};

/**
 * 在单个运行内按需搜索完整公开消息。输入防抖、分页请求和消息定位分别维护状态；
 * 查询或运行改变会取消旧请求并递增序号，结果最多保留 60 条。
 * 选择结果等待外层定位成功，失败保留该消息 ID 供重试；关闭时恢复原触发焦点。
 */
export function ConversationSearch({
  runId,
  onSelect,
  disabled = false,
  activeMessageId,
  embedded = false,
  onClose,
}: {
  runId: string;
  onSelect: (messageId: string) => void | Promise<boolean | void>;
  disabled?: boolean;
  activeMessageId?: string;
  embedded?: boolean;
  onClose?: () => void;
}) {
  const { api } = useSurfaceClient();
  const [open, setOpen] = useState(embedded);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<MessageSearchPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selecting, setSelecting] = useState('');
  const [failedSelection, setFailedSelection] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ target: 'error' | 'results' }>();
  const request = useRef<AbortController | undefined>(undefined);
  const sequence = useRef(0);
  const activeQuery = useRef('');
  const loadedQuery = useRef('');
  const lastRead = useRef<{ before?: string | null; append: boolean }>({ append: false });
  const binding = useRef({ runId, embedded });
  const context = useRef({ runId, query: query.trim(), open });
  context.current = { runId, query: query.trim(), open };
  const panelId = useId();
  /** 查询身份固定为开始读取时的运行和关键字；append 只用于同一查询的后续页。 */
  const read = async (before?: string | null, append = false, focusFeedback = false) => {
    // 每次查询取消上一请求并递增序号，防止较慢的旧结果覆盖新查询。
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const ticket = ++sequence.current;
    const target = { runId, query: query.trim() };
    if (!target.query || disabled || !open) return;
    lastRead.current = { before, append };
    setLoading(true);
    setError('');
    setFailedSelection('');
    try {
      const page = await api<MessageSearchPage>(
        `/runs/${encodeURIComponent(target.runId)}/messages/search?query=${encodeURIComponent(target.query)}&limit=20` +
          (before ? '&before=' + encodeURIComponent(before) : ''),
        undefined,
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted || ticket !== sequence.current) return;
      loadedQuery.current = JSON.stringify([target.runId, target.query]);
      setResult((current) => {
        if (!append || !current) return page;
        // 增量页按消息 ID 去重，显示窗口最多保留 60 条。
        const items = new Map(current.items.map((item) => [item.messageId, item]));
        for (const item of page.items) items.set(item.messageId, item);
        return { ...page, items: [...items.values()].slice(0, 60) };
      });
      if (focusFeedback) setFocusRequest({ target: 'results' });
    } catch (issue) {
      if (!controller.signal.aborted && ticket === sequence.current) {
        setError(issue instanceof Error ? issue.message : '搜索未完成，请重试。');
        if (focusFeedback) setFocusRequest({ target: 'error' });
      }
    } finally {
      if (!controller.signal.aborted && ticket === sequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (binding.current.runId === runId && binding.current.embedded === embedded) return;
    binding.current = { runId, embedded };
    request.current?.abort();
    sequence.current++;
    setOpen(embedded);
    setQuery('');
    setResult(null);
    setError('');
    setLoading(false);
    setSelecting('');
    setFailedSelection('');
    loadedQuery.current = '';
  }, [runId, embedded]);
  useEffect(() => {
    request.current?.abort();
    sequence.current++;
    const key = JSON.stringify([runId, query.trim()]);
    if (activeQuery.current !== key || !open) {
      activeQuery.current = key;
      loadedQuery.current = '';
      setResult(null);
      setError('');
      setFailedSelection('');
    }
    setLoading(false);
    if (!open || disabled || !query.trim()) return;
    if (loadedQuery.current === key) return;
    // 输入稳定 300 毫秒后再检索，关闭或切换查询时取消计时和请求。
    const timer = setTimeout(() => void read(), 300);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
      sequence.current++;
    };
  }, [runId, query, open, disabled, api]);
  useEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      input.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (!focusRequest) return;
    const target = focusRequest.target === 'error' ? errorRef.current : resultsRef.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }, [focusRequest]);
  const close = () => {
    request.current?.abort();
    setOpen(false);
    const target = trigger.current ?? returnFocus.current;
    if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
    onClose?.();
  };
  /** 外层可能需要异步切换历史窗口；结果只回写仍属于原运行与查询的搜索面板。 */
  const select = async (messageId: string) => {
    const target = { ...context.current };
    setSelecting(messageId);
    setError('');
    setFailedSelection('');
    try {
      const accepted = await onSelect(messageId);
      if (accepted === false) throw Error('消息定位未完成，请重试。');
    } catch (issue) {
      if (context.current.runId === target.runId && context.current.query === target.query) {
        setError(issue instanceof Error ? issue.message : '消息定位未完成，请重试。');
        setFailedSelection(messageId);
        setFocusRequest({ target: 'error' });
      }
    } finally {
      if (context.current.runId === target.runId && context.current.query === target.query) setSelecting('');
    }
  };
  return (
    <div
      className={'conversation-search' + (embedded ? ' embedded' : '')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      {!embedded && (
        <button
          ref={trigger}
          type="button"
          className="secondary"
          aria-label="搜索对话正文"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          disabled={disabled}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <Icon name="search" size={16} />
        </button>
      )}
      {open && (
        <div className="conversation-search-panel" id={panelId} aria-label="对话正文搜索">
          <div className="conversation-search-input">
            <Icon name="search" size={16} />
            <input
              ref={input}
              value={query}
              aria-label="搜索当前对话正文"
              placeholder="搜索当前对话正文"
              maxLength={200}
              disabled={disabled}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="button" className="icon-button" aria-label="关闭正文搜索" onClick={close}>
              <Icon name="close" size={15} />
            </button>
          </div>
          <p className="conversation-search-status" role="status">
            {loading
              ? '正在搜索…'
              : error
                ? failedSelection
                  ? '消息定位未完成'
                  : '搜索未完成'
                : result
                  ? `找到 ${result.page.total} 条匹配`
                  : query.trim()
                    ? '正在准备搜索…'
                    : '输入关键词，按需读取消息。'}
          </p>
          {error && (
            <div className="conversation-search-error" role="alert" ref={errorRef} tabIndex={0}>
              <span>{error}</span>
              <button
                type="button"
                className="secondary"
                disabled={loading || !!selecting}
                onClick={() =>
                  failedSelection
                    ? void select(failedSelection)
                    : void read(lastRead.current.before, lastRead.current.append, true)
                }
              >
                {failedSelection ? '重试定位' : '重试搜索'}
              </button>
            </div>
          )}
          {result && (
            <>
              <div
                className="conversation-search-results"
                role="region"
                aria-label="正文匹配结果"
                ref={resultsRef}
                tabIndex={0}
              >
                {result.items.map((item) => (
                  <button
                    type="button"
                    key={item.messageId}
                    disabled={disabled || !!selecting}
                    aria-current={activeMessageId === item.messageId ? 'true' : undefined}
                    onClick={() => void select(item.messageId)}
                  >
                    <small>{roleLabels[item.role] || item.role}</small>
                    <span>{item.snippet}</span>
                    {selecting === item.messageId && <small>正在定位…</small>}
                  </button>
                ))}
                {!loading && !result.items.length && <p>没有找到匹配的消息。</p>}
              </div>
              {(result.page.hasMore || result.page.before) && (
                <div className="conversation-search-pages">
                  {result.page.hasMore && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={loading || !result.page.nextBefore}
                      onClick={() => void read(result.page.nextBefore, result.items.length < 60, true)}
                    >
                      {result.items.length < 60 ? '更早匹配' : '继续更早匹配'}
                    </button>
                  )}
                  {result.page.before && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={loading}
                      onClick={() => void read(undefined, false, true)}
                    >
                      返回最新匹配
                    </button>
                  )}
                  {result.items.length >= 60 && result.page.hasMore && (
                    <small>继续查看将切换结果区段。</small>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
