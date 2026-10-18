import type { Message, RequestRecord } from '../../../packages/contracts/src/index';
import {
  REASONING_DISPLAY_MAX_CHARS,
  type ReasoningDelta,
  type ReasoningDisplay,
} from '../../../packages/contracts/src/reasoning';

type TextStream = { text: string; chunks: { offset: number; text: string }[] };
type PartialResponse = TextStream & {
  requestId?: string;
  reasoning?: TextStream;
  display?: ReasoningDisplay;
  reasoningActive?: boolean;
};
export type LiveReasoning = ReasoningDisplay & { requestId: string; text: string; missing: boolean };
export class RunStream {
  private partials: Record<string, PartialResponse> = {};
  private completed = new Set<string>();

  clear() {
    this.partials = {};
    this.completed.clear();
  }
  delta(value: { taskId: string; text: string; requestId?: string; offset?: number }) {
    if (!value.taskId || typeof value.text !== 'string') return true;
    if (value.requestId && this.completed.has(value.requestId)) return true;
    const old = this.partials[value.taskId];
    const requestId = value.requestId ?? old?.requestId;
    if (old?.requestId && old.requestId !== requestId) this.completed.add(old.requestId);
    const partial = old && old.requestId === requestId ? old : { requestId, text: '', chunks: [] };
    if (value.text) partial.reasoningActive = false;
    if (typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0) {
      partial.chunks.push({ offset: value.offset, text: value.text });
      this.merge(partial);
    } else partial.text += value.text;
    this.partials[value.taskId] = partial;
    return partial.chunks.length === 0;
  }
  private merge(partial: TextStream) {
    const missing: TextStream['chunks'] = [];
    for (const chunk of partial.chunks.sort((a, b) => a.offset - b.offset)) {
      if (chunk.offset > partial.text.length) missing.push(chunk);
      else if (chunk.offset + chunk.text.length > partial.text.length)
        partial.text += chunk.text.slice(partial.text.length - chunk.offset);
    }
    partial.chunks = missing;
  }
  reasoningDelta(value: ReasoningDelta, live = true) {
    if (
      !value.taskId ||
      !value.requestId ||
      this.completed.has(value.requestId) ||
      typeof value.text !== 'string' ||
      !['reasoning_content', 'summary'].includes(value.kind)
    )
      return true;
    if (!Number.isSafeInteger(value.offset) || value.offset < 0) return false;
    if (value.offset >= REASONING_DISPLAY_MAX_CHARS) return true;
    const old = this.partials[value.taskId];
    if (old?.requestId && old.requestId !== value.requestId) this.completed.add(old.requestId);
    const partial: PartialResponse =
      old?.requestId === value.requestId ? old : { requestId: value.requestId, text: '', chunks: [] };
    const reasoning = (partial.reasoning ??= { text: '', chunks: [] });
    if (live) partial.reasoningActive = true;
    const text = value.text.slice(0, REASONING_DISPLAY_MAX_CHARS - value.offset);
    const overlap = Math.min(text.length, Math.max(0, reasoning.text.length - value.offset));
    if (overlap && reasoning.text.slice(value.offset, value.offset + overlap) !== text.slice(0, overlap))
      return false;
    const prior = reasoning.chunks.find((chunk) => chunk.offset === value.offset);
    if (!prior) reasoning.chunks.push({ offset: value.offset, text });
    else if (text.startsWith(prior.text)) prior.text = text;
    else if (!prior.text.startsWith(text)) return false;
    this.merge(reasoning);
    // A missing prefix is recovered from the persisted display, without an unbounded delta queue.
    const missing = reasoning.chunks.length > 0;
    if (
      reasoning.chunks.length > 128 ||
      reasoning.chunks.reduce((total, chunk) => total + chunk.text.length, 0) > REASONING_DISPLAY_MAX_CHARS
    )
      reasoning.chunks = [];
    partial.display = {
      kind: value.kind,
      status: 'streaming',
      characters: Math.max(partial.display?.characters ?? 0, value.offset + text.length),
      truncated: partial.display?.truncated === true || text.length !== value.text.length,
    };
    this.partials[value.taskId] = partial;
    return !missing;
  }
  seedReasoning(taskId: string, requestId: string, text: string, offset: number) {
    const partial = this.partials[taskId];
    if (this.completed.has(requestId) || partial?.requestId !== requestId || !partial.display) return;
    this.reasoningDelta({ runId: '', taskId, requestId, kind: partial.display.kind, text, offset }, false);
  }
  complete(taskId: string, message: Message) {
    if (message.role !== 'assistant') return;
    if (message.requestId) this.completed.add(message.requestId);
    if (this.partials[taskId]?.requestId === message.requestId) delete this.partials[taskId];
  }
  sync(requests: RequestRecord[]) {
    const active = new Map<string, RequestRecord>();
    for (const request of requests) {
      if (request.status !== 'RESERVED' || this.completed.has(request.id)) continue;
      const prior = active.get(request.taskId);
      if (!prior || prior.startedAt <= request.startedAt) active.set(request.taskId, request);
    }
    for (const [taskId, partial] of Object.entries(this.partials)) {
      const record = requests.find((r) => r.id === partial.requestId);
      if (record && record.status !== 'RESERVED') {
        this.completed.add(record.id);
        delete this.partials[taskId];
      }
    }
    for (const [taskId, request] of active) {
      const partial = this.partials[taskId];
      if (
        partial?.requestId &&
        partial.requestId !== request.id &&
        !requests.some((r) => r.id === partial.requestId)
      )
        continue;
      if (partial?.requestId && partial.requestId !== request.id) this.completed.add(partial.requestId);
      const text = request.manifest.partialText;
      if (typeof text !== 'string' && !request.reasoning?.characters && !request.reasoning?.readUnavailable)
        continue;
      const priorDisplay = partial?.requestId === request.id ? partial.display : undefined;
      const display = request.reasoning
        ? {
            ...request.reasoning,
            characters: Math.max(request.reasoning.characters, priorDisplay?.characters ?? 0),
            truncated: request.reasoning.truncated || priorDisplay?.truncated === true,
          }
        : priorDisplay;
      if (partial?.requestId === request.id) partial.display = display;
      if (
        partial?.requestId === request.id &&
        partial.text.length > (typeof text === 'string' ? text.length : 0)
      )
        continue;
      const next: PartialResponse = {
        requestId: request.id,
        text: typeof text === 'string' ? text : '',
        chunks: partial?.requestId === request.id ? partial.chunks : [],
        ...(partial?.requestId === request.id ? { reasoning: partial.reasoning } : {}),
        reasoningActive: partial?.requestId === request.id ? partial.reasoningActive : !text,
        display,
      };
      this.merge(next);
      this.partials[taskId] = next;
    }
  }
  texts() {
    return Object.fromEntries(
      Object.entries(this.partials).map(([taskId, partial]) => [taskId, partial.text]),
    );
  }
  reasonings(): Record<string, LiveReasoning> {
    return Object.fromEntries(
      Object.entries(this.partials).flatMap(([taskId, partial]) =>
        partial.requestId && (partial.display?.characters || partial.display?.readUnavailable)
          ? [
              [
                taskId,
                {
                  ...partial.display,
                  status: partial.reasoningActive === false ? 'complete' : partial.display.status,
                  characters: Math.max(partial.display.characters, partial.reasoning?.text.length ?? 0),
                  requestId: partial.requestId,
                  text: partial.reasoning?.text ?? '',
                  missing: (partial.reasoning?.text.length ?? 0) < partial.display.characters,
                },
              ],
            ]
          : [],
      ),
    );
  }
}
