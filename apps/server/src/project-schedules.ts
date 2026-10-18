import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  ContextPolicy,
  Contract,
  Limits,
  ProviderConfig,
  invariant,
  type Agent,
  type Project,
  type Run,
} from '../../../packages/contracts/src/index.js';
import {
  PROJECT_SCHEDULE_LIMITS,
  ProjectScheduleCreate,
  ProjectScheduleSettings,
  ProjectScheduleUpdate,
  type ProjectSchedule,
  type ProjectScheduleList,
  type ProjectSchedulePreview,
  type ProjectScheduleTemplate,
} from '../../../packages/contracts/src/project-schedules.js';
import {
  freezeProjectCapabilities,
  listProjectMemories,
} from '../../../packages/context/src/project-intelligence.js';
import type { Kernel } from '../../../packages/kernel/src/index.js';
import { freezeRoleRouting } from '../../../packages/kernel/src/model-routing.js';
import { hash, id, stable, type Store } from '../../../packages/storage/src/index.js';

export const projectSchedulesKey = (projectId: string) => `project-schedules:v1:${projectId}`;
const prefix = 'project-schedules:v1:';
const date = z.string().datetime(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const providerSchema = ProviderConfig.safeExtend({
  revision: z.number().int().positive(),
  checkedRevision: z.number().int().positive().nullable(),
  checkedAt: z.string().optional(),
});
const templateSchema = z
  .object({
    sourceRunId: z.string().uuid(),
    sourceRevision: z.number().int().nonnegative(),
    sourceTitle: z.string(),
    objective: z.string().min(1).max(20000),
    contract: Contract,
    limits: Limits,
    contextPolicy: ContextPolicy,
    provider: providerSchema,
    environment: z
      .object({
        workspaceRoot: z.string().min(1),
        configVersion: z.number().int().nonnegative(),
        baseline: z.string().nullable(),
        capabilityHash: digest,
        memoryHash: digest,
        routingHash: digest,
        providerHash: digest,
      })
      .strict(),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    revision: z.number().int().positive(),
    template: templateSchema,
    captureHash: digest,
    settings: ProjectScheduleSettings,
    status: z.enum(['draft', 'enabled', 'paused', 'completed']),
    createdCount: z.number().int().nonnegative().max(100),
    skippedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    nextDueAt: date.nullable(),
    lastRunId: z.string().uuid().nullable(),
    lastDueAt: date.nullable(),
    reason: z.string().max(1000).nullable(),
    createdAt: date,
    updatedAt: date,
  })
  .strict();
const metadataSchema = z
  .object({ version: z.literal(1), schedules: z.array(recordSchema).max(PROJECT_SCHEDULE_LIMITS.perProject) })
  .strict();
const iso = (time: number) => new Date(time).toISOString();
const captureHash = (template: ProjectScheduleTemplate) => hash(stable(template));
function conflict(expected: number, current: number) {
  if (expected !== current)
    throw new AppError(
      'REVISION_CONFLICT',
      '定时任务或来源已更新，请重新读取并核对',
      false,
      { currentRevision: current },
      409,
    );
}
function readSchedules(store: Store, projectId: string): ProjectSchedule[] {
  const row = store.db
    .prepare('SELECT value FROM storage_meta WHERE key=?')
    .get(projectSchedulesKey(projectId)) as { value: string } | undefined;
  if (!row) return [];
  try {
    invariant(
      Buffer.byteLength(row.value) <= PROJECT_SCHEDULE_LIMITS.projectBytes,
      'SCHEDULE_INVALID',
      '定时任务记录过大',
    );
    const records = metadataSchema.parse(JSON.parse(row.value)).schedules;
    invariant(
      new Set(records.map((s) => s.id)).size === records.length,
      'SCHEDULE_INVALID',
      '定时任务标识重复',
    );
    for (const record of records) {
      invariant(
        record.projectId === projectId && captureHash(record.template) === record.captureHash,
        'SCHEDULE_INVALID',
        '定时任务冻结内容损坏',
      );
      invariant(
        record.createdCount <= record.settings.maxRuns &&
          (record.status !== 'enabled' || record.nextDueAt !== null),
        'SCHEDULE_INVALID',
        '定时任务计数或时间损坏',
      );
      validateTemplate(record.template);
    }
    return records;
  } catch {
    throw new AppError(
      'SCHEDULE_INVALID',
      '定时任务记录损坏，已停止调度并保留原文，请恢复备份',
      false,
      null,
      409,
    );
  }
}
function writeSchedules(store: Store, projectId: string, schedules: ProjectSchedule[]) {
  if (!schedules.length) {
    store.db.prepare('DELETE FROM storage_meta WHERE key=?').run(projectSchedulesKey(projectId));
    return;
  }
  const text = stable(metadataSchema.parse({ version: 1, schedules }));
  invariant(
    Buffer.byteLength(text) <= PROJECT_SCHEDULE_LIMITS.projectBytes,
    'SCHEDULE_LIMIT',
    '项目定时任务记录超过容量上限',
  );
  store.db
    .prepare('INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)')
    .run(projectSchedulesKey(projectId), text);
}
function scheduleProjects(store: Store) {
  const rows = store.db
    .prepare('SELECT key FROM storage_meta WHERE key LIKE ? ORDER BY key LIMIT ?')
    .all(prefix + '%', PROJECT_SCHEDULE_LIMITS.total + 1) as { key: string }[];
  invariant(
    rows.length <= PROJECT_SCHEDULE_LIMITS.total,
    'SCHEDULE_LIMIT',
    '定时项目数量超过全局上限，已停止调度',
  );
  return rows.map(({ key }) => key.slice(prefix.length));
}
function mutableProject(store: Store, projectId: string, assertMutable: SchedulerHooks['assertMutable']) {
  const project = store.require<Project>('projects', projectId);
  assertMutable(null, projectId);
  invariant(!project.archived, 'PROJECT_ARCHIVED', '请先恢复项目再核对定时任务');
  return project;
}
function validateTemplate(template: ProjectScheduleTemplate) {
  invariant(
    Buffer.byteLength(stable(template)) <= PROJECT_SCHEDULE_LIMITS.templateBytes,
    'SCHEDULE_TEMPLATE_LIMIT',
    '复用模板超过 128 KiB，请精简任务约定',
  );
  invariant(
    template.contract.inputs.length === 0,
    'SCHEDULE_SOURCE_INPUTS',
    '首版定时任务只复用无输入引用的任务',
  );
  invariant(
    template.contract.budget.maxTokens <= PROJECT_SCHEDULE_LIMITS.maximumTokensPerRun,
    'SCHEDULE_TOKEN_LIMIT',
    '每次定时任务的 Token 预算不能超过 1M',
  );
  invariant(
    template.provider.checkedRevision === template.provider.revision,
    'PROVIDER_UNCHECKED',
    '请先验证模板使用的模型连接',
  );
}
function validateSettings(settings: ProjectScheduleSettings, at: number, count = 0) {
  const until = Date.parse(settings.until);
  invariant(
    until > at + settings.intervalMinutes * 60000 &&
      until <= at + PROJECT_SCHEDULE_LIMITS.maximumDays * 86400000,
    'SCHEDULE_DEADLINE',
    '截止时间须晚于下一次执行且在 31 天以内',
  );
  invariant(
    settings.maxRuns > count,
    'SCHEDULE_EXHAUSTED',
    '最多创建次数必须大于已经创建的次数；累计次数不会清零',
  );
}
function hasUncertainState(store: Store, runId: string, includePending = true) {
  return (
    !!store.getExecutionHold(runId) ||
    !!store.db
      .prepare(
        `SELECT 1 FROM requests WHERE run_id=? AND COALESCE(json_extract(data,'$.status'),json_extract(data,'$.readModel.status')) IN (${includePending ? "'RESERVED','UNKNOWN'" : "'UNKNOWN'"}) LIMIT 1`,
      )
      .get(runId) ||
    !!store.db
      .prepare(
        `SELECT 1 FROM tool_operations WHERE run_id=? AND COALESCE(json_extract(data,'$.status'),json_extract(data,'$.readModel.status')) IN (${includePending ? "'INTENT','UNCERTAIN'" : "'UNCERTAIN'"}) LIMIT 1`,
      )
      .get(runId)
  );
}
function providerFingerprint(provider: ProviderConfig) {
  // Verification timestamps do not change authority; all executable provider settings do.
  const { checkedAt: _checkedAt, ...settings } = provider;
  return hash(stable(settings));
}
function environment(
  store: Store,
  project: Project,
  providerId: string,
): ProjectScheduleTemplate['environment'] {
  const provider = store.require<ProviderConfig>('providers', providerId);
  invariant(
    !provider.archived && provider.checkedRevision === provider.revision,
    'SCHEDULE_PROVIDER_CHANGED',
    '模型连接已归档或未经验证，请重新核对',
  );
  const {
    createdAt: _createdAt,
    hash: _snapshotHash,
    ...capabilities
  } = freezeProjectCapabilities(store, project.id);
  const routing = freezeRoleRouting(store, project.id);
  invariant(
    !Object.keys(routing.unavailable ?? {}).length,
    'SCHEDULE_ROUTING_UNAVAILABLE',
    '项目角色连接不可用，请先修复后重新核对',
  );
  return {
    workspaceRoot: project.workspaceRoot,
    configVersion: project.configVersion,
    baseline: project.baseline,
    capabilityHash: hash(
      stable({
        ...capabilities,
        builtinSkills: [...capabilities.builtinSkills].sort((a, b) => a.id.localeCompare(b.id)),
        localItems: capabilities.localItems
          .map(({ importedAt: _importedAt, updatedAt: _updatedAt, ...item }) => item)
          .sort((a, b) => a.id.localeCompare(b.id)),
      }),
    ),
    memoryHash: hash(
      stable(
        listProjectMemories(store, project.id)
          .filter((m) => m.status === 'active')
          .map(({ id, revision, hash }) => ({ id, revision, hash })),
      ),
    ),
    routingHash: hash(
      stable({
        ...routing,
        bindings: Object.fromEntries(
          Object.entries(routing.bindings).map(([role, binding]) => [role, providerFingerprint(binding)]),
        ),
      }),
    ),
    providerHash: providerFingerprint(provider),
  };
}
export interface SchedulerHooks {
  assertMutable: (runId: string | null, projectId?: string | null) => void;
  resume: (runId: string) => void;
  onError?: (error: unknown) => void;
}

/** Owns only bounded task creation. Existing Kernel/executor own permissions, budgets and execution. */
export class ProjectScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(
    private store: Store,
    private kernel: Kernel,
    private hooks: SchedulerHooks,
  ) {}
  private reportError(projectId?: string) {
    // Diagnostic callbacks never receive raw database bodies, task text or connector errors.
    try {
      this.hooks.onError?.(
        new AppError(
          'SCHEDULE_RECORD_UNAVAILABLE',
          '部分定时任务无法读取，已跳过相关调度并保留原始记录',
          false,
          { projectId: projectId ?? null },
          409,
        ),
      );
    } catch {
      /* Diagnostics cannot interrupt other projects. */
    }
  }
  private inventory() {
    const result: { projectId: string; schedules: ProjectSchedule[] }[] = [];
    try {
      for (const projectId of scheduleProjects(this.store)) {
        try {
          result.push({ projectId, schedules: readSchedules(this.store, projectId) });
        } catch {
          this.reportError(projectId);
        }
      }
      invariant(
        result.reduce((sum, item) => sum + item.schedules.length, 0) <= PROJECT_SCHEDULE_LIMITS.total,
        'SCHEDULE_LIMIT',
        '定时任务超过全局数量上限',
      );
    } catch {
      this.reportError();
      return [];
    }
    return result;
  }
  preview(projectId: string, sourceRunId: string): ProjectSchedulePreview {
    return this.store.tx(() => {
      const project = mutableProject(this.store, projectId, this.hooks.assertMutable);
      const source = this.store.require<Run>('runs', sourceRunId);
      this.hooks.assertMutable(source.id, projectId);
      invariant(
        source.projectId === projectId && source.kind === 'task' && source.execution?.kind !== 'docker-agent',
        'SCHEDULE_SOURCE_SCOPE',
        '只能复用当前原生项目的任务',
      );
      invariant(!source.archived, 'RUN_ARCHIVED', '请先恢复来源任务');
      invariant(
        !source.source &&
          !source.contract.inputs.length &&
          !source.plan?.snapshotIds.length &&
          !this.store.db.prepare('SELECT 1 FROM snapshots WHERE run_id=? LIMIT 1').get(source.id),
        'SCHEDULE_SOURCE_INPUTS',
        '首版不复用带来源、附件输入或文件快照的任务，请新建无引用的独立任务作为模板',
      );
      invariant(
        !hasUncertainState(this.store, source.id),
        'SCHEDULE_SOURCE_UNCERTAIN',
        '来源任务有未完成请求、待核验操作或执行抑制，请先处理',
      );
      const agent = this.store.require<Agent>('agents', source.coordinatorAgentId);
      invariant(
        agent.runId === source.id && agent.taskId === source.rootTaskId,
        'SCHEDULE_SOURCE_SCOPE',
        '来源协调代理归属不一致',
      );
      const current = this.store.require<ProviderConfig>('providers', agent.providerId);
      const provider = current.revision === agent.providerBinding.revision ? agent.providerBinding : current;
      const template: ProjectScheduleTemplate = {
        sourceRunId: source.id,
        sourceRevision: source.revision,
        sourceTitle: source.title,
        objective: source.objective,
        contract: Contract.parse(source.contract),
        limits: Limits.parse(source.limits),
        contextPolicy: ContextPolicy.parse(agent.contextPolicy ?? { mode: 'managed' }),
        provider: providerSchema.parse(provider),
        environment: environment(this.store, project, current.id),
      };
      validateTemplate(template);
      return { projectId, template, captureHash: captureHash(template) };
    });
  }
  list(projectId: string): ProjectScheduleList {
    this.store.require<Project>('projects', projectId);
    const rows = this.store.db
      .prepare(
        `SELECT id,revision,COALESCE(json_extract(data,'$.readModel.title'),json_extract(data,'$.title')) title,COALESCE(json_extract(data,'$.readModel.status'),json_extract(data,'$.status')) status FROM runs WHERE COALESCE(json_extract(data,'$.readModel.projectId'),json_extract(data,'$.projectId'))=? AND COALESCE(json_extract(data,'$.readModel.kind'),json_extract(data,'$.kind'))='task' AND COALESCE(json_extract(data,'$.readModel.archived'),json_extract(data,'$.archived'),0)=0 AND COALESCE(json_extract(data,'$.readModel.execution.kind'),json_extract(data,'$.execution.kind'),'native')='native' ORDER BY rowid DESC LIMIT ?`,
      )
      .all(projectId, PROJECT_SCHEDULE_LIMITS.sourcePage + 1) as ProjectScheduleList['sources'];
    return {
      projectId,
      schedules: readSchedules(this.store, projectId),
      sources: rows.slice(0, PROJECT_SCHEDULE_LIMITS.sourcePage),
      sourcesLimited: rows.length > PROJECT_SCHEDULE_LIMITS.sourcePage,
      limits: PROJECT_SCHEDULE_LIMITS,
    };
  }
  create(projectId: string, body: ProjectScheduleCreate, at = Date.now()) {
    const result = this.store.command(
      body.commandId,
      { route: `/projects/${projectId}/schedules`, body },
      () => {
        const preview = this.preview(projectId, body.sourceRunId);
        conflict(body.expectedSourceRevision, preview.template.sourceRevision);
        invariant(
          body.captureHash === preview.captureHash,
          'SCHEDULE_CAPTURE_CHANGED',
          '模板或项目配置已变化，请重新预览后保存',
        );
        validateSettings(body.settings, at);
        const schedules = readSchedules(this.store, projectId);
        invariant(
          schedules.length < PROJECT_SCHEDULE_LIMITS.perProject,
          'SCHEDULE_LIMIT',
          '每个项目最多保留 20 条定时任务',
        );
        const count = scheduleProjects(this.store).reduce((sum, project) => {
          try {
            return sum + readSchedules(this.store, project).length;
          } catch {
            // An unreadable project cannot execute. Reserve its maximum possible
            // capacity so healthy projects can continue without weakening the cap.
            this.reportError(project);
            return sum + PROJECT_SCHEDULE_LIMITS.perProject;
          }
        }, 0);
        invariant(count < PROJECT_SCHEDULE_LIMITS.total, 'SCHEDULE_LIMIT', '本机最多保留 100 条定时任务');
        const record: ProjectSchedule = {
          ...preview,
          version: 1,
          id: id(),
          revision: 1,
          settings: body.settings,
          status: 'draft',
          createdCount: 0,
          skippedCount: 0,
          nextDueAt: null,
          lastRunId: null,
          lastDueAt: null,
          reason: '等待核对并显式启用',
          createdAt: iso(at),
          updatedAt: iso(at),
        };
        writeSchedules(this.store, projectId, [...schedules, record]);
        return record;
      },
    );
    this.arm();
    return result;
  }
  update(projectId: string, scheduleId: string, body: ProjectScheduleUpdate, at = Date.now()) {
    const result = this.store.command(
      body.commandId,
      { route: `/projects/${projectId}/schedules/${scheduleId}`, body },
      () => {
        const project = mutableProject(this.store, projectId, this.hooks.assertMutable);
        const schedules = readSchedules(this.store, projectId),
          index = schedules.findIndex((s) => s.id === scheduleId);
        invariant(index >= 0, 'SCHEDULE_MISSING', '定时任务已不存在');
        const current = schedules[index];
        conflict(body.expectedRevision, current.revision);
        invariant(
          body.action === 'refresh' ||
            (body.settings === undefined && body.expectedSourceRevision === undefined),
          'SCHEDULE_ACTION',
          '修改模板或设置请使用重新核对',
        );
        if (body.action === 'delete') {
          writeSchedules(
            this.store,
            projectId,
            schedules.filter((s) => s.id !== scheduleId),
          );
          return { deleted: true as const, id: scheduleId };
        }
        let next: ProjectSchedule = { ...current, revision: current.revision + 1, updatedAt: iso(at) };
        if (body.action === 'pause')
          next = {
            ...next,
            status: 'paused',
            nextDueAt: null,
            reason: '用户暂停；已创建的任务需在任务内单独停止',
          };
        if (body.action === 'refresh') {
          const preview = this.preview(projectId, current.template.sourceRunId);
          invariant(
            body.expectedSourceRevision !== undefined,
            'SCHEDULE_SOURCE_REVISION',
            '请先读取当前模板版本',
          );
          conflict(body.expectedSourceRevision, preview.template.sourceRevision);
          invariant(
            body.captureHash === preview.captureHash,
            'SCHEDULE_CAPTURE_CHANGED',
            '当前预览已变化，请重新读取',
          );
          const settings = body.settings ?? current.settings;
          validateSettings(settings, at, current.createdCount);
          next = {
            ...next,
            ...preview,
            settings,
            status: 'draft',
            nextDueAt: null,
            reason: '重新核对后须再次显式启用；累计次数保留',
          };
        }
        if (body.action === 'enable') {
          invariant(current.status !== 'enabled', 'SCHEDULE_ENABLED', '定时任务已启用');
          invariant(
            body.captureHash === current.captureHash,
            'SCHEDULE_CAPTURE_CHANGED',
            '请核对完整模板后启用',
          );
          invariant(
            current.settings.mode !== 'execute' || body.confirmAutomaticExecution === true,
            'SCHEDULE_AUTOMATIC_CONFIRMATION',
            '自动执行需要明确确认模板权限及每次预算',
          );
          validateSettings(current.settings, at, current.createdCount);
          this.assertEnvironment(current, project);
          this.assertPriorRun(current, true);
          next = {
            ...next,
            status: 'enabled',
            nextDueAt: iso(at + current.settings.intervalMinutes * 60000),
            reason: null,
          };
        }
        schedules[index] = next;
        writeSchedules(this.store, projectId, schedules);
        return next;
      },
    );
    this.arm();
    return result;
  }
  private assertEnvironment(schedule: ProjectSchedule, project: Project) {
    const source = this.store.get<Run>('runs', schedule.template.sourceRunId);
    invariant(
      source && source.projectId === project.id && !source.archived,
      'SCHEDULE_SOURCE_MISSING',
      '来源任务已删除或归档，请停止或重新核对定时任务',
    );
    this.hooks.assertMutable(source.id, project.id);
    invariant(
      stable(environment(this.store, project, schedule.template.provider.id)) ===
        stable(schedule.template.environment),
      'SCHEDULE_CONFIGURATION_CHANGED',
      '项目目录、能力、记忆、角色路由或模型配置已变化，请重新核对后启用',
    );
  }
  private assertPriorRun(schedule: ProjectSchedule, enabling = false) {
    if (!schedule.lastRunId) return true;
    const previous = this.store.get<Run>('runs', schedule.lastRunId);
    invariant(
      previous && previous.projectId === schedule.projectId,
      'SCHEDULE_PREVIOUS_MISSING',
      '上次创建的任务已删除，无法核对结果，定时任务已暂停',
    );
    this.hooks.assertMutable(previous.id, schedule.projectId);
    invariant(
      !hasUncertainState(this.store, previous.id, previous.status === 'DONE') &&
        previous.reason !== 'verification',
      'SCHEDULE_VERIFICATION',
      '上次任务仍有请求、操作或用量需要核验，定时任务已暂停',
    );
    invariant(
      !previous.archived && !['FAILED', 'CANCELLED'].includes(previous.status),
      'SCHEDULE_PREVIOUS_STOPPED',
      '上次任务已归档、失败或取消，定时任务已暂停',
    );
    const done = previous.status === 'DONE';
    if (enabling) invariant(done, 'SCHEDULE_PREVIOUS_ACTIVE', '上次任务尚未结束，暂不能重新启用定时任务');
    return done;
  }
  /** Advance missed slots before any timer starts; restarting never launches overdue work. */
  recover(at = Date.now()) {
    for (const { projectId } of this.inventory()) {
      try {
        this.store.tx(() => {
          const schedules = readSchedules(this.store, projectId);
          let changed = false;
          for (let i = 0; i < schedules.length; i++) {
            const current = schedules[i];
            if (current.status !== 'enabled') continue;
            const due = Date.parse(current.nextDueAt!);
            if (Date.parse(current.settings.until) <= at) {
              schedules[i] = {
                ...current,
                revision: current.revision + 1,
                status: 'completed',
                nextDueAt: null,
                reason: '已到截止时间',
                updatedAt: iso(at),
              };
              changed = true;
            } else if (due <= at) {
              const skipped = Math.floor((at - due) / (current.settings.intervalMinutes * 60000)) + 1;
              schedules[i] = {
                ...current,
                revision: current.revision + 1,
                nextDueAt: iso(due + skipped * current.settings.intervalMinutes * 60000),
                skippedCount: current.skippedCount + skipped,
                reason: '服务重启已跳过错过时段，未补跑',
                updatedAt: iso(at),
              };
              changed = true;
            }
          }
          if (changed) writeSchedules(this.store, projectId, schedules);
        });
      } catch {
        this.reportError(projectId);
      }
    }
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.recover();
    this.arm();
  }
  private arm(minimumDelay = 0) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const at = Date.now();
    // This is only a wake-up hint. tick() always reads fresh records before it
    // considers dispatch, including changes committed through another connection.
    let wakeAt = at + 30000;
    for (const { schedules } of this.inventory())
      for (const record of schedules)
        if (record.status === 'enabled')
          wakeAt = Math.min(wakeAt, Date.parse(record.nextDueAt!), Date.parse(record.settings.until));
    // A diagnostic callback can stop the scheduler while inventory is read.
    if (!this.running) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (!this.running) return;
        let failed = false;
        try {
          this.tick();
        } catch {
          failed = true;
          this.reportError();
        } finally {
          // A persistent write failure must not turn an overdue record into a busy loop.
          this.arm(failed ? 1000 : 0);
        }
      },
      Math.max(minimumDelay, wakeAt - Date.now(), 0),
    );
  }
  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  tick(at = Date.now()) {
    for (const { projectId, schedules } of this.inventory()) {
      for (const record of schedules) {
        if (record.status !== 'enabled') continue;
        if (Date.parse(record.nextDueAt!) > at && Date.parse(record.settings.until) > at) continue;
        let createdRun: Run | undefined;
        this.store.tx(() => {
          const latest = readSchedules(this.store, projectId),
            index = latest.findIndex((s) => s.id === record.id),
            current = latest[index];
          if (!current || current.status !== 'enabled') return;
          const due = Date.parse(current.nextDueAt!),
            interval = current.settings.intervalMinutes * 60000;
          if (due > at && Date.parse(current.settings.until) > at) return;
          let next: ProjectSchedule = { ...current, revision: current.revision + 1, updatedAt: iso(at) };
          if (Date.parse(current.settings.until) <= at || current.createdCount >= current.settings.maxRuns)
            next = {
              ...next,
              status: 'completed',
              nextDueAt: null,
              reason: '已到截止时间或达到最多创建次数',
            };
          else {
            const skipped = Math.floor((at - due) / interval) + 1;
            next.nextDueAt = iso(due + skipped * interval);
            try {
              const project = mutableProject(this.store, projectId, this.hooks.assertMutable);
              this.assertEnvironment(current, project);
              const done = this.assertPriorRun(current);
              if (!done || skipped > 1)
                next = {
                  ...next,
                  skippedCount: next.skippedCount + skipped,
                  reason: !done ? '上次任务尚未结束，已跳过本时段' : '已跳过错过时段，未补跑',
                };
              else {
                // The due-slot command and all task rows commit with the consumed slot.
                const dispatchId = 'schedule:' + current.id + ':' + current.nextDueAt;
                // Store.tx nests without savepoints. Roll back partial Kernel writes before
                // recording a paused schedule if creation fails inside the outer transaction.
                this.store.db.exec('SAVEPOINT schedule_dispatch');
                try {
                  createdRun = this.store.command(
                    dispatchId,
                    { scheduleId: current.id, dueAt: current.nextDueAt, captureHash: current.captureHash },
                    () => {
                      const template = current.template;
                      const run = this.kernel.createRun(
                        project,
                        template.objective,
                        template.provider,
                        structuredClone(template.contract),
                        template.limits,
                        'task',
                        template.contextPolicy,
                        current.settings.mode === 'review',
                        { kind: 'native' },
                      );
                      return current.settings.mode === 'review' ? this.kernel.action(run.id, 'pause') : run;
                    },
                  );
                  this.store.db.exec('RELEASE schedule_dispatch');
                } catch (error) {
                  this.store.db.exec('ROLLBACK TO schedule_dispatch; RELEASE schedule_dispatch');
                  createdRun = undefined;
                  throw error;
                }
                next = {
                  ...next,
                  createdCount: current.createdCount + 1,
                  lastRunId: createdRun.id,
                  lastDueAt: current.nextDueAt,
                  reason:
                    current.settings.mode === 'review'
                      ? '已创建暂停任务；用户启动后才生成计划'
                      : '已按确认的权限和预算创建自动执行任务',
                };
                if (next.createdCount >= next.settings.maxRuns)
                  next = { ...next, status: 'completed', nextDueAt: null };
              }
            } catch (error) {
              next = {
                ...next,
                status: 'paused',
                nextDueAt: null,
                reason: (error instanceof Error ? error.message : '调度失败，请重新核对').slice(0, 1000),
              };
            }
          }
          latest[index] = next;
          writeSchedules(this.store, projectId, latest);
        });
        if (createdRun && record.settings.mode === 'execute') this.hooks.resume(createdRun.id);
      }
    }
  }
}

export function registerProjectSchedules(
  app: FastifyInstance,
  store: Store,
  kernel: Kernel,
  hooks: SchedulerHooks,
) {
  const scheduler = new ProjectScheduler(store, kernel, hooks);
  const projectId = (params: { id: string }) => z.string().uuid().parse(params.id);
  app.get<{ Params: { id: string } }>('/api/projects/:id/schedules', (request) =>
    scheduler.list(projectId(request.params)),
  );
  app.get<{ Params: { id: string } }>('/api/projects/:id/schedules/preview', (request) => {
    const query = z.object({ sourceRunId: z.string().uuid() }).strict().parse(request.query);
    return scheduler.preview(projectId(request.params), query.sourceRunId);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/schedules', (request) =>
    scheduler.create(projectId(request.params), ProjectScheduleCreate.parse(request.body)),
  );
  app.put<{ Params: { id: string; scheduleId: string } }>(
    '/api/projects/:id/schedules/:scheduleId',
    (request) =>
      scheduler.update(
        projectId(request.params),
        z.string().uuid().parse(request.params.scheduleId),
        ProjectScheduleUpdate.parse(request.body),
      ),
  );
  app.addHook('onClose', async () => scheduler.stop());
  return scheduler;
}
