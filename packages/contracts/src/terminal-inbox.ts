import type { Entity } from './index.js';

export interface TerminalInboxPeer {
  runId: string;
  title: string;
  agent?: string;
}

export interface TerminalInboxResolution {
  kind: 'dismissed' | 'withdrawn';
  note: string;
  at: string;
  byRunId: string;
  by: TerminalInboxPeer;
}

/** APPLIED proves durable context inclusion, never that an external CLI read or acted on it. */
export interface InboxMessage extends Entity {
  runId: string;
  text: string;
  /** Native task feedback; absent legacy records retain their original replanning behavior. */
  intent?: 'continue' | 'replan';
  status: 'PENDING' | 'APPLIED' | 'DISMISSED';
  createdAt: string;
  appliedAt?: string;
  taskId?: string;
  operationId?: string;
  source?: TerminalInboxPeer;
  direction?: 'incoming' | 'outgoing';
  target?: TerminalInboxPeer;
  targetInboxId?: string;
  resolution?: TerminalInboxResolution;
}

export const TERMINAL_INBOX_MAX_PENDING = 100;
export const TERMINAL_INBOX_MAX_BYTES = 512 * 1024;
