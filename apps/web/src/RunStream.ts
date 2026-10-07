import type { Message, RequestRecord } from '../../../packages/contracts/src/index';

type PartialResponse = { requestId?: string; text: string; chunks: { offset: number; text: string }[] };
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
    const partial = old && old.requestId === requestId ? old : { requestId, text: '', chunks: [] };
    if (typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0) {
      partial.chunks.push({ offset: value.offset, text: value.text });
      this.merge(partial);
    } else partial.text += value.text;
    this.partials[value.taskId] = partial;
    return partial.chunks.length === 0;
  }
  private merge(partial: PartialResponse) {
    const missing: PartialResponse['chunks'] = [];
    for (const chunk of partial.chunks.sort((a, b) => a.offset - b.offset)) {
      if (chunk.offset > partial.text.length) missing.push(chunk);
      else if (chunk.offset + chunk.text.length > partial.text.length)
        partial.text += chunk.text.slice(partial.text.length - chunk.offset);
    }
    partial.chunks = missing;
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
      const text = request.manifest.partialText;
      if (typeof text !== 'string') continue;
      if (partial?.requestId === request.id && partial.text.length > text.length) continue;
      const next = {
        requestId: request.id,
        text,
        chunks: partial?.requestId === request.id ? partial.chunks : [],
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
}
