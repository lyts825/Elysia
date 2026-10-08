import type { Message } from '../../../packages/contracts/src/index';

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

export function conversationMessages(messages: readonly Message[]): Message[] {
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
