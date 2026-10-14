export type TerminalPeer = {
  runId: string;
  title: string;
  agent: string;
};

export type TerminalCommunicationDraft = {
  targetRunId: string;
  text: string;
  commandId?: string;
  expectedRevision?: number;
};

export type TerminalCommunicationItem = {
  id: string;
  direction: 'incoming' | 'outgoing';
  text: string;
  createdAt: string;
  peer?: TerminalPeer & { available: boolean };
  status: 'queued' | 'included' | 'unavailable';
  operationId?: string;
};

export type TerminalCommunicationPage = {
  items: TerminalCommunicationItem[];
  page: { total: number; hasMore: boolean; nextBefore: string | null };
  pendingCount: number;
};

export type TerminalPeerPage = {
  items: (TerminalPeer & { status: string; reason?: string; canReceive: boolean })[];
  page: { total: number; hasMore: boolean; nextBefore: string | null };
};

export function readTerminalCommunicationDraft(
  value: string | boolean | undefined,
): TerminalCommunicationDraft {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : null;
    if (parsed && typeof parsed.targetRunId === 'string' && typeof parsed.text === 'string')
      return {
        targetRunId: parsed.targetRunId,
        text: parsed.text.slice(0, 20000),
        ...(typeof parsed.commandId === 'string' ? { commandId: parsed.commandId } : {}),
        ...(Number.isSafeInteger(parsed.expectedRevision) && parsed.expectedRevision >= 0
          ? { expectedRevision: parsed.expectedRevision }
          : {}),
      };
  } catch {
    // Corrupt cache values never become a send request.
  }
  return { targetRunId: '', text: '' };
}
