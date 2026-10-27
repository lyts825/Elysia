/* 为对话消息和工具调用构建索引及查找键。 */
import type { Agent, Message, Operation, RequestRecord, Task } from '../../../packages/contracts/src/index';

function firstBy<T>(values: readonly T[] | undefined, key: (value: T) => string | undefined) {
  const result = new Map<string, T>();
  for (const value of values || []) {
    const id = key(value);
    if (id && !result.has(id)) result.set(id, value);
  }
  return result;
}

export const conversationCallKey = (messageId: string, callId: string) => JSON.stringify([messageId, callId]);

export function conversationIndex(
  detail: {
    requests: RequestRecord[];
    agents: Agent[];
    tasks: Task[];
    operations: Operation[];
    messages: Message[];
  } | null,
) {
  const operations = new Map<string, Operation>();
  const responses = new Map<string, Message>();
  const boundResponses = new Set<string>();
  const operationsById = firstBy(detail?.operations, (value) => value.id);
  for (const operation of detail?.operations ?? [])
    if (operation.assistantMessageId)
      operations.set(conversationCallKey(operation.assistantMessageId, operation.toolCallId), operation);

  // Agent sessions can interleave and providers may reuse call IDs in later responses.
  // Pair only within the visible assistant occurrence; an orphan stays visible as raw text.
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
    // Legacy operations have no owner field. A recorded operationId in this
    // exact paired response is evidence; a coincident raw call ID alone is not.
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
        // Tool result bodies can be text; no association is inferred from text content.
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
