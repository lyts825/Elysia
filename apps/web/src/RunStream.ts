/* 按任务和请求合并增量响应，并跟踪实时推理显示。 */
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
/**
 * 维护运行界面的临时流状态。正文与推理按请求身份独立合并，服务端快照用来补缺口；
 * 此类只保存显示副本，不能替代请求账本或已完成消息的权威正文。
 */
export class RunStream {
  // 每个任务仅保留一个活动请求；completed 用于忽略迟到的流片段。
  private partials: Record<string, PartialResponse> = {};
  private completed = new Set<string>();

  /** 切换运行或完全重建详情时清除片段和已完成集合，防止不同运行的任务 ID 串入显示。 */
  clear() {
    this.partials = {};
    this.completed.clear();
  }
  /**
   * 合并正文增量，带偏移时支持重发和乱序；旧式无偏移事件按到达顺序追加。
   * 返回 false 表示仍有文本缺口，需要调用方安排持久快照补读，而非直接展示乱序片段。
   */
  delta(value: { taskId: string; text: string; requestId?: string; offset?: number }) {
    // 返回 false 表示存在尚未补齐的偏移缺口，调用方应读取可靠快照。
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
  /** 按偏移排序，只追加与已有前缀相接或重叠的未读后缀，缺口后的片段继续保留。 */
  private merge(partial: TextStream) {
    const missing: TextStream['chunks'] = [];
    // 片段可能乱序或重发：保留缺口后的片段，只追加尚未收到的后缀。
    for (const chunk of partial.chunks.sort((a, b) => a.offset - b.offset)) {
      if (chunk.offset > partial.text.length) missing.push(chunk);
      else if (chunk.offset + chunk.text.length > partial.text.length)
        partial.text += chunk.text.slice(partial.text.length - chunk.offset);
    }
    partial.chunks = missing;
  }
  /**
   * 合并公开推理片段，并验证重叠内容一致。超出显示上限的尾部忽略，乱序队列另设数量/长度上限。
   * live=false 用于持久化补读，不把已经结束的推理显示重新激活为实时状态。
   * false 表示偏移或内容冲突，需要重新补读；不能靠拼接冲突内容猜测原文。
   */
  reasoningDelta(value: ReasoningDelta, live = true) {
    // 推理正文与普通回复分别合并，显示长度受上限约束。
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
    // 重叠数据必须一致，否则调用方需要重新读取可靠的持久化内容。
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
  /** 只向仍匹配的活动请求注入补读推理，保持原显示类别与活动状态。 */
  seedReasoning(taskId: string, requestId: string, text: string, offset: number) {
    // 仅给仍匹配的请求补读持久化内容，避免恢复数据污染新请求。
    const partial = this.partials[taskId];
    if (this.completed.has(requestId) || partial?.requestId !== requestId || !partial.display) return;
    this.reasoningDelta({ runId: '', taskId, requestId, kind: partial.display.kind, text, offset }, false);
  }
  /** 已记录的 assistant 消息完成对应请求；标记完成后迟到事件不能重新建立局部流。 */
  complete(taskId: string, message: Message) {
    if (message.role !== 'assistant') return;
    if (message.requestId) this.completed.add(message.requestId);
    if (this.partials[taskId]?.requestId === message.requestId) delete this.partials[taskId];
  }
  /**
   * 将请求快照与本地增量协调：结束已结算请求、每任务选最新 RESERVED 请求，再补齐正文。
   * 仅包含部分历史的快照不能证明旧局部请求已结束；落后的短快照也不能覆盖更长的实时正文。
   */
  sync(requests: RequestRecord[]) {
    // 每个任务选择最新的在途请求；服务端快照也负责结束已结算的本地流。
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
        // 不让落后的服务端快照覆盖已经收到的实时内容。
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
  /** 返回按任务索引的连续正文前缀；缺口后的缓存片段不提前显示。 */
  texts() {
    return Object.fromEntries(
      Object.entries(this.partials).map(([taskId, partial]) => [taskId, partial.text]),
    );
  }
  /** 导出推理展示状态，missing 指出尚未补齐的内容；普通正文已开始时将推理显示视作完成。 */
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
