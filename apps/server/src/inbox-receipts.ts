/** 按当前入口读取原生补充消息，使用持久 ID 分页，坏记录不伪装为未发送。
 * EN: Reads native supplements by durable identity within one surface; corrupt rows are not treated as unsent.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, type Run } from '../../../packages/contracts/src/index.js';
import type {
  NativeInboxReceipt,
  NativeInboxReceiptPage,
} from '../../../packages/contracts/src/inbox-receipts.js';
import type { Store } from '../../../packages/storage/src/index.js';

const messageSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  runId: z.string().uuid(),
  text: z.string().max(200_000),
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().optional(),
  status: z.enum(['PENDING', 'APPLIED', 'DISMISSED']),
  intent: z.enum(['continue', 'replan']).optional(),
});
const params = z.object({ id: z.string().uuid() });
const stateSql = "COALESCE(json_extract(data,'$.readModel.status'),json_extract(data,'$.status'))";

export class NativeInboxReceipts {
  constructor(private readonly store: Store) {}

  private run(runId: string) {
    const run = this.store.require<Run>('runs', runId);
    if (run.execution?.kind === 'docker-agent')
      throw new AppError('NATIVE_INBOX_ONLY', '终端消息请从终端通信入口读取');
    return run;
  }

  private waitingReason(run: Run) {
    if (run.archived) return '消息已保存；当前对话已归档。';
    if (['DONE', 'CANCELLED', 'FAILED'].includes(run.status)) return '消息已保存；运行已结束，未继续应用。';
    if (this.store.getExecutionHold(run.id)) return '消息已保存；调度已停止，等待明确恢复。';
    const unresolved = (table: 'requests' | 'tool_operations', states: string[]) =>
      !!this.store.db
        .prepare(
          `SELECT 1 FROM ${table} WHERE run_id=? AND ${stateSql} IN (${states.map(() => '?').join(',')}) LIMIT 1`,
        )
        .get(run.id, ...states);
    if (
      unresolved('requests', ['UNKNOWN']) ||
      unresolved('tool_operations', ['UNCERTAIN']) ||
      run.reason === 'verification'
    )
      return '消息已保存；需先核验未知请求或操作结果。';
    if (run.status === 'WAITING' && !['user', 'plan'].includes(run.reason ?? ''))
      return '消息已保存；等待当前暂停、限制或阻塞解除。';
    return '消息已保存；等待执行器在安全检查点加入上下文。';
  }

  private receipt(run: Run, id: string): { item: NativeInboxReceipt; text: string } {
    const raw = this.store.require('inbox', id);
    const value = messageSchema.parse(raw);
    if (value.runId !== run.id) throw new AppError('INBOX_SCOPE', '消息不属于当前对话');
    const points = Array.from(value.text);
    return {
      item: {
        id: value.id,
        revision: value.revision,
        status:
          value.status === 'APPLIED' ? 'applied' : value.status === 'DISMISSED' ? 'dismissed' : 'pending',
        receivedAt: value.createdAt,
        ...(value.appliedAt ? { appliedAt: value.appliedAt } : {}),
        intent: value.intent ?? 'legacy',
        preview: points.slice(0, 500).join(''),
        truncated: points.length > 500,
        reason:
          value.status === 'APPLIED'
            ? '已持久加入上下文；不代表模型已读或要求已完成。'
            : value.status === 'DISMISSED'
              ? '消息已结束处理，未作为待处理输入继续发送。'
              : this.waitingReason(run),
      },
      text: value.text,
    };
  }

  list(runId: string, before?: string): NativeInboxReceiptPage {
    return this.store.tx(() => {
      const run = this.run(runId);
      const boundary = before
        ? (this.store.db.prepare('SELECT rowid FROM inbox WHERE id=? AND run_id=?').get(before, runId) as
            | { rowid: number }
            | undefined)
        : undefined;
      if (before && !boundary)
        throw new AppError('INBOX_CURSOR_CHANGED', '消息分页位置已变化，请返回最新消息', true, null, 409);
      const rows = this.store.db
        .prepare(
          `SELECT id FROM inbox WHERE run_id=?${boundary ? ' AND rowid<?' : ''} ORDER BY rowid DESC LIMIT 21`,
        )
        .all(runId, ...(boundary ? [boundary.rowid] : [])) as { id: string }[];
      const totals = this.store.db
        .prepare(
          `SELECT COUNT(*) total,SUM(CASE WHEN ${stateSql}='PENDING' THEN 1 ELSE 0 END) pending FROM inbox WHERE run_id=?`,
        )
        .get(runId) as { total: number; pending: number | null };
      const items: NativeInboxReceipt[] = [];
      let unavailable = 0;
      for (const row of rows.slice(0, 20)) {
        try {
          items.push(this.receipt(run, row.id).item);
        } catch {
          unavailable++;
        }
      }
      return {
        runId,
        capturedAt: new Date().toISOString(),
        items,
        total: totals.total,
        pending: totals.pending ?? 0,
        page: {
          before: before ?? null,
          nextBefore: rows.length > 20 ? rows[19].id : null,
          hasMore: rows.length > 20,
          limit: 20,
        },
        coverage: { complete: unavailable === 0, unavailable },
      };
    });
  }

  detail(runId: string, messageId: string) {
    return this.store.tx(() => {
      const run = this.run(runId);
      if (!this.store.db.prepare('SELECT 1 FROM inbox WHERE id=? AND run_id=?').get(messageId, runId))
        throw new AppError('INBOX_NOT_FOUND', '当前对话中没有这条消息', false, null, 404);
      try {
        const { item, text } = this.receipt(run, messageId);
        return { ...item, text };
      } catch {
        throw new AppError(
          'INBOX_READ_UNAVAILABLE',
          '消息记录无法核验，原记录保留，请稍后重试',
          true,
          null,
          409,
        );
      }
    });
  }
}

export function registerNativeInboxReceipts(app: FastifyInstance, store: Store) {
  const receipts = new NativeInboxReceipts(store);
  app.get('/api/runs/:id/inbox-receipts', async (request) => {
    const { id } = params.parse(request.params);
    const query = z.object({ before: z.string().uuid().optional() }).strict().parse(request.query);
    return receipts.list(id, query.before);
  });
  app.get('/api/runs/:id/inbox-receipts/:messageId', async (request) => {
    const { id, messageId } = params.extend({ messageId: z.string().uuid() }).parse(request.params);
    return receipts.detail(id, messageId);
  });
  return receipts;
}
