/**
 * 定义并读取任务继续执行时使用的草稿。
 * 集中定义反馈、交接和修订面板共享的续接输入，严格读取有界草稿；不把损坏的原文静默替换为可提交内容。
 * EN: Defines and restores the draft used when continuing a task. Defines continuation input shared by feedback, handoff, and revision panels and strictly reads bounded drafts; malformed source is not silently replaced with submittable data.
 */
export type ContinuationDraft = {
  text: string;
  mode: 'resume' | 'new-session';
  inboxIds?: string[];
  commandId?: string;
  expectedRevision?: number;
};
/**
 * 容错恢复续接表单，文本最多 60000 字符，合法收件 ID 去重后最多 100 项。
 * commandId 与 expectedRevision 仅在各自合法时保留，调用方仍需确认二者和当前输入共同
 * 构成可重试请求；本函数返回有效表单不代表终端已具备恢复资格。
 * EN: Recover the continuation form defensively: text is limited to 60000 characters and valid inbox IDs are deduplicated and capped at 100. Keep commandId and expectedRevision only when individually valid; callers must still verify that both and the input form a retryable request. A valid form does not establish terminal resume eligibility.
 */
export function readContinuationDraft(value: string | boolean | undefined): ContinuationDraft {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : null;
    if (parsed && typeof parsed.text === 'string' && ['resume', 'new-session'].includes(parsed.mode))
      return {
        text: parsed.text.slice(0, 60000),
        mode: parsed.mode,
        ...(Array.isArray(parsed.inboxIds)
          ? {
              inboxIds: [
                ...new Set<string>(
                  parsed.inboxIds.filter(
                    (id: unknown) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id),
                  ),
                ),
              ].slice(0, 100),
            }
          : {}),
        ...(typeof parsed.commandId === 'string' && /^[a-f0-9-]{36}$/.test(parsed.commandId)
          ? { commandId: parsed.commandId }
          : {}),
        ...(Number.isSafeInteger(parsed.expectedRevision) && parsed.expectedRevision >= 0
          ? { expectedRevision: parsed.expectedRevision }
          : {}),
      };
  } catch {
    /**
     * 无效的恢复值不能变为继续执行请求。
     * EN: An invalid recovery value cannot become a continuation request.
     */
  }
  return { text: '', mode: 'resume' };
}
