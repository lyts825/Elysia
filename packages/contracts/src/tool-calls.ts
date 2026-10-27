/**
 * 检查消息序列中工具调用与结果的配对关系。
 * 配对范围固定为持久助手响应，避免供应商重用调用ID导致跨轮关联错误。
 *
 * EN: Checks pairing between tool calls and results in a message sequence.
 * Scopes pairing to durable assistant responses so reused provider call IDs cannot cross-associate turns.
 */
import type { Message, ToolCall } from './index.js';

export interface ToolCallOccurrence {
  /**
   * 拥有调用身份的持久 assistant 消息，供应商 call ID 只在此响应内唯一。
   *
   * EN: The durable assistant message owning call identity; a provider call ID is unique only within that response.
   */
  message: Message;
  call: ToolCall;
  result?: Message;
}

/**
 * 供应商调用 ID 的作用域是单条助手响应，不是任务或执行尝试。
 * 返回遇到的调用、仍在等待的调用和首个配对错误；同一响应内的调用 ID 必须唯一。
 *
 * EN: Provider call IDs are scoped to an assistant response, not to a task or attempt.
 * Returns encountered calls, pending calls, and the first pairing error; call IDs must be unique within a response.
 */
export function inspectToolCalls(messages: readonly Message[]) {
  const occurrences: ToolCallOccurrence[] = [];
  /**
   * waiting 只包含当前 assistant 响应；全部结果消费后，后续响应可合法复用供应商 ID。
   *
   * EN: waiting contains only the current assistant response; later responses may reuse provider IDs after all results are consumed.
   */
  const waiting = new Map<string, ToolCallOccurrence>();
  let error: { code: string; message: string } | null = null;
  for (const message of messages) {
    /**
     * 下一条非工具消息出现前，当前响应中的所有调用都必须收到结果。
     *
     * EN: Every call in the current response needs a result before the next non-tool message.
     */
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
      /**
       * 仅接受当前尚未完成的调用 ID，已消费的结果不能再次配对。
       *
       * EN: Accepts only currently pending call IDs; an already-consumed result cannot pair a second time.
       */
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

/**
 * 判断消息序列是否没有错误且所有工具调用都已得到结果。
 *
 * EN: Tests that the sequence has no error and every tool call has a result.
 */
export function toolCallsClosed(messages: readonly Message[]) {
  const sequence = inspectToolCalls(messages);
  return !sequence.error && sequence.pending.length === 0;
}
