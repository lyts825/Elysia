import type { Entity } from './index.js';

export interface TerminalInboxPeer {
  runId: string;
  title: string;
  agent?: string;
}

/** APPLIED proves durable context inclusion, never that an external CLI read or acted on it. */
export interface InboxMessage extends Entity {
  runId: string;
  text: string;
  status: 'PENDING' | 'APPLIED';
  createdAt: string;
  appliedAt?: string;
  taskId?: string;
  operationId?: string;
  source?: TerminalInboxPeer;
  direction?: 'incoming' | 'outgoing';
  target?: TerminalInboxPeer;
  targetInboxId?: string;
}

export const TERMINAL_INBOX_MAX_PENDING = 100;
export const TERMINAL_INBOX_MAX_BYTES = 512 * 1024;
