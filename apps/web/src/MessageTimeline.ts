/* 筛选和整理对话时间线中的消息。 */
import type { Message } from '../../../packages/contracts/src/index';

/** 仅将普通用户收件消息纳入去重，工具调用和特殊用途消息保留原样。 */
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

/** 同一运行的同一来源若正文一致只显示一次；正文冲突时保留所有记录供核对。 */
export function conversationMessages(messages: readonly Message[]): Message[] {
  // 先检查同源文字是否冲突再去重；单遍先删重复会隐藏后来发现的冲突证据。
  const sources = new Map<string, { text: string; conflict: boolean }>();
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
