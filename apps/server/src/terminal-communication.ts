import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  Command,
  invariant,
  type Project,
  type Run,
} from '../../../packages/contracts/src/index.js';
import type { InboxMessage } from '../../../packages/contracts/src/terminal-inbox.js';
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
const peer = (run: Run): TerminalPeer => ({
  runId: run.id,
  title: (run.title || run.objective).slice(0, 240),
  agent: run.execution?.kind === 'docker-agent' ? run.execution.profile.agent : '',
});

export class TerminalCommunication {
  constructor(
    private store: Store,
    private kernel: Kernel,
  ) {}

  run(runId: string) {
    const run = this.store.require<Run>('runs', runId);
    invariant(
      run.execution?.kind === 'docker-agent' && run.kind === 'task',
      'TERMINAL_REQUIRED',
      '请选择终端任务',
    );
    return run;
  }

  pendingCount(runId: string) {
    return Number(
      (
        this.store.db
          .prepare("SELECT COUNT(*) n FROM inbox WHERE run_id=? AND json_extract(data,'$.status')='PENDING'")
          .get(runId) as { n: number }
      ).n,
    );
  }

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
    const items = rows.slice(0, query.limit).map(({ id }): TerminalCommunicationItem => {
      const item = this.store.require<InboxMessage>('inbox', id);
      const outgoing = item.direction === 'outgoing';
      const other = outgoing ? item.target : item.source;
      const available = other ? this.store.get<Run>('runs', other.runId) : undefined;
      const received =
        outgoing && item.targetInboxId ? this.store.get<InboxMessage>('inbox', item.targetInboxId) : item;
      return {
        id: item.id,
        direction: outgoing ? 'outgoing' : 'incoming',
        text: item.text,
        createdAt: item.createdAt,
        ...(other ? { peer: { ...other, agent: other.agent ?? '', available: !!available } } : {}),
        status:
          !received || (outgoing && received.runId !== other?.runId)
            ? 'unavailable'
            : received.status === 'PENDING'
              ? 'queued'
              : 'included',
        ...(received?.operationId ? { operationId: received.operationId } : {}),
      };
    });
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

export function registerTerminalCommunication(
  app: FastifyInstance,
  store: Store,
  kernel: Kernel,
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
  return service;
}
