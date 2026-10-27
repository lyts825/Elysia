/**
 * 终端任务间通信草稿及消息操作的契约。
 * 草稿恢复只保留用户输入及待核对命令，真正发送与处置仍需服务端授权和版本检查。
 *
 * EN: Defines terminal-to-terminal communication drafts and message operations.
 * Draft recovery retains input/pending command identity only; actual sends/resolutions still require server authorization and revision checks.
 */
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

/**
 * 通信记录保留方向、对端和处理状态；未知或不可用的结果不得视为已送达。
 *
 * EN: Communication records retain direction, peer, and handling state; unknown or unavailable results cannot be treated as delivered.
 */
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

/**
 * 在未知命令结果完成核对之前，保留原始条目快照。
 *
 * EN: Keep the original item snapshot until an unknown command outcome has been reconciled.
 */
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

/**
 * 恢复本地核验草稿的完整原条目快照；格式或身份字段损坏时返回 null，不发起处理操作。
 *
 * EN: Restores the complete original item snapshot in a local reconciliation draft; corrupt format/identity returns null without performing an operation.
 */
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

/**
 * 从不可信浏览器缓存恢复待发送正文与目标，限制文本长度并保留有效的命令身份。
 * 解析失败回到空草稿；返回值仍须用户提交并由服务端验证，读取缓存不会发送消息。
 *
 * EN: Restores pending text and target from untrusted browser cache with bounded text and valid command identity. Parsing failure returns an empty draft; only explicit submission and server validation can send it.
 */
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
    /**
     * 损坏缓存不会被转化为发送请求。
     *
     * EN: Corrupt cache values never become a send request.
     */
  }
  return { targetRunId: '', text: '' };
}
