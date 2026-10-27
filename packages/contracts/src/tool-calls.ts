// 检查消息序列中工具调用与结果的配对关系。
import type { Message, ToolCall } from './index.js';

export interface ToolCallOccurrence {
  message: Message;
  call: ToolCall;
  result?: Message;
}

/** Provider call IDs are scoped to an assistant response, not to a task or attempt. */
export function inspectToolCalls(messages: readonly Message[]) {
  const occurrences: ToolCallOccurrence[] = [];
  const waiting = new Map<string, ToolCallOccurrence>();
  let error: { code: string; message: string } | null = null;
  for (const message of messages) {
    // 下一条非工具消息出现前，当前响应中的所有调用都必须收到结果。
    if (message.role !== 'tool' && waiting.size) {
      error = { code: 'TOOL_PAIR_INCOMPLETE', message: '工具调用尚未配对，不能编译下一次请求' };
      break;
    }
    for (const call of message.calls ?? []) {
      if (message.role !== 'assistant' || waiting.has(call.id)) {
        error = { code: 'TOOL_PAIR_DUPLICATE', message: '工具调用身份重复或不属于模型响应' };
        break;
      }
      const occurrence = { message, call };
      occurrences.push(occurrence);
      waiting.set(call.id, occurrence);
    }
    if (error) break;
    if (message.role === 'tool') {
      const occurrence = message.callId ? waiting.get(message.callId) : undefined;
      if (!occurrence) {
        error = { code: 'TOOL_PAIR_INVALID', message: '工具结果没有对应调用' };
        break;
      }
      occurrence.result = message;
      waiting.delete(message.callId!);
    }
  }
  return { occurrences, pending: [...waiting.values()], error };
}

export function toolCallsClosed(messages: readonly Message[]) {
  const sequence = inspectToolCalls(messages);
  return !sequence.error && sequence.pending.length === 0;
}
