/**
 * 持久保存项目来源、不可变入站事件、订阅、候选和回信。
 * 同步事务内只写状态；外部发送留给宿主在提交后显式派发。
 * EN: Persists project sources, immutable inbound events, subscriptions, candidates and replies.
 * Synchronous transactions only change state; the host explicitly dispatches external sends after commit.
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError, invariant, type Project, type Run } from '../../contracts/src/index.js';
import {
  AUTOMATION_LIMITS,
  AutomationSourceInstance,
  AutomationSourceLease,
  AutomationSourceConfiguration,
  AutomationSourceBatch,
  AutomationStoredEvent,
  AutomationSubscription,
  AutomationCandidate,
  AutomationContextInput,
  AutomationOutboxMessage,
  AutomationReplyRequest,
  AutomationPageQuery,
  AutomationRouteProposal,
  AutomationDeliveryResult,
  AutomationIncomingEvent,
  type AutomationPage,
} from '../../contracts/src/automation-plugins.js';
import { hash, id, stable } from '../../contracts/src/identity.js';
import type { Store } from './index.js';

/** 清理按子表到父表排列；对象列供对象回收、备份和完整性检查复用。
 * EN: Tables are ordered child-first for maintenance; object columns are shared with GC, backup and integrity checks. */
export const AUTOMATION_TABLES = [
  'automation_inputs_v1',
  'automation_candidates_v1',
  'automation_outbox_v1',
  'automation_subscriptions_v1',
  'automation_events_v1',
  'automation_source_versions_v1',
  'automation_sources_v1',
] as const;
export const AUTOMATION_OBJECT_COLUMNS = [
  { table: 'automation_sources_v1', key: 'id', column: 'config_ref' },
  { table: 'automation_source_versions_v1', key: 'id', column: 'config_ref' },
  { table: 'automation_events_v1', key: 'id', column: 'body_ref' },
  { table: 'automation_outbox_v1', key: 'id', column: 'message_ref' },
] as const;

/** 回收前同时核对权威记录与对象列；不一致时保留对象并停止清理。 */
export function* automationObjectReferences(db: DatabaseSync): Generator<string> {
  for (const { table, column } of AUTOMATION_OBJECT_COLUMNS) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const field = column === 'config_ref' ? 'configRef' : column === 'body_ref' ? 'bodyRef' : 'messageRef';
    for (const row of db.prepare(`SELECT ${column} ref,data FROM ${table}`).iterate() as Iterable<{
      ref: string;
      data: string;
    }>) {
      invariant(
        typeof row.data === 'string' && Buffer.byteLength(row.data) <= 1024 * 1024,
        'AUTOMATION_CORRUPT',
        '来源插件引用记录超过上限或无法读取，已停止清理',
      );
      const value = JSON.parse(row.data);
      invariant(
        typeof row.ref === 'string' &&
          /^(?:sqlite:[a-f0-9]{64}|objects[\\/][a-f0-9]{2}[\\/][a-f0-9]{64})$/.test(row.ref) &&
          value?.[field] === row.ref,
        'AUTOMATION_CORRUPT',
        '来源插件对象列与记录不一致，已停止清理',
      );
      yield row.ref;
    }
  }
}

/** 创建独立版本表；调用方可在统一迁移事务中调用，函数本身不打开外部连接。
 * EN: Creates versioned tables; callers may include it in their migration transaction, without external connections. */
export function initializeAutomationSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_sources_v1(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,config_ref TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS automation_sources_project_v1 ON automation_sources_v1(project_id,seq);
    CREATE TABLE IF NOT EXISTS automation_source_versions_v1(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES automation_sources_v1(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,config_ref TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(source_id,revision));
    CREATE TABLE IF NOT EXISTS automation_events_v1(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES automation_sources_v1(id) ON DELETE CASCADE,
      source_revision INTEGER NOT NULL,event_id TEXT NOT NULL,event_revision TEXT NOT NULL,
      conversation_id TEXT NOT NULL,body_ref TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(source_id,event_id,event_revision));
    CREATE INDEX IF NOT EXISTS automation_events_project_v1 ON automation_events_v1(project_id,seq);
    CREATE TABLE IF NOT EXISTS automation_subscriptions_v1(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES automation_sources_v1(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      source_revision INTEGER NOT NULL,active INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(source_id,conversation_id,run_id));
    CREATE INDEX IF NOT EXISTS automation_subscriptions_route_v1 ON automation_subscriptions_v1(source_id,conversation_id,active);
    CREATE TABLE IF NOT EXISTS automation_inputs_v1(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES automation_sources_v1(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES automation_events_v1(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,status TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(event_id,run_id));
    CREATE INDEX IF NOT EXISTS automation_inputs_run_v1 ON automation_inputs_v1(project_id,run_id,seq);
    CREATE TABLE IF NOT EXISTS automation_candidates_v1(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES automation_sources_v1(id) ON DELETE CASCADE,
      event_id TEXT UNIQUE NOT NULL REFERENCES automation_events_v1(id) ON DELETE CASCADE,
      status TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS automation_candidates_project_v1 ON automation_candidates_v1(project_id,seq);
    CREATE TABLE IF NOT EXISTS automation_outbox_v1(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES automation_sources_v1(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,source_revision INTEGER NOT NULL,status TEXT NOT NULL,
      due_at INTEGER NOT NULL,message_ref TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS automation_outbox_due_v1 ON automation_outbox_v1(project_id,status,due_at,seq);
    CREATE INDEX IF NOT EXISTS automation_outbox_order_v1 ON automation_outbox_v1(source_id,conversation_id,seq);
  `);
}

type JsonRow = { data: string; seq: number };
type ListTable = (typeof AUTOMATION_TABLES)[number];
const sourceLease = (source: AutomationSourceInstance): AutomationSourceLease => ({
  id: source.id,
  projectId: source.projectId,
  revision: source.revision,
  authorityHash: source.authorityHash,
  source: source.source,
});
const bodyText = (value: unknown, limit: number) => {
  let text: string;
  try {
    text = stable(value);
  } catch {
    throw new AppError('AUTOMATION_PAYLOAD', '内容必须是可序列化 JSON');
  }
  invariant(Buffer.byteLength(text, 'utf8') <= limit, 'AUTOMATION_SIZE', '自动化内容超过大小上限');
  return text;
};

/** 项目隔离的同步仓储；每次变更重新读取来源修订和所属关系。
 * EN: A project-isolated synchronous repository rechecking source revision and ownership at every mutation. */
export class AutomationStore {
  constructor(
    readonly store: Store,
    private readonly clock: () => number = Date.now,
  ) {
    initializeAutomationSchema(store.db);
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private parse<T>(schema: z.ZodType<T>, row: unknown): T {
    invariant(row, 'AUTOMATION_NOT_FOUND', '自动化记录不存在或不属于此项目');
    try {
      const record = row as Record<string, unknown>,
        value = schema.parse(JSON.parse((row as JsonRow).data));
      const data = value as Record<string, any>;
      const expected: Record<string, unknown> = {
        id: data.id,
        project_id: data.projectId ?? data.source?.projectId,
        config_ref: data.configRef,
        body_ref: data.bodyRef,
        message_ref: data.messageRef,
        revision: data.revision,
        source_id: typeof data.source === 'object' ? data.source.id : undefined,
        source_revision: data.source?.revision,
        run_id: data.runId,
        conversation_id: data.conversationId,
        status: data.status,
      };
      for (const [column, field] of Object.entries(expected))
        if (column in record && record[column] !== field)
          throw new Error('Projection does not match its record');
      return value;
    } catch {
      throw new AppError('AUTOMATION_RECORD_INVALID', '自动化记录无法读取，请保留原始数据并核验');
    }
  }
  /** 读取已有项目；写入拒绝归档项目，不因调用参数创造项目权限。
   * EN: Reads an existing project; writes reject archived projects and never create authority from caller parameters. */
  project(projectId: string, mutable = false) {
    const project = this.store.require<Project>('projects', z.string().uuid().parse(projectId));
    invariant(!mutable || !project.archived, 'PROJECT_ARCHIVED', '项目已归档');
    return project;
  }
  /** 来源必须已持久绑定指定项目。
   * EN: The source must already be durably bound to the requested project. */
  source(projectId: string, sourceId: string): AutomationSourceInstance {
    this.project(projectId);
    return this.parse(
      AutomationSourceInstance,
      this.store.db
        .prepare('SELECT * FROM automation_sources_v1 WHERE project_id=? AND id=?')
        .get(projectId, sourceId),
    );
  }
  /** 读取非敏感配置对象；旧配置对象留在版本表中供审计。
   * EN: Reads a non-secret config object; prior configs remain referenced by version history. */
  config(source: AutomationSourceInstance): Record<string, unknown> {
    return z
      .record(z.string(), z.unknown())
      .parse(
        JSON.parse(this.store.readObject(source.configRef, AUTOMATION_LIMITS.configBytes).toString('utf8')),
      );
  }
  /** 校验来源租约、项目、启用状态及修订，旧绑定不能接收或发出新工作。
   * EN: Checks lease, project, enabled state and revision; stale bindings cannot receive or send new work. */
  current(lease: AutomationSourceLease) {
    const checked = AutomationSourceLease.parse(lease),
      source = this.source(checked.projectId, checked.id);
    this.project(source.projectId, true);
    invariant(
      source.revision === checked.revision &&
        source.authorityHash === checked.authorityHash &&
        source.source === checked.source,
      'AUTOMATION_SOURCE_STALE',
      '来源配置或权限已变化，请重新取得绑定',
    );
    invariant(source.enabled, 'AUTOMATION_SOURCE_DISABLED', '来源已禁用');
    return source;
  }
  private allowed(source: AutomationSourceInstance, conversation: string, action: 'receive' | 'reply') {
    invariant(
      source.scope[action] && source.scope.conversationIds.includes(conversation),
      'AUTOMATION_SCOPE',
      '来源未获此会话操作授权',
    );
  }
  private replaceSource(source: AutomationSourceInstance) {
    source = AutomationSourceInstance.parse(source);
    const encoded = stable(source);
    this.store.db
      .prepare(
        `INSERT INTO automation_sources_v1(id,project_id,revision,config_ref,data) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config_ref=excluded.config_ref,data=excluded.data`,
      )
      .run(source.id, source.projectId, source.revision, source.configRef, encoded);
    this.store.db
      .prepare(
        'INSERT INTO automation_source_versions_v1(id,project_id,source_id,revision,config_ref,data) VALUES(?,?,?,?,?,?)',
      )
      .run(
        hash(`${source.id}:${source.revision}`),
        source.projectId,
        source.id,
        source.revision,
        source.configRef,
        encoded,
      );
    this.store.db
      .prepare(
        "UPDATE automation_subscriptions_v1 SET active=0,data=json_set(data,'$.active',json('false')) WHERE source_id=? AND source_revision<>?",
      )
      .run(source.id, source.revision);
    this.store.db
      .prepare(
        "UPDATE automation_inputs_v1 SET status='stale',data=json_set(data,'$.status','stale') WHERE source_id=? AND status='pending'",
      )
      .run(source.id);
    this.store.db
      .prepare(
        "UPDATE automation_candidates_v1 SET status='stale',data=json_set(data,'$.status','stale') WHERE source_id=? AND status IN ('candidate','proposed')",
      )
      .run(source.id);
    this.store.db
      .prepare(
        `UPDATE automation_outbox_v1 SET
      status=CASE WHEN status IN ('sending','unknown') THEN 'unknown' ELSE 'cancelled' END,
      data=json_set(data,'$.status',CASE WHEN status IN ('sending','unknown') THEN 'unknown' ELSE 'cancelled' END,
        '$.lastOutcome',CASE WHEN status IN ('sending','unknown') THEN 'unknown' ELSE json_extract(data,'$.lastOutcome') END,
        '$.cancelRequested',json('true'),'$.reason','来源配置、启用状态或权限已变化','$.updatedAt',?)
      WHERE source_id=? AND source_revision<>? AND status IN ('pending','retry','sending','unknown')`,
      )
      .run(this.now(), source.id, source.revision);
    return source;
  }
  /** 原子冻结配置与权限快照；配置更新重置游标并撤销旧订阅和未发送回信。
   * EN: Atomically freezes config/scope; updates reset the cursor and invalidate prior subscriptions and unsent replies. */
  configure(projectId: string, raw: AutomationSourceConfiguration) {
    const input = AutomationSourceConfiguration.parse(raw),
      config = bodyText(input.config, AUTOMATION_LIMITS.configBytes);
    return this.store.tx(() => {
      this.project(projectId, true);
      const before = input.id ? this.source(projectId, input.id) : undefined;
      invariant(
        before ? input.expectedRevision === before.revision : input.expectedRevision === undefined,
        'REVISION_CONFLICT',
        '来源修订已变化',
      );
      invariant(
        !before || before.source === input.source,
        'AUTOMATION_SOURCE_KIND',
        '更换来源类型需要创建新实例',
      );
      if (!before) {
        const count = this.store.db
          .prepare('SELECT COUNT(*) AS n FROM automation_sources_v1 WHERE project_id=?')
          .get(projectId) as { n: number };
        invariant(count.n < AUTOMATION_LIMITS.sources, 'AUTOMATION_SOURCE_LIMIT', '项目来源实例已达上限');
      }
      const revision = (before?.revision ?? 0) + 1,
        sourceId = before?.id ?? id();
      const configRef = this.store.object(config).objectRef;
      const source: AutomationSourceInstance = {
        id: sourceId,
        projectId,
        revision,
        title: input.title,
        source: input.source,
        channel: input.channel,
        router: input.router,
        credentialBinding: input.credentialBinding,
        scope: input.scope,
        enabled: input.enabled,
        configRef,
        authorityHash: hash(
          stable({
            projectId,
            sourceId,
            revision,
            configRef,
            ...input,
            id: undefined,
            expectedRevision: undefined,
          }),
        ),
        cursor: null,
        createdAt: before?.createdAt ?? this.now(),
        updatedAt: this.now(),
      };
      return this.replaceSource(source);
    });
  }
  /** 启用或禁用也更换权限代次，重新启用不恢复旧订阅和待发送回信。
   * EN: Enable/disable changes the authority generation; reenabling never restores old subscriptions or unsent replies. */
  setEnabled(projectId: string, sourceId: string, expectedRevision: number, enabled: boolean) {
    return this.store.tx(() => {
      this.project(projectId, true);
      const source = this.source(projectId, sourceId);
      invariant(source.revision === expectedRevision, 'REVISION_CONFLICT', '来源修订已变化');
      if (source.enabled === enabled) return source;
      return this.replaceSource({
        ...source,
        enabled,
        revision: source.revision + 1,
        authorityHash: hash(
          stable({ previous: source.authorityHash, revision: source.revision + 1, enabled }),
        ),
        updatedAt: this.now(),
      });
    });
  }
  private page<T>(
    projectId: string,
    table: ListTable,
    schema: z.ZodType<T>,
    raw: Partial<AutomationPageQuery> = {},
    extra = '',
    values: (string | number)[] = [],
  ): AutomationPage<T> {
    this.project(projectId);
    const query = AutomationPageQuery.parse(raw);
    const rows = this.store.db
      .prepare(`SELECT * FROM ${table} WHERE project_id=? AND seq>? ${extra} ORDER BY seq LIMIT ?`)
      .all(projectId, query.after, ...values, query.limit + 1) as unknown as JsonRow[];
    return {
      items: rows.slice(0, query.limit).map((row) => this.parse(schema, row)),
      nextAfter: rows.length > query.limit ? Number(rows[query.limit - 1].seq) : null,
    };
  }
  sources(projectId: string, page: Partial<AutomationPageQuery> = {}) {
    return this.page(projectId, 'automation_sources_v1', AutomationSourceInstance, page);
  }
  events(projectId: string, page: Partial<AutomationPageQuery> = {}) {
    return this.page(projectId, 'automation_events_v1', AutomationStoredEvent, page);
  }
  candidates(projectId: string, page: Partial<AutomationPageQuery> = {}) {
    return this.page(projectId, 'automation_candidates_v1', AutomationCandidate, page);
  }
  subscriptions(projectId: string, page: Partial<AutomationPageQuery> = {}) {
    return this.page(projectId, 'automation_subscriptions_v1', AutomationSubscription, page);
  }
  outbox(projectId: string, page: Partial<AutomationPageQuery> = {}) {
    return this.page(projectId, 'automation_outbox_v1', AutomationOutboxMessage, page);
  }
  /** 上下文输入的已观察状态只表示宿主取用，不证明模型读过或执行过。
   * EN: Observed context inputs only prove host consumption, not model reading or execution. */
  inputs(projectId: string, runId: string, page: Partial<AutomationPageQuery> = {}) {
    this.run(projectId, runId);
    return this.page(projectId, 'automation_inputs_v1', AutomationContextInput, page, 'AND run_id=?', [
      runId,
    ]);
  }
  private run(projectId: string, runId: string, active = false) {
    const run = this.store.require<Run>('runs', z.string().uuid().parse(runId));
    invariant(
      run.projectId === projectId && run.kind === 'task',
      'AUTOMATION_RUN_SCOPE',
      '运行不属于此来源项目',
    );
    invariant(
      !active || (!run.archived && !['DONE', 'CANCELLED'].includes(run.status)),
      'AUTOMATION_RUN_ENDED',
      '运行已结束或归档',
    );
    return run;
  }
  /** 显式建立同项目会话订阅；来源权限仅允许传递 context，不恢复或扩权运行。
   * EN: Explicitly binds a same-project conversation for context only, without resuming or authorizing a run. */
  subscribe(lease: AutomationSourceLease, conversationId: string, runId: string) {
    return this.store.tx(() => {
      const source = this.current(lease);
      this.allowed(source, conversationId, 'receive');
      this.run(source.projectId, runId, true);
      const key = hash(stable([source.id, conversationId, runId]));
      const count = this.store.db
        .prepare(
          'SELECT COUNT(*) AS n FROM automation_subscriptions_v1 WHERE source_id=? AND active=1 AND id<>?',
        )
        .get(source.id, key) as { n: number };
      invariant(
        count.n < AUTOMATION_LIMITS.subscriptions,
        'AUTOMATION_SUBSCRIPTION_LIMIT',
        '来源订阅已达上限',
      );
      const subscription: AutomationSubscription = {
        id: key,
        source: sourceLease(source),
        conversationId,
        runId,
        active: true,
        createdAt: this.now(),
      };
      this.store.db
        .prepare(
          `INSERT INTO automation_subscriptions_v1(id,project_id,source_id,conversation_id,run_id,source_revision,active,data)
        VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET source_revision=excluded.source_revision,active=1,data=excluded.data`,
        )
        .run(key, source.projectId, source.id, conversationId, runId, source.revision, stable(subscription));
      return subscription;
    });
  }
  unsubscribe(projectId: string, subscriptionId: string) {
    return this.store.tx(() => {
      this.project(projectId, true);
      const record = this.parse(
        AutomationSubscription,
        this.store.db
          .prepare('SELECT * FROM automation_subscriptions_v1 WHERE project_id=? AND id=?')
          .get(projectId, subscriptionId),
      );
      const next = { ...record, active: false };
      this.store.db
        .prepare('UPDATE automation_subscriptions_v1 SET active=0,data=? WHERE id=?')
        .run(stable(next), record.id);
      return next;
    });
  }
  /** 原子接收、去重、订阅投递、生成候选并更新游标；同身份不同内容整批拒绝。
   * EN: Atomically receives/deduplicates, fans out context or creates candidates, and advances the cursor; identity/content conflicts reject the batch. */
  receive(lease: AutomationSourceLease, raw: AutomationSourceBatch) {
    const batch = AutomationSourceBatch.parse(raw);
    bodyText(batch, AUTOMATION_LIMITS.batchBytes);
    return this.store.tx(() => {
      const source = this.current(lease);
      invariant(source.scope.receive, 'AUTOMATION_SCOPE', '来源未获收件授权');
      invariant(
        batch.expectedCursor === source.cursor,
        'AUTOMATION_CURSOR_CONFLICT',
        '来源游标已变化，请重新读取',
      );
      const received: { id: string; duplicate: boolean; inputs: number; candidate: boolean }[] = [];
      for (const incoming of batch.events) {
        this.allowed(source, incoming.conversationId, 'receive');
        const content = bodyText(incoming, AUTOMATION_LIMITS.eventBytes),
          bodyHash = hash(content);
        const key = hash(stable([source.id, incoming.eventId, incoming.revision]));
        const row = this.store.db.prepare('SELECT * FROM automation_events_v1 WHERE id=?').get(key);
        if (row) {
          invariant(
            this.parse(AutomationStoredEvent, row).bodyHash === bodyHash,
            'AUTOMATION_EVENT_CONFLICT',
            '同一事件修订包含不同内容',
          );
          received.push({ id: key, duplicate: true, inputs: 0, candidate: false });
          continue;
        }
        const event: AutomationStoredEvent = {
          id: key,
          source: sourceLease(source),
          eventId: incoming.eventId,
          eventRevision: incoming.revision,
          conversationId: incoming.conversationId,
          actor: incoming.actor,
          occurredAt: incoming.occurredAt,
          receivedAt: this.now(),
          bodyRef: this.store.object(content).objectRef,
          bodyHash,
          preview: incoming.text.slice(0, AUTOMATION_LIMITS.previewChars),
        };
        this.store.db
          .prepare(
            'INSERT INTO automation_events_v1(id,project_id,source_id,source_revision,event_id,event_revision,conversation_id,body_ref,data) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            key,
            source.projectId,
            source.id,
            source.revision,
            incoming.eventId,
            incoming.revision,
            incoming.conversationId,
            event.bodyRef,
            stable(event),
          );
        const subscriptions = this.store.db
          .prepare(
            'SELECT * FROM automation_subscriptions_v1 WHERE source_id=? AND conversation_id=? AND source_revision=? AND active=1 LIMIT ?',
          )
          .all(source.id, incoming.conversationId, source.revision, AUTOMATION_LIMITS.subscriptions);
        let inputs = 0;
        for (const subscribed of subscriptions) {
          const subscription = this.parse(AutomationSubscription, subscribed),
            run = this.store.require<Run>('runs', subscription.runId);
          invariant(run.projectId === source.projectId, 'AUTOMATION_RUN_SCOPE', '订阅运行不属于来源项目');
          if (run.archived || ['DONE', 'CANCELLED'].includes(run.status)) continue;
          const input: AutomationContextInput = {
            id: hash(stable([key, run.id])),
            eventId: key,
            source: sourceLease(source),
            runId: run.id,
            kind: 'context',
            status: 'pending',
            createdAt: this.now(),
          };
          this.store.db
            .prepare(
              'INSERT INTO automation_inputs_v1(id,project_id,source_id,event_id,run_id,status,data) VALUES(?,?,?,?,?,?,?)',
            )
            .run(input.id, source.projectId, source.id, key, run.id, input.status, stable(input));
          inputs++;
        }
        if (!inputs) {
          const candidate: AutomationCandidate = {
            id: key,
            eventId: key,
            source: sourceLease(source),
            conversationId: incoming.conversationId,
            status: 'candidate',
            preview: event.preview,
            proposal: null,
            createdAt: this.now(),
          };
          this.store.db
            .prepare(
              'INSERT INTO automation_candidates_v1(id,project_id,source_id,event_id,status,data) VALUES(?,?,?,?,?,?)',
            )
            .run(key, source.projectId, source.id, key, candidate.status, stable(candidate));
        }
        received.push({ id: key, duplicate: false, inputs, candidate: !inputs });
      }
      this.store.db
        .prepare('UPDATE automation_sources_v1 SET data=? WHERE id=? AND revision=?')
        .run(
          stable({ ...source, cursor: batch.nextCursor, updatedAt: this.now() }),
          source.id,
          source.revision,
        );
      return { received, cursor: batch.nextCursor };
    });
  }
  event(projectId: string, eventId: string) {
    this.project(projectId);
    const event = this.parse(
      AutomationStoredEvent,
      this.store.db
        .prepare('SELECT * FROM automation_events_v1 WHERE project_id=? AND id=?')
        .get(projectId, eventId),
    );
    return {
      event,
      body: AutomationIncomingEvent.parse(
        JSON.parse(this.store.readObject(event.bodyRef, AUTOMATION_LIMITS.eventBytes).toString('utf8')),
      ),
    };
  }
  candidate(projectId: string, candidateId: string) {
    this.project(projectId);
    return this.parse(
      AutomationCandidate,
      this.store.db
        .prepare('SELECT * FROM automation_candidates_v1 WHERE project_id=? AND id=?')
        .get(projectId, candidateId),
    );
  }
  /** 提案回写重新核对来源代次；插件不能自动建立订阅或开始执行。
   * EN: Proposal writes recheck the source generation and never establish subscriptions or start execution. */
  propose(
    projectId: string,
    candidateId: string,
    expectedSource: AutomationSourceLease,
    raw: AutomationRouteProposal,
  ) {
    const proposal = AutomationRouteProposal.parse(raw);
    return this.store.tx(() => {
      const source = this.current(expectedSource),
        candidate = this.candidate(projectId, candidateId);
      invariant(
        candidate.source.id === source.id &&
          candidate.source.revision === source.revision &&
          ['candidate', 'proposed'].includes(candidate.status),
        'AUTOMATION_CANDIDATE_STALE',
        '候选已失效',
      );
      if (proposal.kind === 'suggest-attach') this.run(projectId, proposal.runId, true);
      const next: AutomationCandidate = { ...candidate, status: 'proposed', proposal };
      this.store.db
        .prepare("UPDATE automation_candidates_v1 SET status='proposed',data=? WHERE id=?")
        .run(stable(next), candidate.id);
      return next;
    });
  }
  observeInput(projectId: string, inputId: string) {
    return this.store.tx(() => {
      this.project(projectId, true);
      const input = this.parse(
        AutomationContextInput,
        this.store.db
          .prepare('SELECT * FROM automation_inputs_v1 WHERE project_id=? AND id=?')
          .get(projectId, inputId),
      );
      this.current(input.source);
      invariant(input.status !== 'stale', 'AUTOMATION_INPUT_STALE', '上下文输入已失效');
      const next: AutomationContextInput = { ...input, status: 'observed' };
      this.store.db
        .prepare("UPDATE automation_inputs_v1 SET status='observed',data=? WHERE id=?")
        .run(stable(next), input.id);
      return next;
    });
  }
  /** 只持久排队，稳定消息身份不得用不同正文重用。
   * EN: Only queues durably; stable message identities cannot be reused with different bodies. */
  enqueueReply(projectId: string, sourceId: string, raw: AutomationReplyRequest) {
    const input = AutomationReplyRequest.parse(raw);
    return this.store.tx(() => {
      const source = this.source(projectId, sourceId);
      invariant(
        source.revision === input.expectedSourceRevision,
        'AUTOMATION_SOURCE_STALE',
        '来源修订已变化',
      );
      this.current(sourceLease(source));
      this.allowed(source, input.conversationId, 'reply');
      if (input.eventId) {
        const event = this.event(projectId, input.eventId).event;
        invariant(
          event.source.id === source.id && event.conversationId === input.conversationId,
          'AUTOMATION_REPLY_SCOPE',
          '回信事件不属于指定来源会话',
        );
      }
      const key = hash(stable([source.id, input.messageId])),
        messageHash = hash(
          stable({ text: input.text, conversationId: input.conversationId, eventId: input.eventId ?? null }),
        );
      const old = this.store.db.prepare('SELECT * FROM automation_outbox_v1 WHERE id=?').get(key);
      if (old) {
        const message = this.parse(AutomationOutboxMessage, old);
        invariant(
          message.messageHash === messageHash,
          'AUTOMATION_REPLY_CONFLICT',
          '同一消息身份包含不同内容',
        );
        return message;
      }
      const message: AutomationOutboxMessage = {
        id: key,
        messageId: input.messageId,
        source: sourceLease(source),
        conversationId: input.conversationId,
        eventId: input.eventId ?? null,
        messageRef: this.store.object(input.text).objectRef,
        messageHash,
        preview: input.text.slice(0, 600),
        status: 'pending',
        attempts: 0,
        dueAt: this.clock(),
        cancelRequested: false,
        lastOutcome: null,
        reason: '',
        receipt: null,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.store.db
        .prepare(
          'INSERT INTO automation_outbox_v1(id,project_id,source_id,conversation_id,source_revision,status,due_at,message_ref,data) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          key,
          projectId,
          source.id,
          input.conversationId,
          source.revision,
          message.status,
          message.dueAt,
          message.messageRef,
          stable(message),
        );
      return message;
    });
  }
  message(projectId: string, messageId: string) {
    this.project(projectId);
    return this.parse(
      AutomationOutboxMessage,
      this.store.db
        .prepare('SELECT * FROM automation_outbox_v1 WHERE project_id=? AND id=?')
        .get(projectId, messageId),
    );
  }
  private saveMessage(message: AutomationOutboxMessage) {
    message = AutomationOutboxMessage.parse({ ...message, updatedAt: this.now() });
    this.store.db
      .prepare('UPDATE automation_outbox_v1 SET status=?,due_at=?,data=? WHERE id=? AND project_id=?')
      .run(message.status, message.dueAt, stable(message), message.id, message.source.projectId);
    return message;
  }
  due(projectId: string, limit = 10) {
    this.project(projectId, true);
    invariant(
      Number.isInteger(limit) && limit > 0 && limit <= AUTOMATION_LIMITS.dispatch,
      'AUTOMATION_DISPATCH_LIMIT',
      '派发数量无效',
    );
    return this.store.db
      .prepare(
        `SELECT own.* FROM automation_outbox_v1 own
        WHERE own.project_id=? AND own.status IN ('pending','retry') AND own.due_at<=?
        AND NOT EXISTS (
          SELECT 1 FROM automation_outbox_v1 earlier
          WHERE earlier.source_id=own.source_id AND earlier.conversation_id=own.conversation_id
          AND earlier.seq<own.seq AND earlier.status IN ('pending','retry','sending','unknown')
        ) ORDER BY own.seq LIMIT ?`,
      )
      .all(projectId, this.clock(), limit)
      .map((row) => this.parse(AutomationOutboxMessage, row));
  }
  /** 发送前提交 sending；同一会话的未知投递阻止后续消息越过它。
   * EN: Commits sending before dispatch; unknown delivery blocks later messages of the same conversation. */
  claimMessage(projectId: string, messageId: string) {
    return this.store.tx(() => {
      const message = this.message(projectId, messageId);
      if (!['pending', 'retry'].includes(message.status) || message.dueAt > this.clock()) return null;
      const source = this.current(message.source);
      this.allowed(source, message.conversationId, 'reply');
      const ahead = this.store.db
        .prepare(
          `SELECT 1 FROM automation_outbox_v1 earlier JOIN automation_outbox_v1 own ON own.id=?
        WHERE earlier.source_id=own.source_id AND earlier.conversation_id=own.conversation_id AND earlier.seq<own.seq
        AND earlier.status IN ('pending','retry','sending','unknown') LIMIT 1`,
        )
        .get(message.id);
      if (ahead) return null;
      return this.saveMessage({ ...message, status: 'sending', attempts: message.attempts + 1 });
    });
  }
  /** 只有明确未发送的结果可退避重试；抛错和不可确认结果保留 unknown。
   * EN: Only proven not-sent results can retry with backoff; exceptions and uncertain results remain unknown. */
  settle(projectId: string, messageId: string, raw: AutomationDeliveryResult, reconciliation = false) {
    const outcome = AutomationDeliveryResult.parse(raw);
    return this.store.tx(() => {
      const message = this.message(projectId, messageId);
      invariant(
        ['sending', 'unknown'].includes(message.status),
        'AUTOMATION_REPLY_STATE',
        '消息不在投递或待核验状态',
      );
      let status: AutomationOutboxMessage['status'];
      if (outcome.status === 'sent') status = 'sent';
      else if (outcome.status === 'unknown') status = 'unknown';
      else if (message.cancelRequested) status = 'cancelled';
      else if (!reconciliation && outcome.retryable && message.attempts < AUTOMATION_LIMITS.attempts)
        status = 'retry';
      else status = 'failed';
      return this.saveMessage({
        ...message,
        status,
        lastOutcome: outcome.status,
        receipt: outcome.status === 'sent' ? outcome.receipt : message.receipt,
        reason: outcome.status === 'sent' ? '' : outcome.reason,
        dueAt:
          status === 'retry'
            ? this.clock() +
              Math.min(
                AUTOMATION_LIMITS.retryMaxMs,
                AUTOMATION_LIMITS.retryBaseMs * 2 ** Math.max(0, message.attempts - 1),
              )
            : message.dueAt,
      });
    });
  }
  cancelReply(projectId: string, messageId: string) {
    return this.store.tx(() => {
      this.project(projectId, true);
      const message = this.message(projectId, messageId);
      if (['sent', 'cancelled'].includes(message.status)) return message;
      return this.saveMessage({
        ...message,
        cancelRequested: true,
        status: ['sending', 'unknown'].includes(message.status) ? 'unknown' : 'cancelled',
        lastOutcome: ['sending', 'unknown'].includes(message.status) ? 'unknown' : message.lastOutcome,
        reason: '已撤销；已在途的发送仍需核验',
      });
    });
  }
  /** 远端核验确认未发送后仍需要显式重试，并重新核对原权限快照。
   * EN: Remote proof of no delivery still requires an explicit retry and revalidation of the original authority snapshot. */
  retryReply(projectId: string, messageId: string) {
    return this.store.tx(() => {
      const message = this.message(projectId, messageId),
        source = this.current(message.source);
      this.allowed(source, message.conversationId, 'reply');
      invariant(
        message.status === 'failed' && message.lastOutcome === 'not-sent' && !message.cancelRequested,
        'AUTOMATION_RETRY_UNSAFE',
        '仅已确认未发送且未撤销的失败消息可以重试',
      );
      return this.saveMessage({ ...message, status: 'pending', dueAt: this.clock(), reason: '' });
    });
  }
  /** 归档项目仍可结算事实；破坏性删除必须等所有投递结果确定。
   * EN: Archived projects may still settle facts; destructive deletion requires every delivery outcome to be known. */
  assertProjectDeletable(projectId: string) {
    this.project(projectId);
    const unresolved = this.store.db
      .prepare(
        `SELECT 1 FROM automation_outbox_v1 WHERE project_id=?
        AND (status IN ('sending','unknown') OR json_extract(data,'$.status') IN ('sending','unknown')) LIMIT 1`,
      )
      .get(projectId);
    invariant(
      !unresolved,
      'AUTOMATION_PROJECT_UNRESOLVED',
      '项目仍有在途或未知投递，请先恢复项目并核验远端结果后再删除',
    );
  }
  /** 重启仅把未结算发送变成未知，不重放外部副作用。
   * EN: Restart marks unsettled sends unknown without replaying external side effects. */
  recoverSending() {
    this.store.db
      .prepare(
        `UPDATE automation_outbox_v1 SET status='unknown',data=json_set(data,'$.status','unknown',
      '$.lastOutcome','unknown','$.reason','发送期间宿主中断，需核验远端结果','$.updatedAt',?) WHERE status='sending'`,
      )
      .run(this.now());
  }
}
