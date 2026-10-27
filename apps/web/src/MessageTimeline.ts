/**
 * 筛选和整理对话时间线中的消息。
 * 识别由收件箱派生的用户消息并在来源一致时去重，保留文本冲突和不可配对项；不修改原始消息记录。
 * EN: Filters and orders conversation timeline messages. Recognizes inbox-derived user messages and deduplicates matching sources while retaining text conflicts and unmatched entries, without mutating source records.
 */
import type { Message } from '../../../packages/contracts/src/index';

/**
 * 仅将普通用户收件消息纳入去重，工具调用和特殊用途消息保留原样。
 * EN: Deduplicate ordinary user inbox messages only; retain tool calls and special-purpose messages.
 */
export function isInboxUserMessage(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.purpose === undefined &&
    typeof message.sourceInboxId === 'string' &&
    !!message.sourceInboxId.trim() &&
    !message.calls?.length &&
    message.callId === undefined
  );
}

/**
 * 同一运行的同一来源若正文一致只显示一次；正文冲突时保留所有记录供核对。
 * EN: Show equal text from one source once per run; retain all records when source text conflicts.
 */
export function conversationMessages(messages: readonly Message[]): Message[] {
  /**
   * 先检查同源文字是否冲突再去重；单遍先删重复会隐藏后来发现的冲突证据。
   * EN: Detect source-text conflicts before deduplicating so a later conflict cannot lose its earlier evidence.
   */
  const sources = new Map<string, { text: string; conflict: boolean }>();
  /**
   * 以运行ID和收件箱来源ID生成复合键，跨运行去重时不把不同来源的用户消息混为一条。
   * EN: Builds a composite key from run and inbox-source IDs so deduplication does not merge user messages from different runs.
   */
  const sourceKey = (message: Message) => JSON.stringify([message.runId, message.sourceInboxId]);
  for (const message of messages) {
    if (!isInboxUserMessage(message)) continue;
    const key = sourceKey(message);
    const prior = sources.get(key);
    if (!prior) sources.set(key, { text: message.text, conflict: false });
    else if (prior.text !== message.text) prior.conflict = true;
  }
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (!isInboxUserMessage(message)) return true;
    const key = sourceKey(message);
    if (sources.get(key)?.conflict) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
