/**
 * 为对话消息和工具调用构建索引及查找键。
 * 对当前可见详情建立实体与工具调用索引，使用回复消息身份配对回执；不补造缺失或无法配对的记录。
 * EN: Builds lookup indexes for conversation messages and tool calls. Indexes entities and tool calls in visible detail, pairing receipts by assistant-message identity without inventing missing or unpaired records.
 */
import type { Agent, Message, Operation, RequestRecord, Task } from '../../../packages/contracts/src/index';

/**
 * 按调用方提供的键建立首条记录索引；忽略空键和重复键，保留原列表中的首次出现。
 * EN: Indexes the first record for each supplied key, ignoring empty and repeated keys while preserving the first occurrence in source order.
 */
function firstBy<T>(values: readonly T[] | undefined, key: (value: T) => string | undefined) {
  const result = new Map<string, T>();
  for (const value of values || []) {
    const id = key(value);
    if (id && !result.has(id)) result.set(id, value);
  }
  return result;
}

/**
 * 把消息ID与调用ID编码为无分隔符歧义的复合键；防止不同回复重用调用ID时错误配对。
 * EN: Encodes message and call IDs as an unambiguous composite key, preventing incorrect pairing when later replies reuse a call ID.
 */
export const conversationCallKey = (messageId: string, callId: string) => JSON.stringify([messageId, callId]);

/**
 * 为当前可见详情建立实体与工具配对索引。会话可交错、调用 ID 可跨回复复用，因此
 * 工具结果必须配到所属 assistant 消息；无法配对的原始回执保持独立显示。
 * 返回 boundResponses 供时间线隐藏已经嵌入调用组的回执，避免重复展示。
 * EN: Index visible entities and tool-response pairing. Sessions may interleave and call IDs may be reused in later replies, so a result must belong to its assistant occurrence. Keep unpaired receipts visible as raw text. Return boundResponses so the timeline can hide receipts already embedded in a call group and avoid duplicate display.
 */
export function conversationIndex(
  detail: {
    requests: RequestRecord[];
    agents: Agent[];
    tasks: Task[];
    operations: Operation[];
    messages: Message[];
  } | null,
) {
  /**
   * 操作按消息 ID 与调用 ID 组合索引，避免跨消息复用相同调用 ID 时串联。
   * EN: Index operations by the combination of message ID and call ID, preventing reused call IDs from linking different messages.
   */
  const operations = new Map<string, Operation>();
  const responses = new Map<string, Message>();
  const boundResponses = new Set<string>();
  const operationsById = firstBy(detail?.operations, (value) => value.id);
  for (const operation of detail?.operations ?? [])
    if (operation.assistantMessageId)
      operations.set(conversationCallKey(operation.assistantMessageId, operation.toolCallId), operation);

  /**
   * 代理会话可交错，供应商也可能在后续回复中复用调用 ID。
   * EN: Agent sessions can interleave and providers may reuse call IDs in later responses.
   */
  /**
   * 只在可见的 assistant 调用实例内配对，孤立回执保留为原文。
   * EN: Pair only within the visible assistant occurrence; an orphan stays visible as raw text.
   */
  const pending = new Map<string, Map<string, { owner: Message; name: string }>>();
  for (const message of detail?.messages ?? []) {
    const session = JSON.stringify([message.runId, message.sessionId]);
    if (message.role !== 'tool') {
      const calls = new Map<string, { owner: Message; name: string }>();
      const duplicate = new Set<string>();
      for (const call of message.calls ?? []) {
        if (calls.has(call.id)) duplicate.add(call.id);
        calls.set(call.id, { owner: message, name: call.name });
      }
      for (const id of duplicate) calls.delete(id);
      /**
       * 同一消息中重复的调用 ID 无法可靠配对，保留原始消息而不推断归属。
       * EN: Duplicate call IDs within one message cannot be paired reliably; retain the raw message instead of guessing ownership.
       */
      pending.set(session, calls);
      continue;
    }
    const group = pending.get(session);
    const matched = message.callId ? group?.get(message.callId) : undefined;
    if (!matched || !message.callId) continue;
    group!.delete(message.callId);
    const key = conversationCallKey(matched.owner.id, message.callId);
    responses.set(key, message);
    boundResponses.add(message.id);
    /**
     * 旧操作缺少所属消息字段；需要在回执中记录的 operationId，
     * EN: Legacy operations have no owner field. A recorded operationId in this
     */
    /**
     * 并且回执必须与当前调用准确配对；仅原始调用 ID 碰巧相同不足以证明归属。
     * EN: exact paired response is evidence; a coincident raw call ID alone is not.
     */
    if (!operations.has(key)) {
      try {
        const result = JSON.parse(message.text);
        const operation = operationsById.get(result?.operationId);
        if (
          operation &&
          !operation.assistantMessageId &&
          operation.runId === message.runId &&
          operation.toolCallId === message.callId &&
          operation.name === matched.name
        )
          operations.set(key, operation);
      } catch {
        /**
         * 工具结果可以是纯文本，不依据正文内容推断关联。
         * EN: Tool result bodies can be text; no association is inferred from text content.
         */
      }
    }
  }
  return {
    requests: firstBy(detail?.requests, (value) => value.id),
    sessions: firstBy(detail?.agents, (value) => value.sessionId),
    agents: firstBy(detail?.agents, (value) => value.taskId),
    tasks: firstBy(detail?.tasks, (value) => value.id),
    operations,
    responses,
    boundResponses,
  };
}
