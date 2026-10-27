/* 读取和匹配回复回执，并生成回执载荷。 */
/** Native message receipts share the existing per-run send key with terminal receipts. */
export type ReplyReceipt = {
  version: 1;
  targetRunId: string;
  text: string;
  intent?: 'continue' | 'replan';
  commandId: string;
  expectedRevision: number;
  outcome?: 'not-sent';
};

export function readReplyReceipt(value: string | boolean | undefined): ReplyReceipt | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : null;
    if (
      parsed?.version !== 1 ||
      typeof parsed.targetRunId !== 'string' ||
      !parsed.targetRunId ||
      typeof parsed.text !== 'string' ||
      !parsed.text.trim() ||
      parsed.text.length > 20000 ||
      !['continue', 'replan', undefined].includes(parsed.intent) ||
      !['not-sent', undefined].includes(parsed.outcome) ||
      typeof parsed.commandId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parsed.commandId) ||
      !Number.isSafeInteger(parsed.expectedRevision) ||
      parsed.expectedRevision < 0
    )
      return null;
    return {
      version: 1,
      targetRunId: parsed.targetRunId,
      text: parsed.text,
      ...(parsed.intent === undefined ? {} : { intent: parsed.intent }),
      commandId: parsed.commandId,
      expectedRevision: parsed.expectedRevision,
      ...(parsed.outcome === undefined ? {} : { outcome: parsed.outcome }),
    };
  } catch {
    return null;
  }
}

export function inspectReplyReceipt(value: string | boolean | undefined, targetRunId: string) {
  if (value === undefined || value === '') return { status: 'empty' as const };
  const receipt = readReplyReceipt(value);
  if (!receipt || receipt.targetRunId !== targetRunId)
    return {
      status: 'unreadable' as const,
      message: '发送回执无法读取或不属于当前任务，原记录和草稿已保留；请在本地草稿中核对，不能直接覆盖重发。',
    };
  return { status: 'ready' as const, receipt };
}

export function matchesReplyReceipt(
  receipt: ReplyReceipt | null,
  targetRunId: string,
  text: string,
  intent: 'continue' | 'replan' | undefined,
): receipt is ReplyReceipt {
  return (
    !!receipt &&
    !receipt.outcome &&
    receipt.targetRunId === targetRunId &&
    receipt.text === text &&
    (receipt.intent ?? 'continue') === (intent ?? 'continue')
  );
}

export const replyReceiptPayload = (receipt: ReplyReceipt) => ({
  commandId: receipt.commandId,
  expectedRevision: receipt.expectedRevision,
  text: receipt.text,
  ...(receipt.intent === undefined ? {} : { intent: receipt.intent }),
});
