/* 定义并读取任务继续执行时使用的草稿。 */
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
    // An invalid recovery value cannot become a continuation request.
  }
  return { text: '', mode: 'resume' };
}
