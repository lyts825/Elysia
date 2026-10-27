// 供应商显式返回的推理展示与增量事件契约。
/** Only text explicitly returned for display by a provider; never opaque native state. */
export type ReasoningKind = 'reasoning_content' | 'summary';
export type ReasoningDisplay = {
  kind: ReasoningKind;
  status: 'streaming' | 'complete' | 'interrupted';
  /** UTF-16 characters retained by the bounded display cache. */
  characters: number;
  truncated: boolean;
  /** Discovery remains visible when this optional display cache cannot be validated. */
  readUnavailable?: true;
};
// 流增量以请求和偏移定位，接收端可据此按顺序合并显示文本。
export type ReasoningDelta = {
  runId: string;
  taskId: string;
  requestId: string;
  kind: ReasoningKind;
  text: string;
  offset: number;
};
export type ReasoningPage = {
  runId: string;
  messageId?: string;
  requestId?: string;
  reasoning: ReasoningDisplay | null;
  text: string;
  offset: number;
  nextOffset: number | null;
};
export const REASONING_DISPLAY_MAX_CHARS = 256 * 1024;
export const REASONING_PAGE_MAX_CHARS = 16 * 1024;

// 仅非空字符串产生展示元数据；正文可能超过展示上限并标记为截断。
export function completedReasoning(text: unknown): ReasoningDisplay | undefined {
  if (typeof text !== 'string' || !text.length) return;
  return {
    kind: 'reasoning_content',
    status: 'complete',
    characters: reasoningPrefixLength(text, REASONING_DISPLAY_MAX_CHARS),
    truncated: text.length > reasoningPrefixLength(text, REASONING_DISPLAY_MAX_CHARS),
  };
}
// 截断位置不落在 UTF-16 高代理项之后，避免拆开字符。
export function reasoningPrefixLength(text: string, limit: number): number {
  let end = Math.min(text.length, limit);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return end;
}
/** 检查 UTF-16 偏移是否落在代理对中间，供分页拒绝无法独立解码的起点。 */
export function splitsReasoningCharacter(text: string, offset: number): boolean {
  const current = text.charCodeAt(offset),
    prior = text.charCodeAt(offset - 1);
  return current >= 0xdc00 && current <= 0xdfff && prior >= 0xd800 && prior <= 0xdbff;
}
/** Public messages carry discovery metadata; display text is loaded explicitly. */
// 公共消息仅携带推理发现元数据；正文需要通过专用读取路径获取。
export function reasoningMessagePreview<T extends { reasoningContent?: string }>(message: T) {
  const { reasoningContent, ...visible } = message;
  const reasoning = completedReasoning(reasoningContent);
  return { ...visible, ...(reasoning ? { reasoning } : {}) };
}
