/**
 * 供应商显式返回的推理展示与增量事件契约。
 * 只包含供应商明确返回供展示的文字，不包含不透明原生状态。
 * 仅承载可公开展示的推理文本，分页和截断按完整Unicode字符边界处理。
 *
 * EN: Defines provider-returned reasoning display and delta events.
 * Only text explicitly returned for display by a provider; never opaque native state.
 * Carries only displayable reasoning text, with paging/truncation preserving complete Unicode characters.
 */
export type ReasoningKind = 'reasoning_content' | 'summary';
export type ReasoningDisplay = {
  kind: ReasoningKind;
  status: 'streaming' | 'complete' | 'interrupted';
  /**
   * 有界展示缓存保留的 UTF-16 字符数。
   *
   * EN: UTF-16 characters retained by the bounded display cache.
   */
  characters: number;
  truncated: boolean;
  /**
   * 可选展示缓存无法核验时，发现元数据仍保持可见。
   *
   * EN: Discovery remains visible when this optional display cache cannot be validated.
   */
  readUnavailable?: true;
};
/**
 * 流增量以请求和偏移定位，接收端可据此按顺序合并显示文本。
 *
 * EN: Deltas identify request and offset so receivers can merge display text in order.
 */
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

/**
 * 仅非空字符串产生展示元数据；正文可能超过展示上限并标记为截断。
 *
 * EN: Only nonempty strings produce display metadata; bodies beyond the display cap are marked truncated.
 */
export function completedReasoning(text: unknown): ReasoningDisplay | undefined {
  if (typeof text !== 'string' || !text.length) return;
  return {
    kind: 'reasoning_content',
    status: 'complete',
    characters: reasoningPrefixLength(text, REASONING_DISPLAY_MAX_CHARS),
    truncated: text.length > reasoningPrefixLength(text, REASONING_DISPLAY_MAX_CHARS),
  };
}
/**
 * 截断位置不落在 UTF-16 高代理项之后，避免拆开字符。
 *
 * EN: The cut does not follow a UTF-16 high surrogate, avoiding a split character.
 */
export function reasoningPrefixLength(text: string, limit: number): number {
  let end = Math.min(text.length, limit);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return end;
}
/**
 * 检查 UTF-16 偏移是否落在代理对中间，供分页拒绝无法独立解码的起点。
 *
 * EN: Tests whether a UTF-16 offset lies inside a surrogate pair so paging can reject an invalid starting point.
 */
export function splitsReasoningCharacter(text: string, offset: number): boolean {
  const current = text.charCodeAt(offset),
    prior = text.charCodeAt(offset - 1);
  return current >= 0xdc00 && current <= 0xdfff && prior >= 0xd800 && prior <= 0xdbff;
}
/**
 * 公开消息携带发现元数据；展示文本需显式加载。
 * 公共消息仅携带推理发现元数据；正文需要通过专用读取路径获取。
 *
 * EN: Public messages carry discovery metadata; display text is loaded explicitly.
 * Public messages carry only reasoning-discovery metadata; text is obtained through a dedicated read path.
 */
export function reasoningMessagePreview<T extends { reasoningContent?: string }>(message: T) {
  const { reasoningContent, ...visible } = message;
  const reasoning = completedReasoning(reasoningContent);
  return { ...visible, ...(reasoning ? { reasoning } : {}) };
}
