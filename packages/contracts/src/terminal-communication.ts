// 终端任务间通信草稿及消息操作的契约。
import { z } from 'zod';
import type { TerminalInboxResolution } from './terminal-inbox.js';

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
  revision: number;
  direction: 'incoming' | 'outgoing';
  text: string;
  createdAt: string;
  peer?: TerminalPeer & { available: boolean };
  status: 'queued' | 'included' | 'dismissed' | 'unavailable';
  operationId?: string;
  resolution?: Omit<TerminalInboxResolution, 'by'> & { by?: TerminalInboxResolution['by'] };
};

/** Keep the original item snapshot until an unknown command outcome has been reconciled. */
export type TerminalResolutionDraft = {
  item: TerminalCommunicationItem;
  note: string;
  commandId?: string;
};

const resolutionPeer = z
  .object({ runId: z.string().uuid(), title: z.string().max(240), agent: z.string().max(100).optional() })
  .strict();
const resolutionDraft = z
  .object({
    item: z
      .object({
        id: z.string().uuid(),
        revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        direction: z.enum(['incoming', 'outgoing']),
        text: z.string().max(20000),
        createdAt: z.string().datetime({ offset: true }),
        peer: resolutionPeer.extend({ agent: z.string().max(100), available: z.boolean() }).optional(),
        status: z.enum(['queued', 'included', 'dismissed', 'unavailable']),
        operationId: z.string().uuid().optional(),
        resolution: z
          .object({
            kind: z.enum(['dismissed', 'withdrawn']),
            note: z.string().min(1).max(2000),
            at: z.string().datetime({ offset: true }),
            byRunId: z.string().uuid(),
            by: resolutionPeer.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    note: z.string().max(2000),
    commandId: z.string().uuid().optional(),
  })
  .strict();

export function readTerminalResolutionDraft(
  value: string | boolean | undefined,
): TerminalResolutionDraft | null {
  try {
    const parsed = resolutionDraft.safeParse(typeof value === 'string' ? JSON.parse(value) : null);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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
