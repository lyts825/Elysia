/* 读取并展示任务推理内容。 */
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
export const reasoningIdentity = (runId: string, requestId?: string, messageId?: string) =>
  JSON.stringify([runId, requestId ? 'request' : 'message', requestId || messageId]);

function longerText(saved?: string, live?: string) {
  if (live === undefined || !live.length) return saved;
  if (saved === undefined || live.startsWith(saved)) return live;
  return saved;
}

/** Request-scoped reading state survives the stream becoming a historical message. */
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
