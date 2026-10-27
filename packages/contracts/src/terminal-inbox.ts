// 终端收件箱消息及处理结果的数据契约。
import type { Entity } from './index.js';

/** 冻结的对端说明用于追溯消息来源；不是对另一个运行的访问授权。 */
export interface TerminalInboxPeer {
  runId: string;
  title: string;
  agent?: string;
}

// 处理记录保留动作、说明、时间和来源任务，便于回查。
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
  /** 出站记录关联目标入站记录，用于核对排队、纳入上下文或撤回结果。 */
  targetInboxId?: string;
  resolution?: TerminalInboxResolution;
}

export const TERMINAL_INBOX_MAX_PENDING = 100;
export const TERMINAL_INBOX_MAX_BYTES = 512 * 1024;
