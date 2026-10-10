import type { Agent, Message, Operation, RequestRecord, Task } from '../../../packages/contracts/src/index';

function firstBy<T>(values: readonly T[] | undefined, key: (value: T) => string | undefined) {
  const result = new Map<string, T>();
  for (const value of values || []) {
    const id = key(value);
    if (id && !result.has(id)) result.set(id, value);
  }
  return result;
}

export function conversationIndex(
  detail: {
    requests: RequestRecord[];
    agents: Agent[];
    tasks: Task[];
    operations: Operation[];
    messages: Message[];
  } | null,
) {
  return {
    requests: firstBy(detail?.requests, (value) => value.id),
    sessions: firstBy(detail?.agents, (value) => value.sessionId),
    agents: firstBy(detail?.agents, (value) => value.taskId),
    tasks: firstBy(detail?.tasks, (value) => value.id),
    operations: firstBy(detail?.operations, (value) => value.toolCallId),
    responses: firstBy(
      detail?.messages.filter((value) => value.role === 'tool'),
      (value) => value.callId,
    ),
  };
}
