/* 定义并读取任务继续执行时使用的草稿。 */
export type ContinuationDraft = {
  text: string;
  mode: 'resume' | 'new-session';
  inboxIds?: string[];
  commandId?: string;
  expectedRevision?: number;
};
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
