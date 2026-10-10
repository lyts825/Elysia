export type ContinuationDraft = { text: string; mode: 'resume' | 'new-session' };
export function readContinuationDraft(value: string | boolean | undefined): ContinuationDraft {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : null;
    if (parsed && typeof parsed.text === 'string' && ['resume', 'new-session'].includes(parsed.mode))
      return { text: parsed.text.slice(0, 60000), mode: parsed.mode };
  } catch {
    // An invalid recovery value cannot become a continuation request.
  }
  return { text: '', mode: 'resume' };
}
