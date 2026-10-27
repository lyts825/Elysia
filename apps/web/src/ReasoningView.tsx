/**
 * 读取并展示任务推理内容。
 * 按请求身份分页读取完整推理，保存阅读状态并与仅扩展前缀的实时文本合并；内容冲突保留已读版本，旧请求不能覆盖新选择。
 * EN: Reads and displays task reasoning. Reads full reasoning by request identity, retains reading state, and merges live text only when it extends the saved prefix; conflicts keep loaded text and obsolete requests cannot replace a new selection.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReasoningDisplay, ReasoningPage } from '../../../packages/contracts/src/reasoning';
import {
  REASONING_DISPLAY_MAX_CHARS,
  REASONING_PAGE_MAX_CHARS,
} from '../../../packages/contracts/src/reasoning';
import { useSurfaceClient } from './SurfaceClientContext';
import { ReasoningPanel } from './ReasoningPanel';

type Reading = { text?: string; expanded: boolean; scrollTop: number };
export type ReasoningReadings = Map<string, Reading>;
/**
 * 优先按 request ID 定位，使同一流转为历史消息后仍复用读取、展开和滚动状态。
 * EN: Prefer request ID so stream-to-history transition keeps the same reading/disclosure/scroll state.
 */
export const reasoningIdentity = (runId: string, requestId?: string, messageId?: string) =>
  JSON.stringify([runId, requestId ? 'request' : 'message', requestId || messageId]);

/**
 * 合并已保存与实时推理文本；仅当实时值非空且扩展已保存前缀时采用它，冲突时保留已读内容。
 * EN: Merges saved and live reasoning text, accepting a nonempty live value only when it extends the saved prefix and preserving loaded content on conflict.
 */
function longerText(saved?: string, live?: string) {
  /**
   * 只在实时文本扩展已保存前缀时替换，内容冲突时保留已读内容。
   * EN: Replace only when live text extends saved prefix; conflicts preserve loaded content.
   */
  if (live === undefined || !live.length) return saved;
  if (saved === undefined || live.startsWith(saved)) return live;
  return saved;
}

/**
 * 按请求保存的阅读状态跨流转历史消息保留。
 * EN: Request-scoped reading state survives the stream becoming a historical message.
 */
export function ReasoningView(props: {
  runId: string;
  messageId?: string;
  requestId?: string;
  reasoning: ReasoningDisplay;
  liveText?: string;
  readings: ReasoningReadings;
  onPage?: (text: string, offset: number) => void;
}) {
  const identity = reasoningIdentity(props.runId, props.requestId, props.messageId);
  return <ReasoningReader key={identity} {...props} identity={identity} />;
}

/**
 * 公开推理的分页读取器。已读正文与实时流只按一致前缀合并，状态缓存在上层有界 Map 中。
 * readUnavailable 的新一代标记会使此前的远端核验失效，必须再次读取才能解除不可读提示。
 * EN: Page public reasoning, merging live/loaded text only on matching prefixes and caching in a bounded parent Map. A new readUnavailable generation invalidates prior remote verification; reread before clearing the warning.
 */
function ReasoningReader({
  identity,
  runId,
  messageId,
  requestId,
  reasoning,
  liveText,
  readings,
  onPage,
}: Parameters<typeof ReasoningView>[0] & { identity: string }) {
  const { api } = useSurfaceClient();
  const [reading, setReading] = useState<Reading>(
    () => readings.get(identity) || { expanded: false, scrollTop: 0 },
  );
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [remote, setRemote] = useState<{ metadata: ReasoningDisplay; generation: number }>();
  const discovery = useRef({ unavailable: false, generation: 0 });
  if (discovery.current.unavailable !== Boolean(reasoning.readUnavailable)) {
    if (reasoning.readUnavailable) discovery.current.generation++;
    discovery.current.unavailable = Boolean(reasoning.readUnavailable);
  }
  const verified = remote?.generation === discovery.current.generation ? remote.metadata : undefined;
  const controller = useRef<AbortController | undefined>(undefined),
    alive = useRef(true),
    pending = useRef(false);
  const text = longerText(reading.text, liveText);
  const scrollPosition = useRef(reading.scrollTop);
  const current = useRef({ text, reading, onPage });
  current.current = { text, reading: { ...reading, scrollTop: scrollPosition.current }, onPage };
  /**
   * 删除再插入按最近使用排序，最多保留 64 条，避免长会话无限积累阅读正文。
   * EN: Reinsert by recency and cap at 64 entries so long conversations cannot retain unbounded text.
   */
  const remember = useCallback(
    (value: Reading) => {
      readings.delete(identity);
      readings.set(identity, value);
      if (readings.size > 64) readings.delete(readings.keys().next().value!);
    },
    [identity, readings],
  );
  useEffect(() => {
    if (text !== undefined) remember({ ...current.current.reading, text });
  }, [text, remember]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const path = messageId
    ? `/runs/${runId}/messages/${messageId}/reasoning`
    : `/runs/${runId}/requests/${requestId}/reasoning`;
  /**
   * pending 同步阻止重复点击，offset 取发起时的已读长度；响应后再与实时增长的前缀核对。
   * EN: pending synchronously blocks duplicate clicks. Capture read length as offset, then compare against the live-grown prefix after response.
   */
  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    const offset = current.current.text?.length ?? 0;
    const generation = discovery.current.generation;
    try {
      const page = await api<ReasoningPage>(
        `${path}?offset=${offset}&limit=${REASONING_PAGE_MAX_CHARS}`,
        undefined,
        undefined,
        abort.signal,
      );
      if (!alive.current || abort.signal.aborted) return;
      /**
       * 除 HTTP 成功外还验证身份、页大小、元数据和连续偏移，不能将异常页拼接进已读文本。
       * EN: Validate identity/page size/metadata/continuous offset beyond HTTP success before appending.
       */
      if (
        !page ||
        page.runId !== runId ||
        (messageId && page.messageId !== messageId) ||
        (requestId && page.requestId !== requestId) ||
        page.offset !== offset ||
        typeof page.text !== 'string' ||
        page.text.length > REASONING_PAGE_MAX_CHARS ||
        !page.reasoning ||
        page.reasoning.readUnavailable ||
        page.reasoning.kind !== reasoning.kind ||
        !['streaming', 'complete', 'interrupted'].includes(page.reasoning.status) ||
        !Number.isSafeInteger(page.reasoning.characters) ||
        page.reasoning.characters > REASONING_DISPLAY_MAX_CHARS ||
        page.reasoning.characters < offset + page.text.length ||
        (page.nextOffset === null && offset + page.text.length < page.reasoning.characters) ||
        (page.nextOffset !== null &&
          (page.nextOffset <= offset || page.nextOffset !== offset + page.text.length))
      )
        throw new Error('思考内容的读取位置无法核对，请重新读取。');
      const prior = current.current.text ?? '';
      /**
       * 请求期间实时流可能已覆盖本页前缀；核对重叠区后仅追加尚未显示的后缀。
       * EN: Live stream may already cover this page; validate overlap and append only the unseen suffix.
       */
      const overlap = Math.min(page.text.length, Math.max(0, prior.length - offset));
      if (offset > prior.length || prior.slice(offset, offset + overlap) !== page.text.slice(0, overlap))
        throw new Error('思考内容已更新，请重试读取。');
      const next = prior + page.text.slice(Math.max(0, prior.length - offset));
      const value = { ...current.current.reading, text: next };
      remember(value);
      setReading(value);
      setRemote({ metadata: page.reasoning, generation });
      if (generation === discovery.current.generation) current.current.onPage?.(page.text, page.offset);
    } catch (issue) {
      if (alive.current && !abort.signal.aborted)
        setError(issue instanceof Error ? issue.message : '无法读取思考内容，请重试。');
    } finally {
      if (controller.current === abort) {
        pending.current = false;
        if (alive.current) setLoading(false);
      }
    }
  }, [api, path, runId, messageId, requestId, reasoning.kind, remember]);
  return (
    <ReasoningPanel
      identity={identity}
      kind={reasoning.kind}
      status={reasoning.status}
      text={text}
      loading={loading}
      error={error || (reasoning.readUnavailable && !verified ? '思考记录暂时无法读取，请重试。' : '')}
      hasMore={
        (reasoning.readUnavailable && !verified) ||
        (text?.length ?? 0) < Math.max(reasoning.characters, verified?.characters ?? 0)
      }
      truncated={reasoning.truncated || verified?.truncated}
      expanded={reading.expanded}
      initialScrollTop={reading.scrollTop}
      onScrollTopChange={(scrollTop) => {
        scrollPosition.current = scrollTop;
        remember({ ...current.current.reading, text: current.current.text, scrollTop });
      }}
      onExpandedChange={(expanded) => {
        const value = { ...current.current.reading, text: current.current.text, expanded };
        remember(value);
        setReading(value);
      }}
      onLoad={() => void load()}
      onRetry={() => void load()}
    />
  );
}
