/**
 * 管理终端通信并注册相关接口。
 * 管理同项目待收消息、双向回执及撤回/忽略，关联核对归属、原文和 ID；消息只排队，后续显式续接才进入 CLI。
 * EN: Manages terminal messaging and registers endpoints. Manages same-project queued messages, verified bidirectional receipts and dispositions; explicit later continuation alone sends selected messages to CLI.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  Command,
  invariant,
  type Project,
  type Run,
} from '../../../packages/contracts/src/index.js';
import type {
  InboxMessage,
  TerminalInboxResolution,
} from '../../../packages/contracts/src/terminal-inbox.js';
import type {
  TerminalCommunicationItem,
  TerminalCommunicationPage,
  TerminalPeer,
  TerminalPeerPage,
} from '../../../packages/contracts/src/terminal-communication.js';
import type { Kernel } from '../../../packages/kernel/src/index.js';
import { id, now, type Store } from '../../../packages/storage/src/index.js';
import { projectionReads } from '../../../packages/storage/src/projection-reads.js';

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().uuid().optional(),
});
/**
 * 生成终端消息接收者的小型公开描述，标题有界且只暴露 CLI 类型。
 * EN: Builds a compact public terminal peer with bounded title and CLI kind only.
 */
const peer = (run: Run): TerminalPeer => ({
  runId: run.id,
  title: (run.title || run.objective).slice(0, 240),
  agent: run.execution?.kind === 'docker-agent' ? run.execution.profile.agent : '',
});

/**
 * 管理终端任务之间的消息、回执及需人工处理的消息状态。
 * EN: Manages messages, receipts and manual dispositions between terminal tasks.
 */
export class TerminalCommunication {
  /**
   * 绑定消息持久存储及内核事件能力，不创建跨终端直接 stdin 通道。
   * EN: Binds message storage and kernel events without creating direct cross-terminal stdin channels.
   */
  constructor(
    private store: Store,
    private kernel: Kernel<Store>,
  ) {}

  /**
   * 要求指定运行是终端 task，其他执行类型或不存在时立即拒绝。
   * EN: Requires a terminal task run and rejects missing or other execution types.
   */
  run(runId: string) {
    const run = this.store.require<Run>('runs', runId);
    invariant(
      run.execution?.kind === 'docker-agent' && run.kind === 'task',
      'TERMINAL_REQUIRED',
      '请选择终端任务',
    );
    return run;
  }

  /**
   * 按持久收件状态统计 PENDING 数量，供接收容量检查而不读取消息正文。
   * EN: Counts persisted PENDING inbox rows for capacity checks without reading bodies.
   */
  pendingCount(runId: string) {
    return Number(
      (
        this.store.db
          .prepare("SELECT COUNT(*) n FROM inbox WHERE run_id=? AND json_extract(data,'$.status')='PENDING'")
          .get(runId) as { n: number }
      ).n,
    );
  }

  /**
   * 以双向运行、收件 ID、方向和原文共同确认回执，不能仅凭客户端传来的收件 ID 关联。
   * EN: Matches receipts by both runs, inbox ID, direction and original text rather than trusting a client inbox ID alone.
   */
  private boundReceipt(sent: InboxMessage, received: InboxMessage | undefined) {
    return !!(
      received &&
      sent.direction === 'outgoing' &&
      sent.targetInboxId === received.id &&
      sent.target?.runId === received.runId &&
      (received.direction === undefined || received.direction === 'incoming') &&
      !received.target &&
      !received.targetInboxId &&
      received.source?.runId === sent.runId &&
      received.runId !== sent.runId &&
      received.text === sent.text
    );
  }

  /**
   * 发件视图的投递状态来自可核验的收件记录；收件缺失时显示 unavailable，不猜成已处理。
   * EN: Derives sent delivery state from verifiable inbox records; missing inbox data is unavailable, never guessed handled.
   */
  private item(item: InboxMessage): TerminalCommunicationItem {
    const outgoing = item.direction === 'outgoing';
    const other = outgoing ? item.target : item.source;
    const available = other ? this.store.get<Run>('runs', other.runId) : undefined;
    const candidate =
      outgoing && item.targetInboxId ? this.store.get<InboxMessage>('inbox', item.targetInboxId) : undefined;
    const received = outgoing ? (this.boundReceipt(item, candidate) ? candidate : undefined) : item;
    return {
      id: item.id,
      revision: received?.revision ?? item.revision,
      direction: outgoing ? 'outgoing' : 'incoming',
      text: item.text,
      createdAt: item.createdAt,
      ...(other ? { peer: { ...other, agent: other.agent ?? '', available: !!available } } : {}),
      status: !received
        ? 'unavailable'
        : received.status === 'PENDING'
          ? 'queued'
          : received.status === 'DISMISSED'
            ? 'dismissed'
            : 'included',
      ...(received?.operationId ? { operationId: received.operationId } : {}),
      ...(received?.resolution ? { resolution: received.resolution } : {}),
    };
  }

  /**
   * 授权前先解析身份，不能根据调用方提供的 ID 猜测收件者。
   * EN: Resolve identity before authorization; never infer a recipient from caller-supplied IDs.
   */
  resolutionContext(runId: string, messageId: string) {
    const actor = this.run(runId);
    const message = this.store.require<InboxMessage>('inbox', messageId);
    invariant(message.runId === actor.id, 'TERMINAL_MESSAGE_SCOPE', '消息不属于当前终端');
    const outgoing = message.direction === 'outgoing';
    const received = outgoing
      ? message.targetInboxId
        ? this.store.get<InboxMessage>('inbox', message.targetInboxId)
        : undefined
      : message;
    invariant(
      outgoing
        ? this.boundReceipt(message, received)
        : (message.direction === undefined || message.direction === 'incoming') &&
            !message.target &&
            !message.targetInboxId,
      'TERMINAL_MESSAGE_BINDING',
      '消息收发绑定已变化或接收记录已删除，请刷新后核对',
    );
    const recipient = outgoing ? this.run(received!.runId) : actor;
    const sourceRecord = received!.source ? this.store.get<Run>('runs', received!.source.runId) : undefined;
    const source = sourceRecord ? this.run(sourceRecord.id) : undefined;
    invariant(
      (!source ||
        (source.id !== recipient.id && source.projectId && source.projectId === recipient.projectId)) &&
        (!outgoing || source?.id === actor.id),
      'TERMINAL_PROJECT_MISMATCH',
      '消息来源与接收终端必须属于同一项目',
    );
    return {
      actor,
      message,
      received: received!,
      recipient,
      source,
      kind: outgoing ? ('withdrawn' as const) : ('dismissed' as const),
      mutableRunIds: outgoing ? [actor.id, recipient.id] : [actor.id],
    };
  }

  /**
   * 仅可撤回/忽略仍为 PENDING 的消息；已加入 CLI 输入的内容不能通过修改收件状态撤销。 以收件记录 revision 校验并发，在同一事务保存说明和双方事件，使发件视图能追溯处置依据。
   * EN: Only pending messages can be withdrawn/ignored; inbox edits cannot revoke content already sent to CLI input. Uses inbox revision and atomically saves explanations and both events for traceable dispositions.
   */
  resolve(runId: string, messageId: string, expectedMessageRevision: number, note: string) {
    return this.store.tx(() => {
      const context = this.resolutionContext(runId, messageId);
      invariant(
        Number.isSafeInteger(expectedMessageRevision) &&
          expectedMessageRevision >= 0 &&
          typeof note === 'string' &&
          !!note.trim() &&
          note.trim().length <= 2000,
        'TERMINAL_MESSAGE_RESOLUTION_INPUT',
        '请填写不再处理或撤回的理由，最多 2000 字',
      );
      for (const id of context.mutableRunIds) {
        const run = this.run(id);
        invariant(
          !run.archived &&
            (!run.projectId || !this.store.require<Project>('projects', run.projectId).archived),
          'ARCHIVED',
          '请先恢复归档的任务或项目',
        );
      }
      if (context.received.revision !== expectedMessageRevision)
        throw new AppError(
          'REVISION_CONFLICT',
          '消息已更新，请刷新后重新核对',
          false,
          { currentRevision: context.received.revision },
          409,
        );
      invariant(
        context.received.status === 'PENDING',
        'TERMINAL_MESSAGE_RESOLVED',
        '消息已加入上下文或已处置，不能撤回或重复处置',
      );
      const resolution: TerminalInboxResolution = {
        kind: context.kind,
        note: note.trim(),
        at: now(),
        byRunId: context.actor.id,
        by: peer(context.actor),
      };
      const resolved = this.store.put<InboxMessage>(
        'inbox',
        {
          ...context.received,
          status: 'DISMISSED',
          resolution,
        },
        expectedMessageRevision,
      );
      const payload = { inboxId: resolved.id, revision: resolved.revision, resolution };
      this.kernel.event(context.recipient.id, 'terminal.message_resolved', payload);
      if (context.source && !context.source.archived)
        this.kernel.event(context.source.id, 'terminal.message_resolved', payload);
      return this.item(context.kind === 'withdrawn' ? context.message : resolved);
    });
  }

  /**
   * 分页列出同项目的其他终端；投影覆盖不完整时拒绝选择，防止隐藏不可读的可接收对象。
   * EN: Pages other same-project terminals; incomplete projections block selection rather than silently hiding unreadable recipients.
   */
  async peers(
    runId: string,
    query: z.infer<typeof pageQuery> & { query?: string },
  ): Promise<TerminalPeerPage> {
    const run = this.run(runId);
    if (!run.projectId) return { items: [], page: { total: 0, hasMore: false, nextBefore: null } };
    const projections = projectionReads(this.store);
    await projections.warm('runs');
    invariant(
      projections.coverage('runs').complete,
      'TERMINAL_PEERS_UNREADABLE',
      '部分终端记录无法读取，请在任务列表重试读取后再刷新通信',
    );
    const conditions = [
      "json_extract(data,'$.readModel.projectId')=?",
      "json_extract(data,'$.readModel.execution.kind')='docker-agent'",
      "json_extract(data,'$.readModel.kind')='task'",
      "COALESCE(json_extract(data,'$.archived'),0)=0",
      'id<>?',
    ];
    const values: (string | number)[] = [run.projectId, run.id];
    if (query.query?.trim()) {
      conditions.push(
        "(instr(lower(COALESCE(json_extract(data,'$.readModel.title'),'')),lower(?))>0 OR id=?)",
      );
      values.push(query.query.trim(), query.query.trim());
    }
    const where = conditions.join(' AND ');
    const total = Number(
      (this.store.db.prepare(`SELECT COUNT(*) n FROM runs WHERE ${where}`).get(...values) as { n: number }).n,
    );
    let boundary: number | undefined;
    if (query.before) {
      const row = this.store.db
        .prepare(`SELECT rowid position FROM runs WHERE id=? AND ${where}`)
        .get(query.before, ...values) as { position: number } | undefined;
      invariant(row, 'TERMINAL_CURSOR_MISSING', '终端列表已变化，请返回最新列表');
      boundary = row.position;
    }
    const rows = this.store.db
      .prepare(
        `SELECT id FROM runs WHERE ${where}${boundary === undefined ? '' : ' AND rowid<?'} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...values, ...(boundary === undefined ? [] : [boundary]), query.limit + 1) as { id: string }[];
    return {
      items: rows.slice(0, query.limit).map(({ id }) => {
        const target = this.run(id);
        return {
          ...peer(target),
          status: target.status,
          reason: target.reason,
          canReceive: !['DONE', 'CANCELLED'].includes(target.status),
        };
      }),
      page: {
        total,
        hasMore: rows.length > query.limit,
        nextBefore: rows.length > query.limit ? rows[query.limit - 1].id : null,
      },
    };
  }

  /**
   * 按持久 rowid 倒序分页；before 必须仍属于相同运行和过滤集合，否则要求回到最新。
   * EN: Pages by persistent rowid descending; before must still belong to the same run and filter or the caller must restart at latest.
   */
  messages(
    runId: string,
    query: z.infer<typeof pageQuery> & { pending?: 'true' },
  ): TerminalCommunicationPage {
    this.run(runId);
    const filter = query.pending ? " AND json_extract(data,'$.status')='PENDING'" : '';
    let boundary: number | undefined;
    if (query.before) {
      const row = this.store.db
        .prepare(`SELECT rowid position FROM inbox WHERE run_id=? AND id=?${filter}`)
        .get(runId, query.before) as { position: number } | undefined;
      invariant(row, 'TERMINAL_CURSOR_MISSING', '消息位置已变化，请返回最新记录');
      boundary = row.position;
    }
    const rows = this.store.db
      .prepare(
        `SELECT id FROM inbox WHERE run_id=?${filter}${boundary === undefined ? '' : ' AND rowid<?'} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(runId, ...(boundary === undefined ? [] : [boundary]), query.limit + 1) as { id: string }[];
    const items = rows
      .slice(0, query.limit)
      .map(({ id }) => this.item(this.store.require<InboxMessage>('inbox', id)));
    const total = Number(
      (
        this.store.db.prepare(`SELECT COUNT(*) n FROM inbox WHERE run_id=?${filter}`).get(runId) as {
          n: number;
        }
      ).n,
    );
    return {
      items,
      page: {
        total,
        hasMore: rows.length > query.limit,
        nextBefore: rows.length > query.limit ? rows[query.limit - 1].id : null,
      },
      pendingCount: this.pendingCount(runId),
    };
  }

  /**
   * 向同项目未结束的其他终端排队消息，写入收件与发件关联并发布双方事件。 只进入待处理箱，不注入正在运行的 stdin；接收者必须在后续显式续接中选择消费。
   * EN: Queues messages to other unfinished same-project terminals and persists inbox/sent linkage plus both events. Does not inject active stdin; the recipient explicitly selects messages on later continuation.
   */
  send(sourceId: string, targetId: string, text: string, expectedRevision: number) {
    const source = this.run(sourceId),
      target = this.run(targetId);
    invariant(source.id !== target.id, 'TERMINAL_SAME_TARGET', '请使用补充需求向当前终端发送消息');
    invariant(
      source.projectId && source.projectId === target.projectId,
      'TERMINAL_PROJECT_MISMATCH',
      '只能向同项目的终端转交消息',
    );
    invariant(
      !source.archived &&
        !target.archived &&
        !this.store.require<Project>('projects', source.projectId).archived,
      'ARCHIVED',
      '请先恢复归档的任务或项目',
    );
    invariant(
      expectedRevision >= 0 && expectedRevision <= source.revision,
      'REVISION_CONFLICT',
      '来源终端版本无效，请刷新后重试',
    );
    invariant(
      !['DONE', 'CANCELLED'].includes(target.status),
      'INVALID_STATE',
      '接收终端已结束，请选择其他终端',
    );
    const received = this.kernel.inbox(target.id, text, { source: peer(source) });
    const sent = this.store.put<InboxMessage>('inbox', {
      id: id(),
      revision: 0,
      runId: source.id,
      text,
      status: 'APPLIED',
      createdAt: now(),
      direction: 'outgoing',
      target: peer(target),
      targetInboxId: received.id,
    });
    this.kernel.updateRun(this.store.require<Run>('runs', source.id), {});
    this.kernel.event(source.id, 'terminal.message_sent', {
      id: sent.id,
      target: peer(target),
      targetInboxId: received.id,
    });
    this.kernel.event(target.id, 'terminal.message_received', { id: received.id, source: peer(source) });
    return {
      id: sent.id,
      targetInboxId: received.id,
      source: peer(source),
      target: peer(target),
      status: 'queued' as const,
    };
  }
}

/**
 * 注册同项目终端列表、消息和处置接口，写入先校验幂等命令、版本、可读性及可变性；消息只排队，不能自行驱动接收任务。
 * EN: Registers same-project peers/messages/dispositions with command, revision, readability and mutability checks before writes; queued messages do not independently drive recipients.
 */
export function registerTerminalCommunication(
  app: FastifyInstance,
  store: Store,
  kernel: Kernel<Store>,
  guard: { assertReadable: (runId: string) => void; assertMutable: (runId: string) => unknown },
) {
  const service = new TerminalCommunication(store, kernel);
  app.get<{ Params: { id: string } }>('/api/runs/:id/terminal/peers', (request) =>
    service.peers(
      request.params.id,
      pageQuery
        .extend({ query: z.string().max(200).optional() })
        .strict()
        .parse(request.query),
    ),
  );
  app.get<{ Params: { id: string } }>('/api/runs/:id/terminal/messages', (request) =>
    service.messages(
      request.params.id,
      pageQuery
        .extend({ pending: z.literal('true').optional() })
        .strict()
        .parse(request.query),
    ),
  );
  app.post<{ Params: { id: string } }>('/api/runs/:id/terminal/messages', (request) => {
    const body = Command.extend({
      expectedRevision: z.number().int().nonnegative(),
      targetRunId: z.string().uuid(),
      text: z.string().trim().min(1).max(20000),
    })
      .strict()
      .parse(request.body);
    const fingerprint = { route: request.url, body };
    if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
      return store.command(body.commandId, fingerprint, () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
    guard.assertReadable(request.params.id);
    guard.assertReadable(body.targetRunId);
    return store.command(body.commandId, fingerprint, () => {
      guard.assertMutable(request.params.id);
      guard.assertMutable(body.targetRunId);
      return service.send(request.params.id, body.targetRunId, body.text, body.expectedRevision);
    });
  });
  app.post<{ Params: { id: string; messageId: string } }>(
    '/api/runs/:id/terminal/messages/:messageId/resolve',
    (request) => {
      const body = Command.extend({
        expectedMessageRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        note: z.string().trim().min(1).max(2000),
      })
        .strict()
        .parse(request.body);
      const fingerprint = { route: request.url, body };
      if (store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId))
        return store.command(body.commandId, fingerprint, () => {
          throw new AppError('COMMAND_MISSING', '命令结果不存在');
        });
      guard.assertReadable(request.params.id);
      const context = service.resolutionContext(request.params.id, request.params.messageId);
      for (const runId of context.mutableRunIds) if (runId !== request.params.id) guard.assertReadable(runId);
      return store.command(body.commandId, fingerprint, () => {
        const current = service.resolutionContext(request.params.id, request.params.messageId);
        for (const runId of current.mutableRunIds) guard.assertMutable(runId);
        return service.resolve(
          request.params.id,
          request.params.messageId,
          body.expectedMessageRevision,
          body.note,
        );
      });
    },
  );
  return service;
}
