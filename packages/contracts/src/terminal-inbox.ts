/**
 * 终端收件箱消息及处理结果的数据契约。
 * 纳入上下文、排队和对端处理是不同事实，状态不得扩大为外部终端已执行的保证。
 *
 * EN: Defines terminal inbox messages and handling results.
 * Context inclusion, queuing, and peer handling are distinct facts, never guarantees that an external terminal acted.
 */
import type { Entity } from './index.js';

/**
 * 冻结的对端说明用于追溯消息来源；不是对另一个运行的访问授权。
 *
 * EN: A frozen peer description traces the message source; it grants no access to another run.
 */
export interface TerminalInboxPeer {
  runId: string;
  title: string;
  agent?: string;
}

/**
 * 处理记录保留动作、说明、时间和来源任务，便于回查。
 *
 * EN: Handling records retain action, explanation, time, and source task for inspection.
 */
export interface TerminalInboxResolution {
  kind: 'dismissed' | 'withdrawn';
  note: string;
  at: string;
  byRunId: string;
  by: TerminalInboxPeer;
}

/**
 * APPLIED 只证明已持久纳入上下文，不证明外部 CLI 已读取或采取行动。
 *
 * EN: APPLIED proves durable context inclusion, never that an external CLI read or acted on it.
 */
export interface InboxMessage extends Entity {
  runId: string;
  text: string;
  /**
   * 原生任务反馈；缺少字段的旧记录保留原有重新规划行为。
   *
   * EN: Native task feedback; absent legacy records retain their original replanning behavior.
   */
  intent?: 'continue' | 'replan';
  status: 'PENDING' | 'APPLIED' | 'DISMISSED';
  createdAt: string;
  appliedAt?: string;
  taskId?: string;
  operationId?: string;
  source?: TerminalInboxPeer;
  direction?: 'incoming' | 'outgoing';
  target?: TerminalInboxPeer;
  /**
   * 出站记录关联目标入站记录，用于核对排队、纳入上下文或撤回结果。
   *
   * EN: Outbound records link target inbound records to reconcile queueing, context inclusion, or withdrawal.
   */
  targetInboxId?: string;
  resolution?: TerminalInboxResolution;
}

export const TERMINAL_INBOX_MAX_PENDING = 100;
export const TERMINAL_INBOX_MAX_BYTES = 512 * 1024;
