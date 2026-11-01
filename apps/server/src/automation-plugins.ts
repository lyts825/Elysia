/**
 * 装配项目事件插件及显式操作 API，不启动后台网络循环。
 * 订阅只保存 context 输入；模型路由只保存提案；回信在事务提交后派发并保留未知结果。
 * EN: Composes project event plugins and explicit APIs without background network loops.
 * Subscriptions only store context inputs, routers only store proposals, and replies dispatch after commit with uncertainty preserved.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invariant } from '../../../packages/contracts/src/index.js';
import {
  AUTOMATION_LIMITS,
  AutomationSourceConfiguration,
  AutomationSourceLease,
  AutomationSourceBatch,
  AutomationReplyRequest,
  AutomationPageQuery,
  AutomationDeliveryResult,
  AutomationRouteProposal,
  type AutomationSourceInstance,
  type AutomationOutboxMessage,
} from '../../../packages/contracts/src/automation-plugins.js';
import {
  AutomationPlugins,
  type AutomationPlugin,
  type AutomationAdapterContext,
} from '../../../packages/plugins/src/automation.js';
import { AutomationStore } from '../../../packages/storage/src/automation.js';
import type { Store } from '../../../packages/storage/src/index.js';

const leaseOf = (source: AutomationSourceInstance): AutomationSourceLease => ({
  id: source.id,
  projectId: source.projectId,
  revision: source.revision,
  authorityHash: source.authorityHash,
  source: source.source,
});
/** 深冻结传给可信适配器的副本，避免修改已捕获的配置和权限快照。
 * EN: Deep-freezes copied adapter inputs to prevent mutations of captured config and scope snapshots. */
function frozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown) => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const nested of Object.values(item)) freeze(nested);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}
type Flight = {
  projectId: string;
  sourceId: string;
  sourceRevision: number;
  messageId?: string;
  controller: AbortController;
  done: Promise<unknown>;
};
export interface AutomationServiceOptions {
  clock?: () => number;
  projectDrainMs?: number;
}

/** 项目来源的生命周期和显式适配器调用宿主；没有真实适配器时保持未配置。
 * EN: Hosts source lifecycle and explicit adapter calls; an empty registry remains visibly not configured. */
export class AutomationService {
  readonly repository: AutomationStore;
  readonly plugins: AutomationPlugins;
  private closed = false;
  private closing?: Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly flights = new Set<Flight>();
  private readonly projectSuspensions = new Map<string, Set<symbol>>();
  private readonly projectDrainMs: number;
  constructor(
    readonly store: Store,
    plugins: readonly AutomationPlugin[] = [],
    options: AutomationServiceOptions = {},
  ) {
    this.projectDrainMs = options.projectDrainMs ?? 5000;
    invariant(
      Number.isInteger(this.projectDrainMs) && this.projectDrainMs > 0 && this.projectDrainMs <= 30000,
      'AUTOMATION_DRAIN_LIMIT',
      '项目停止等待必须在 1 至 30000 毫秒之间',
    );
    this.plugins = new AutomationPlugins(plugins);
    this.repository = new AutomationStore(store, options.clock);
    this.repository.recoverSending();
  }
  private open(projectId?: string) {
    invariant(!this.closed, 'AUTOMATION_CLOSED', '事件插件宿主已关闭');
    invariant(
      !projectId || !this.projectSuspensions.has(projectId),
      'AUTOMATION_PROJECT_SUSPENDED',
      '项目事件插件正在停止，请等待当前生命周期操作结束',
    );
  }
  private outsideTransaction() {
    invariant(!this.store.db.isTransaction, 'AUTOMATION_TRANSACTION', '外部适配器调用必须在事务提交后执行');
  }
  private abortSource(source: AutomationSourceInstance) {
    const abort = () => {
      if (this.closed) return;
      try {
        if (this.repository.source(source.projectId, source.id).revision !== source.revision) return;
        for (const flight of this.flights)
          if (flight.sourceId === source.id && flight.sourceRevision !== source.revision)
            flight.controller.abort();
      } catch {
        /* A rolled-back source creation has no live binding to invalidate. */
      }
    };
    if (this.store.db.isTransaction) queueMicrotask(abort);
    else abort();
  }
  private track<T>(
    source: AutomationSourceInstance,
    work: (signal: AbortSignal) => Promise<T>,
    messageId?: string,
  ): Promise<T> {
    this.open(source.projectId);
    this.outsideTransaction();
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const flight: Flight = {
      projectId: source.projectId,
      sourceId: source.id,
      sourceRevision: source.revision,
      messageId,
      controller,
      done: Promise.resolve(),
    };
    const done = Promise.resolve().then(() => work(signal));
    flight.done = done;
    this.flights.add(flight);
    void done.then(
      () => this.flights.delete(flight),
      () => this.flights.delete(flight),
    );
    return done;
  }
  private context(source: AutomationSourceInstance, signal: AbortSignal): AutomationAdapterContext {
    this.outsideTransaction();
    return { source: frozen(source), config: frozen(this.repository.config(source)), signal };
  }
  /** 诊断只说明实际注册能力，不把接口预留显示成已连接平台。
   * EN: Diagnostics describe registered capabilities, never presenting reserved interfaces as connected platforms. */
  describe() {
    return { ...this.plugins.describe(), closed: this.closed, backgroundPolling: false as const };
  }
  configureSource(projectId: string, raw: AutomationSourceConfiguration) {
    this.open(projectId);
    const input = AutomationSourceConfiguration.parse(raw);
    const adapter = this.plugins.require('source', input.source);
    if (input.channel) this.plugins.require('channel', input.channel);
    if (input.router) this.plugins.require('router', input.router);
    const config = adapter.validateConfig(frozen(input.config));
    invariant(
      config && typeof config === 'object' && !Array.isArray(config) && !('then' in config),
      'PLUGIN_CONTRACT',
      '来源配置校验必须同步返回 JSON 对象',
    );
    const source = this.repository.configure(projectId, { ...input, config });
    this.abortSource(source);
    return source;
  }
  setSourceEnabled(projectId: string, sourceId: string, expectedRevision: number, enabled: boolean) {
    this.open(projectId);
    if (enabled) this.plugins.require('source', this.repository.source(projectId, sourceId).source);
    const before = this.repository.source(projectId, sourceId);
    const source = this.repository.setEnabled(projectId, sourceId, expectedRevision, enabled);
    if (source.revision !== before.revision) this.abortSource(source);
    return source;
  }
  /** 取得固定代次的入站句柄；来源配置或权限变化后旧句柄失效。
   * EN: Opens a generation-bound inbound handle, invalidated by any source config or scope change. */
  openSource(projectId: string, sourceId: string) {
    this.open(projectId);
    const source = this.repository.source(projectId, sourceId),
      lease = frozen(leaseOf(source));
    this.plugins.require('source', source.source);
    this.repository.current(lease);
    return { lease, receive: (batch: AutomationSourceBatch) => this.receive(lease, batch) };
  }
  /** 仅向已验证来源代次接收入站数据；HTTP 不公开此适配器信任入口。
   * EN: Accepts data only for a verified source generation; HTTP does not expose this trusted adapter entrypoint. */
  receive(lease: AutomationSourceLease, batch: AutomationSourceBatch) {
    this.open(lease.projectId);
    this.plugins.require('source', lease.source);
    return this.repository.receive(lease, batch);
  }
  /** 用户或宿主显式读取一次；没有轮询定时器。
   * EN: Performs one explicit user/host read without installing a polling timer. */
  poll(projectId: string, sourceId: string) {
    this.open(projectId);
    this.outsideTransaction();
    const source = this.repository.source(projectId, sourceId),
      lease = leaseOf(source);
    this.repository.current(lease);
    const adapter = this.plugins.require('source', source.source);
    return this.track(source, async (signal) => {
      this.open(projectId);
      this.repository.current(lease);
      signal.throwIfAborted();
      const result = await adapter.read(this.context(source, signal));
      this.open(projectId);
      signal.throwIfAborted();
      return this.receive(lease, AutomationSourceBatch.parse(result));
    });
  }
  subscribe(
    projectId: string,
    sourceId: string,
    expectedRevision: number,
    conversationId: string,
    runId: string,
  ) {
    this.open(projectId);
    const source = this.repository.source(projectId, sourceId);
    invariant(source.revision === expectedRevision, 'AUTOMATION_SOURCE_STALE', '来源修订已变化');
    return this.repository.subscribe(leaseOf(source), conversationId, runId);
  }
  unsubscribe(projectId: string, subscriptionId: string) {
    this.open(projectId);
    return this.repository.unsubscribe(projectId, subscriptionId);
  }
  observeInput(projectId: string, inputId: string) {
    this.open(projectId);
    return this.repository.observeInput(projectId, inputId);
  }
  /** 确定性订阅路由已在收件事务内完成；可选语义插件只能补充建议。
   * EN: Deterministic subscription routing happens during intake; optional semantic adapters can only add proposals. */
  route(projectId: string, candidateId: string) {
    this.open(projectId);
    this.outsideTransaction();
    const candidate = this.repository.candidate(projectId, candidateId),
      source = this.repository.current(candidate.source);
    if (!source.router) return Promise.resolve({ mode: 'deterministic' as const, candidate });
    const adapter = this.plugins.require('router', source.router);
    invariant(
      ['candidate', 'proposed'].includes(candidate.status),
      'AUTOMATION_CANDIDATE_STALE',
      '候选已失效',
    );
    return this.track(source, async (signal) => {
      this.open(projectId);
      this.repository.current(candidate.source);
      signal.throwIfAborted();
      const proposal = AutomationRouteProposal.parse(
        await adapter.propose({
          ...this.context(source, signal),
          candidate: frozen(candidate),
          event: frozen(this.repository.event(projectId, candidate.eventId).body),
        }),
      );
      this.open(projectId);
      signal.throwIfAborted();
      return {
        mode: 'proposal' as const,
        candidate: this.repository.propose(projectId, candidate.id, candidate.source, proposal),
      };
    });
  }
  enqueueReply(projectId: string, sourceId: string, input: AutomationReplyRequest) {
    this.open(projectId);
    const source = this.repository.source(projectId, sourceId);
    this.plugins.require('channel', source.channel);
    return this.repository.enqueueReply(projectId, sourceId, input);
  }
  cancelReply(projectId: string, messageId: string) {
    this.open(projectId);
    const result = this.repository.cancelReply(projectId, messageId);
    const abort = () => {
      if (this.closed) return;
      try {
        if (!this.repository.message(projectId, messageId).cancelRequested) return;
        for (const flight of this.flights) if (flight.messageId === messageId) flight.controller.abort();
      } catch {
        /* A rolled-back or removed message has no cancellation to deliver. */
      }
    };
    if (this.store.db.isTransaction) queueMicrotask(abort);
    else abort();
    return result;
  }
  retryReply(projectId: string, messageId: string) {
    this.open(projectId);
    return this.repository.retryReply(projectId, messageId);
  }
  private async send(message: AutomationOutboxMessage, signal: AbortSignal) {
    let outcome: AutomationDeliveryResult;
    let entered = false;
    try {
      this.open(message.source.projectId);
      signal.throwIfAborted();
      this.outsideTransaction();
      const source = this.repository.current(message.source),
        adapter = this.plugins.require('channel', source.channel);
      const current = this.repository.message(source.projectId, message.id);
      invariant(
        current.status === 'sending' && !current.cancelRequested,
        'AUTOMATION_REPLY_CANCELLED',
        '回信已撤销',
      );
      const context = {
        ...this.context(source, signal),
        message: frozen(message),
        text: this.store.readObject(message.messageRef, AUTOMATION_LIMITS.textChars * 4).toString('utf8'),
      };
      entered = true;
      outcome = AutomationDeliveryResult.parse(await adapter.send(context));
    } catch {
      outcome = entered
        ? { status: 'unknown', reason: '适配器未确认投递结果，请核验远端状态' }
        : { status: 'not-sent', retryable: false, reason: '发送前取消或来源绑定失效，未调用发送适配器' };
    }
    return this.repository.settle(message.source.projectId, message.id, outcome);
  }
  /** 显式派发有界回信；缺少适配器保持排队，事务内调用在任何外部工作前拒绝。
   * EN: Explicitly dispatches bounded replies; missing adapters keep messages queued, and transaction calls fail before external work. */
  async dispatch(projectId: string, limit = 10) {
    this.open(projectId);
    this.outsideTransaction();
    invariant(this.plugins.describe().channels.length > 0, 'AUTOMATION_NOT_CONFIGURED', '尚未配置回信适配器');
    let messages = this.repository.due(projectId, limit);
    const results: AutomationOutboxMessage[] = [],
      unavailable: { id: string; reason: 'not-configured' }[] = [];
    const examined = new Set<string>();
    while (examined.size < limit) {
      this.open(projectId);
      const message = messages.find((item) => !examined.has(item.id));
      if (!message) break;
      examined.add(message.id);
      const source = this.repository.source(projectId, message.source.id);
      if (!this.plugins.get('channel', source.channel)) {
        unavailable.push({ id: message.id, reason: 'not-configured' });
      } else {
        const claimed = this.repository.claimMessage(projectId, message.id);
        if (claimed)
          results.push(await this.track(source, (signal) => this.send(claimed, signal), claimed.id));
      }
      if (examined.size < limit) {
        if (
          this.closed ||
          this.projectSuspensions.has(projectId) ||
          this.repository.project(projectId).archived
        )
          break;
        this.open(projectId);
        messages = this.repository.due(projectId, limit);
      }
    }
    return { results, unavailable };
  }
  /** 仅显式查询未知回信的远端事实；旧凭据不用，改用当前仍获授权的来源绑定。
   * EN: Explicitly checks unknown replies using currently authorized source credentials, never stale credentials or a resend. */
  reconcile(projectId: string, messageId: string) {
    this.open(projectId);
    this.outsideTransaction();
    const message = this.repository.message(projectId, messageId);
    invariant(message.status === 'unknown', 'AUTOMATION_REPLY_STATE', '仅未知投递需要远端核验');
    invariant(
      ![...this.flights].some((item) => item.messageId === messageId),
      'AUTOMATION_REPLY_ACTIVE',
      '原发送仍在途，请等待其结束',
    );
    const source = this.repository.source(projectId, message.source.id);
    this.repository.current(leaseOf(source));
    invariant(
      source.scope.reply && source.scope.conversationIds.includes(message.conversationId),
      'AUTOMATION_SCOPE',
      '当前来源无权核验此会话',
    );
    const adapter = this.plugins.require('channel', source.channel);
    invariant(adapter.reconcile, 'AUTOMATION_NOT_CONFIGURED', '回信适配器未提供远端核验接口');
    return this.track(
      source,
      async (signal) => {
        let outcome: AutomationDeliveryResult;
        try {
          this.open(projectId);
          this.repository.current(leaseOf(source));
          signal.throwIfAborted();
          outcome = AutomationDeliveryResult.parse(
            await adapter.reconcile!({ ...this.context(source, signal), message: frozen(message) }),
          );
        } catch {
          outcome = { status: 'unknown', reason: '远端核验未得到确定结果' };
        }
        return this.repository.settle(projectId, messageId, outcome, true);
      },
      messageId,
    );
  }
  sources(projectId: string, page?: Partial<AutomationPageQuery>) {
    return this.repository.sources(projectId, page);
  }
  events(projectId: string, page?: Partial<AutomationPageQuery>) {
    return this.repository.events(projectId, page);
  }
  event(projectId: string, eventId: string) {
    return this.repository.event(projectId, eventId);
  }
  candidates(projectId: string, page?: Partial<AutomationPageQuery>) {
    return this.repository.candidates(projectId, page);
  }
  subscriptions(projectId: string, page?: Partial<AutomationPageQuery>) {
    return this.repository.subscriptions(projectId, page);
  }
  inputs(projectId: string, runId: string, page?: Partial<AutomationPageQuery>) {
    return this.repository.inputs(projectId, runId, page);
  }
  outbox(projectId: string, page?: Partial<AutomationPageQuery>) {
    return this.repository.outbox(projectId, page);
  }
  /** 暂停项目入口并中止、等待其在途调用；可在归档提交后调用，超时不丢弃未结算记录。
   * EN: Gates project entrypoints, aborts and drains calls after archive; timeout preserves unsettled records. */
  async suspendProject(projectId: string): Promise<() => void> {
    this.open();
    this.outsideTransaction();
    this.repository.project(projectId);
    const token = Symbol(projectId),
      tokens = this.projectSuspensions.get(projectId) ?? new Set<symbol>();
    tokens.add(token);
    this.projectSuspensions.set(projectId, tokens);
    const release = () => {
      tokens.delete(token);
      if (!tokens.size && this.projectSuspensions.get(projectId) === tokens)
        this.projectSuspensions.delete(projectId);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const flights = [...this.flights].filter((flight) => flight.projectId === projectId);
      for (const flight of flights) flight.controller.abort();
      const drained = await Promise.race([
        Promise.allSettled(flights.map((flight) => flight.done)).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.projectDrainMs);
        }),
      ]);
      invariant(
        drained,
        'AUTOMATION_PROJECT_BUSY',
        '项目仍有未收束的适配器调用，已保留回信记录；请等待结束并核验远端结果后重试',
      );
      return release;
    } catch (error) {
      release();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** 删除事务内再次检查；持有项目门禁且远端结果已确定时才允许删除持久账据。
   * EN: Rechecks inside the delete transaction; project gating and known remote outcomes are required. */
  assertProjectDeletable(projectId: string) {
    invariant(
      this.projectSuspensions.has(projectId),
      'AUTOMATION_PROJECT_NOT_SUSPENDED',
      '删除项目之前必须先停止项目事件插件',
    );
    invariant(
      ![...this.flights].some((flight) => flight.projectId === projectId),
      'AUTOMATION_PROJECT_BUSY',
      '项目仍有未收束的适配器调用，不能删除其记录',
    );
    this.repository.assertProjectDeletable(projectId);
  }
  /** 先禁止新输入并取消适配器请求，再等待已启动调用结算；适配器必须响应 signal。
   * EN: Rejects new inputs, aborts adapter requests, then drains started calls; adapters must honor signal. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifetime.abort();
    this.closing = Promise.allSettled([...this.flights].map((flight) => flight.done)).then(() => undefined);
    return this.closing;
  }
}

/** 默认空注册，不启动后台监听、轮询或真实外部连接。
 * EN: Defaults to an empty registry without listeners, polling or external connections. */
export function createAutomationPlugins(
  store: Store,
  plugins: readonly AutomationPlugin[] = [],
  options: AutomationServiceOptions = {},
) {
  return new AutomationService(store, plugins, options);
}

/** 在已装配会话认证的原生 Fastify 作用域注册接口；变更还经过项目可变性守卫。
 * EN: Registers inside the authenticated native Fastify scope, with additional project-mutability guards for changes. */
export function registerAutomationPluginRoutes(
  app: FastifyInstance,
  service: AutomationService,
  assertMutable: (runId: string | null, projectId?: string) => void,
) {
  const params = z.object({ id: z.string().uuid() }).passthrough();
  const sourceParams = params.extend({ sourceId: z.string().uuid() });
  const recordParams = params.extend({ recordId: z.string().regex(/^[a-f0-9]{64}$/) });
  const command = z.object({ commandId: z.string().uuid() }).strict();
  const mutable = (projectId: string) => {
    service.repository.project(projectId, true);
    assertMutable(null, projectId);
  };
  const runCommand = <T>(projectId: string, commandId: string, payload: unknown, work: () => T) =>
    service.store.command(`automation:${projectId}:${commandId}`, payload, work);
  app.get('/api/automation/plugins', () => service.describe());
  for (const kind of ['sources', 'events', 'candidates', 'subscriptions', 'outbox'] as const) {
    app.get(`/api/projects/:id/automation/${kind}`, (request) =>
      service[kind](params.parse(request.params).id, AutomationPageQuery.parse(request.query)),
    );
  }
  app.get('/api/projects/:id/automation/events/:recordId', (request) => {
    const p = recordParams.parse(request.params);
    return service.event(p.id, p.recordId);
  });
  app.get('/api/projects/:id/automation/runs/:runId/inputs', (request) => {
    const p = params.extend({ runId: z.string().uuid() }).parse(request.params);
    return service.inputs(p.id, p.runId, AutomationPageQuery.parse(request.query));
  });
  app.post('/api/projects/:id/automation/sources', (request) => {
    const p = params.parse(request.params),
      body = AutomationSourceConfiguration.extend({ commandId: z.string().uuid() })
        .strict()
        .parse(request.body);
    mutable(p.id);
    const { commandId, ...configuration } = body;
    return runCommand(p.id, commandId, { kind: 'configure', configuration }, () =>
      service.configureSource(p.id, configuration),
    );
  });
  app.put('/api/projects/:id/automation/sources/:sourceId/enabled', (request) => {
    const p = sourceParams.parse(request.params),
      body = command
        .extend({ expectedRevision: z.number().int().positive(), enabled: z.boolean() })
        .strict()
        .parse(request.body);
    mutable(p.id);
    return runCommand(p.id, body.commandId, { kind: 'enabled', sourceId: p.sourceId, ...body }, () =>
      service.setSourceEnabled(p.id, p.sourceId, body.expectedRevision, body.enabled),
    );
  });
  app.post('/api/projects/:id/automation/sources/:sourceId/poll', (request) => {
    const p = sourceParams.parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    mutable(p.id);
    return service.poll(p.id, p.sourceId);
  });
  app.post('/api/projects/:id/automation/sources/:sourceId/subscriptions', (request) => {
    const p = sourceParams.parse(request.params),
      body = command
        .extend({
          expectedRevision: z.number().int().positive(),
          conversationId: z.string().min(1).max(512),
          runId: z.string().uuid(),
        })
        .strict()
        .parse(request.body);
    mutable(p.id);
    return runCommand(p.id, body.commandId, { kind: 'subscribe', sourceId: p.sourceId, ...body }, () =>
      service.subscribe(p.id, p.sourceId, body.expectedRevision, body.conversationId, body.runId),
    );
  });
  app.post('/api/projects/:id/automation/subscriptions/:recordId/unsubscribe', (request) => {
    const p = recordParams.parse(request.params),
      body = command.parse(request.body);
    mutable(p.id);
    return runCommand(p.id, body.commandId, { kind: 'unsubscribe', id: p.recordId }, () =>
      service.unsubscribe(p.id, p.recordId),
    );
  });
  app.post('/api/projects/:id/automation/inputs/:recordId/observe', (request) => {
    const p = recordParams.parse(request.params),
      body = command.parse(request.body);
    mutable(p.id);
    return runCommand(p.id, body.commandId, { kind: 'observe', id: p.recordId }, () =>
      service.observeInput(p.id, p.recordId),
    );
  });
  app.post('/api/projects/:id/automation/candidates/:recordId/route', (request) => {
    const p = recordParams.parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    mutable(p.id);
    return service.route(p.id, p.recordId);
  });
  app.post('/api/projects/:id/automation/sources/:sourceId/replies', (request) => {
    const p = sourceParams.parse(request.params),
      body = AutomationReplyRequest.extend({ commandId: z.string().uuid() }).strict().parse(request.body);
    mutable(p.id);
    const { commandId, ...input } = body;
    return runCommand(p.id, commandId, { kind: 'reply', sourceId: p.sourceId, input }, () =>
      service.enqueueReply(p.id, p.sourceId, input),
    );
  });
  app.post('/api/projects/:id/automation/outbox/dispatch', (request) => {
    const p = params.parse(request.params),
      body = z
        .object({ limit: z.number().int().min(1).max(AUTOMATION_LIMITS.dispatch).default(10) })
        .strict()
        .parse(request.body ?? {});
    mutable(p.id);
    return service.dispatch(p.id, body.limit);
  });
  for (const action of ['cancel', 'retry'] as const)
    app.post(`/api/projects/:id/automation/outbox/:recordId/${action}`, (request) => {
      const p = recordParams.parse(request.params),
        body = command.parse(request.body);
      mutable(p.id);
      return runCommand(p.id, body.commandId, { kind: action, id: p.recordId }, () =>
        action === 'cancel' ? service.cancelReply(p.id, p.recordId) : service.retryReply(p.id, p.recordId),
      );
    });
  app.post('/api/projects/:id/automation/outbox/:recordId/reconcile', (request) => {
    const p = recordParams.parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    mutable(p.id);
    return service.reconcile(p.id, p.recordId);
  });
}
