import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentTerminalProfile, AppError, Command, invariant } from '../../../packages/contracts/src/index.js';
import {
  TerminalAppId,
  TerminalCliInstallationJob,
} from '../../../packages/contracts/src/terminal-control.js';
import { type Store, now, stable } from '../../../packages/storage/src/index.js';
import type { DockerCliManager } from '../../../packages/runtime/src/cli-manager.js';
import { terminalAppCatalog, terminalAppForProfile } from './terminal-control.js';
import { terminalSettings } from './terminal-settings.js';

const jobsKey = 'surface:terminal:control:installations:v1';
const version = z
  .string()
  .max(80)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/);
type Manager = Pick<DockerCliManager, 'check' | 'install'>;
export class TerminalCliManagement {
  private closed = false;
  private readonly checks = new Set<AbortController>();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(
    private readonly store: Store,
    private readonly manager: Manager,
  ) {
    const jobs = this.jobs();
    if (jobs.some((job) => job.status === 'running'))
      this.write(
        jobs.map((job) =>
          job.status === 'running'
            ? {
                ...job,
                revision: job.revision + 1,
                status: 'failed',
                code: 'TERMINAL_CLI_INTERRUPTED',
                message: '服务重启中断了安装，请重新安装；不会自动修改任务镜像',
                updatedAt: now(),
              }
            : job,
        ),
      );
  }
  jobs(): TerminalCliInstallationJob[] {
    const row = this.store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(jobsKey) as
      | { value: string }
      | undefined;
    return row ? z.array(TerminalCliInstallationJob).parse(JSON.parse(row.value)) : [];
  }
  job(id: string) {
    const job = this.jobs().find((entry) => entry.id === id);
    invariant(job, 'TERMINAL_CLI_JOB_MISSING', 'CLI 安装记录不存在');
    return job;
  }
  private write(jobs: TerminalCliInstallationJob[]) {
    this.store.db
      .prepare(
        'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(jobsKey, stable(jobs));
  }
  private update(id: string, change: Partial<TerminalCliInstallationJob>) {
    if (this.closed) return;
    this.store.tx(() => {
      const jobs = this.jobs();
      const previous = jobs.find((job) => job.id === id);
      if (!previous || previous.status !== 'running') return;
      const next = TerminalCliInstallationJob.parse({
        ...previous,
        ...change,
        revision: previous.revision + 1,
        updatedAt: now(),
      });
      this.write(jobs.map((job) => (job.id === id ? next : job)));
    });
  }
  private profile(appId: TerminalAppId, profileId?: string) {
    const settings = terminalSettings(this.store);
    const selected = profileId
      ? settings.profiles.find((profile) => profile.id === profileId)
      : settings.profiles.find((profile) => terminalAppForProfile(profile) === appId);
    invariant(!profileId || selected, 'TERMINAL_PROFILE_MISSING', '所选终端模板已删除，请刷新后重试');
    const raw = selected ?? terminalAppCatalog().find((entry) => entry.id === appId)!.preset;
    const profile = AgentTerminalProfile.parse(raw);
    invariant(
      terminalAppForProfile(profile) === appId,
      'TERMINAL_PROFILE_APP',
      '模板所属 CLI 与所选应用不一致，请重新选择',
    );
    // Check/install receive only executable metadata. No API bindings or key references are needed.
    const { connection: _binding, connectionId: _selection, ...safe } = profile;
    return { profile: AgentTerminalProfile.parse(safe), profileId: selected?.id ?? null };
  }
  async check(appId: TerminalAppId, profileId?: string) {
    invariant(!this.closed, 'TERMINAL_CLI_CLOSED', '服务正在退出，请稍后重试');
    const controller = new AbortController();
    this.checks.add(controller);
    try {
      return await this.manager.check(appId, this.profile(appId, profileId).profile, controller.signal);
    } finally {
      this.checks.delete(controller);
    }
  }
  install(rawAppId: string, input: unknown, route: string) {
    const appId = TerminalAppId.parse(rawAppId);
    const body = Command.extend({ profileId: z.string().uuid().optional(), version: version.optional() })
      .strict()
      .parse(input);
    const payload = { route, appId, body };
    if (this.store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId)) {
      const saved = this.store.command<TerminalCliInstallationJob>(body.commandId, payload, () => {
        throw new AppError('COMMAND_MISSING', '命令结果不存在');
      });
      return this.job(saved.id);
    }
    invariant(!this.closed, 'TERMINAL_CLI_CLOSED', '服务正在退出，请稍后重试');
    invariant(
      appId !== 'custom',
      'TERMINAL_CLI_CUSTOM_INSTALL',
      '自定义 CLI 请使用自行构建的镜像，或在模板中配置命令',
    );
    const { profile, profileId } = this.profile(appId, body.profileId);
    const job = this.store.command(body.commandId, payload, () => {
      const jobs = this.jobs();
      if (jobs.some((entry) => entry.status === 'running'))
        throw new AppError('TERMINAL_CLI_BUSY', '已有 CLI 镜像正在安装，请等待完成', false, null, 409);
      const created = TerminalCliInstallationJob.parse({
        id: body.commandId,
        revision: 0,
        appId,
        profileId,
        baseImage: profile.image,
        ...(body.version ? { requestedVersion: body.version } : {}),
        status: 'running',
        message: '正在安装 CLI 镜像',
        createdAt: now(),
        updatedAt: now(),
      });
      // Retain small metadata records so replayed commands can resolve their final status.
      this.write([created, ...jobs]);
      return created;
    });
    this.start(job);
    return job;
  }
  private start(job: TerminalCliInstallationJob) {
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await this.manager.install(
          { appId: job.appId, baseImage: job.baseImage, version: job.requestedVersion },
          controller.signal,
        );
        controller.signal.throwIfAborted();
        this.update(job.id, {
          status: 'completed',
          result: TerminalCliInstallationJob.shape.result.unwrap().parse(result),
          message: 'CLI 镜像已安装，保存模板后供新任务使用',
        });
      } catch (error) {
        this.update(job.id, {
          status: 'failed',
          code: controller.signal.aborted
            ? 'TERMINAL_CLI_INTERRUPTED'
            : error instanceof AppError
              ? error.code
              : 'TERMINAL_CLI_INSTALL',
          message: controller.signal.aborted
            ? '安装已中断，请重新安装'
            : error instanceof AppError
              ? error.message
              : 'CLI 安装未完成，请检查 Docker 和网络后重试',
        });
      } finally {
        this.active.delete(job.id);
      }
    });
    this.active.set(job.id, { controller, promise });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.checks) controller.abort();
    for (const { controller } of this.active.values()) controller.abort();
    const jobs = this.jobs();
    if (jobs.some((job) => job.status === 'running'))
      this.write(
        jobs.map((job) =>
          job.status === 'running'
            ? {
                ...job,
                revision: job.revision + 1,
                status: 'failed',
                code: 'TERMINAL_CLI_INTERRUPTED',
                message: '服务退出中断了安装，请重新安装',
                updatedAt: now(),
              }
            : job,
        ),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.active.values()].map((entry) => entry.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
export function registerCliManagement(app: FastifyInstance, store: Store, manager: Manager) {
  const management = new TerminalCliManagement(store, manager);
  const root = '/api/terminal/control';
  app.post<{ Params: { id: string } }>(root + '/apps/:id/check', (request) => {
    const body = z
      .object({ profileId: z.string().uuid().optional() })
      .strict()
      .parse(request.body ?? {});
    return management.check(TerminalAppId.parse(request.params.id), body.profileId);
  });
  app.post<{ Params: { id: string } }>(root + '/apps/:id/install', (request) =>
    management.install(request.params.id, request.body, request.url),
  );
  app.get(root + '/installations', () => management.jobs());
  app.get<{ Params: { id: string } }>(root + '/installations/:id', (request) =>
    management.job(z.string().uuid().parse(request.params.id)),
  );
  app.addHook('onClose', () => management.close());
  return management;
}
