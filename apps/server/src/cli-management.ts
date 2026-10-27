/**
 * 管理终端 CLI 的安装状态及相关接口。
 * 连接宿主安装器与版本化持久历史，显式检查、取消或应用镜像；安装成功不会自动修改已有任务的冻结镜像和 API 绑定。
 * EN: Manages terminal CLI installation state and endpoints. Connects host installation to revisioned history and explicit check/cancel/apply actions; installation never automatically changes existing run images or API bindings.
 */
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
import { terminalSettings, writeTerminalProfileImage } from './terminal-settings.js';
import { terminalCliInstallFailure } from '../../../packages/contracts/src/cli-installation.js';

const jobsKey = 'surface:terminal:control:installations:v1';
const version = z
  .string()
  .max(80)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/);
type Manager = Pick<DockerCliManager, 'check' | 'install'>;
/**
 * 管理终端 CLI 检测和安装任务，并跟踪可取消的在途操作。
 * EN: Manages CLI inspection and installation jobs while tracking abortable in-flight operations.
 */
export class TerminalCliManagement {
  private closed = false;
  private readonly checks = new Set<AbortController>();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  /**
   * 绑定持久存储和 CLI 管理器；将上次进程留下的 running 安装改为中断失败，避免误报仍在安装。
   * EN: Binds storage and CLI manager and marks persisted running jobs interrupted so a restart cannot report phantom active installations.
   */
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
  /**
   * 解析持久安装历史并规范化失败提示；没有记录返回空数组，损坏的保存结构明确抛错。
   * EN: Parses stored installation history and normalizes safe failures; absent history returns an empty array while damaged records throw.
   */
  jobs(): TerminalCliInstallationJob[] {
    const row = this.store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(jobsKey) as
      | { value: string }
      | undefined;
    return row
      ? z
          .array(TerminalCliInstallationJob)
          .parse(JSON.parse(row.value))
          .map((job) => {
            if (job.status !== 'failed') return job;
            const failure = terminalCliInstallFailure(job.code, job.message);
            return { ...job, code: failure.code, message: failure.message };
          })
      : [];
  }
  /**
   * 按 ID 查找安装记录；不存在时抛领域错误，调用方不得猜测当前状态。
   * EN: Finds an installation by ID or throws a domain error rather than guessing state.
   */
  job(id: string) {
    const job = this.jobs().find((entry) => entry.id === id);
    invariant(job, 'TERMINAL_CLI_JOB_MISSING', 'CLI 安装记录不存在');
    return job;
  }
  /**
   * 校验筛选与页大小并按保存顺序分页；失效游标抛冲突，防止拼接不同历史。
   * EN: Validates filters/page size and pages stored order; stale cursors throw conflicts to avoid mixing histories.
   */
  history(input: unknown) {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().uuid().optional(),
        appId: TerminalAppId.optional(),
      })
      .strict()
      .parse(input);
    const jobs = this.jobs().filter((job) => !query.appId || job.appId === query.appId);
    const found = query.cursor ? jobs.findIndex((job) => job.id === query.cursor) : -1;
    if (query.cursor && found < 0)
      throw new AppError('TERMINAL_CLI_CURSOR', '安装历史已变化，请重新读取第一页', false, null, 409);
    const start = query.cursor ? found + 1 : 0;
    const items = jobs.slice(start, start + query.limit);
    return {
      items,
      total: jobs.length,
      nextCursor: start + items.length < jobs.length ? items.at(-1)!.id : null,
    };
  }
  /**
   * 保留每个应用遇到的第一条安装记录，返回各 CLI 的最近状态。
   * EN: Returns the first stored installation per app as each CLI's latest state.
   */
  latest() {
    const found = new Set<TerminalAppId>();
    return this.jobs().filter((job) => {
      if (found.has(job.appId)) return false;
      found.add(job.appId);
      return true;
    });
  }
  /**
   * 以稳定 JSON 整体更新安装历史元数据；事务边界由调用方决定。
   * EN: Replaces installation metadata with stable JSON; transaction ownership remains with the caller.
   */
  private write(jobs: TerminalCliInstallationJob[]) {
    this.store.db
      .prepare(
        'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(jobsKey, stable(jobs));
  }
  /**
   * 仅更新仍 running 的指定作业，递增版本并校验结构；关闭或已结束时忽略迟到进度。
   * EN: Updates only a running job, incrementing revision and validating schema; shutdown and finished jobs ignore late progress.
   */
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
  /**
   * 选择与应用匹配的已保存模板或内置预设，校验归属并移除 API 绑定，安装检查不得携带业务凭据。
   * EN: Selects an app-compatible saved template or preset, validates ownership and strips API bindings so installation checks carry no business credentials.
   */
  private profile(appId: TerminalAppId, profileId?: string) {
    const settings = terminalSettings(this.store);
    const selected = profileId
      ? settings.profiles.find((profile) => profile.id === profileId)
      : (settings.profiles.find(
          (profile) => profile.id === settings.defaultProfileId && terminalAppForProfile(profile) === appId,
        ) ?? settings.profiles.find((profile) => terminalAppForProfile(profile) === appId));
    invariant(!profileId || selected, 'TERMINAL_PROFILE_MISSING', '所选终端模板已删除，请刷新后重试');
    const raw = selected ?? terminalAppCatalog().find((entry) => entry.id === appId)!.preset;
    const profile = AgentTerminalProfile.parse(raw);
    invariant(
      terminalAppForProfile(profile) === appId,
      'TERMINAL_PROFILE_APP',
      '模板所属 CLI 与所选应用不一致，请重新选择',
    );
    /**
     * 检测和安装只接收可执行程序元数据，不需要API绑定或密钥引用。
     * EN: Check/install receive only executable metadata. No API bindings or key references are needed.
     */
    const { connection: _binding, connectionId: _selection, ...safe } = profile;
    return { profile: AgentTerminalProfile.parse(safe), profileId: selected?.id ?? null };
  }
  /**
   * 检查指定应用和可选配置；服务关闭时拒绝新检测。
   * EN: Checks an application and optional profile, rejecting new inspection after shutdown.
   */
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
  /**
   * 在幂等命令中创建安装作业后异步执行；同 commandId 重试返回该作业的最新状态。 只允许一个安装/收尾同时进行，安装成功不自动修改模板，需用户另行应用。
   * EN: Creates an installation job idempotently, then runs it asynchronously. Repeated command IDs resolve the latest job state. Only one install/finalization may run; successful installation does not edit templates until the user applies it.
   */
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
      if (this.active.size || jobs.some((entry) => entry.status === 'running'))
        throw new AppError('TERMINAL_CLI_BUSY', '已有 CLI 镜像正在安装或收尾，请等待完成', false, null, 409);
      const created = TerminalCliInstallationJob.parse({
        id: body.commandId,
        revision: 0,
        appId,
        profileId,
        baseImage: profile.image,
        ...(body.version ? { requestedVersion: body.version } : {}),
        status: 'running',
        phase: 'queued',
        phaseStartedAt: now(),
        message: '正在安装 CLI 镜像',
        createdAt: now(),
        updatedAt: now(),
      });
      /**
       * 保留小型元数据，使重放命令能解析到其最终状态。
       * EN: Retain small metadata records so replayed commands can resolve their final status.
       */
      this.write([created, ...jobs]);
      return created;
    });
    this.start(job);
    return job;
  }
  /**
   * 在幂等命令内核对版本并保存 cancelled，再中止宿主安装；结束任务拒绝取消，已取消状态可重放。
   * EN: Revision-checks and persists cancellation idempotently before aborting host work; finished jobs reject cancellation and cancelled results can replay.
   */
  cancel(rawId: string, input: unknown, route: string) {
    const id = z.string().uuid().parse(rawId);
    const body = Command.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(input);
    const cancelled = this.store.command(body.commandId, { route, id, body }, () => {
      invariant(!this.closed, 'TERMINAL_CLI_CLOSED', '服务正在退出，请稍后重试');
      const current = this.job(id);
      if (body.expectedRevision !== current.revision)
        throw new AppError(
          'REVISION_CONFLICT',
          '安装状态已更新，请刷新后重试',
          false,
          { currentRevision: current.revision },
          409,
        );
      if (current.status === 'cancelled') return current;
      if (current.status !== 'running')
        throw new AppError('TERMINAL_CLI_NOT_RUNNING', '该安装已结束，无法取消', false, null, 409);
      const next = TerminalCliInstallationJob.parse({
        ...current,
        revision: current.revision + 1,
        status: 'cancelled',
        code: 'TERMINAL_CLI_CANCELLED',
        message: '安装已取消，镜像不会应用于模板',
        updatedAt: now(),
      });
      this.write(this.jobs().map((job) => (job.id === id ? next : job)));
      return next;
    });
    /**
     * 先提交界面可见的取消，再中止进程；迟到结果 不能再修改已取消作业，活动槽仍保持占用， 直到管理器完成清理。
     * EN: Commit the visible cancellation before aborting the process. A late result can no longer change a cancelled job, and the active slot stays occupied until the manager has finished cleaning up.
     */
    this.active.get(id)?.controller.abort();
    return cancelled;
  }
  /**
   * 将所选成功安装的镜像应用到模板，具体资格和并发检查由 applyImage 统一执行。
   * EN: Applies a successful installation image to a template through shared applyImage eligibility/concurrency checks.
   */
  apply(rawId: string, input: unknown, route: string) {
    return this.applyImage(rawId, input, route, false);
  }
  /**
   * 通过 applyImage 的恢复模式切回已记录镜像，复用相同命令和版本校验。
   * EN: Restores a recorded image through applyImage's restore mode with the same command/revision checks.
   */
  restore(rawId: string, input: unknown, route: string) {
    return this.applyImage(rawId, input, route, true);
  }
  /**
   * 将完成作业的固定镜像写回原模板；核对模板版本、CLI 类型和当前镜像，拒绝覆盖并发编辑。
   * EN: Applies a completed job's pinned image to its original template, checking revision, CLI type, and current image to reject concurrent edits.
   */
  private applyImage(rawId: string, input: unknown, route: string, restore: boolean) {
    const id = z.string().uuid().parse(rawId);
    const body = Command.extend({
      profileId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
      ...(restore ? { expectedImage: AgentTerminalProfile.shape.image } : {}),
    })
      .strict()
      .parse(input);
    return this.store.command(body.commandId, { route, id, body }, () => {
      invariant(!this.closed, 'TERMINAL_CLI_CLOSED', '服务正在退出，请稍后重试');
      const job = this.job(id);
      if (job.status !== 'completed' || !job.result)
        throw new AppError('TERMINAL_CLI_NOT_COMPLETED', '请等待安装成功后再应用镜像', false, null, 409);
      if (job.profileId !== null && body.profileId !== job.profileId)
        throw new AppError('TERMINAL_CLI_PROFILE_TARGET', '请应用于安装时选定的原模板', false, null, 409);
      const settings = terminalSettings(this.store);
      const profile = settings.profiles.find((entry) => entry.id === body.profileId);
      if (!profile)
        throw new AppError('TERMINAL_PROFILE_MISSING', '原终端模板已删除，请重新安装', false, null, 409);
      if (terminalAppForProfile(profile) !== job.appId)
        throw new AppError('TERMINAL_PROFILE_APP', '终端模板的 CLI 已改变，请重新安装', false, null, 409);
      if (
        restore
          ? profile.image !== (body as typeof body & { expectedImage: string }).expectedImage
          : profile.image !== job.baseImage && profile.image !== job.result.image
      )
        throw new AppError(
          'TERMINAL_CLI_IMAGE_CONFLICT',
          restore ? '当前镜像已变化，请刷新后确认恢复' : '终端模板镜像已改变，请基于新镜像重新安装',
          false,
          null,
          409,
        );
      return writeTerminalProfileImage(this.store, {
        expectedRevision: body.expectedRevision,
        profileId: profile.id,
        image: job.result.image,
      });
    });
  }
  /**
   * 安装 Promise 生命周期拥有活动槽，取消可先显示，但必须等管理器清理结束后才删除 active。
   * EN: The installation promise owns its active slot: cancellation may display first, but active is removed only after manager cleanup finishes.
   */
  private start(job: TerminalCliInstallationJob) {
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        const result = await this.manager.install(
          { appId: job.appId, baseImage: job.baseImage, version: job.requestedVersion },
          controller.signal,
          (phase) => {
            if (!controller.signal.aborted) this.update(job.id, { phase, phaseStartedAt: now() });
          },
        );
        controller.signal.throwIfAborted();
        this.update(job.id, {
          status: 'completed',
          result: TerminalCliInstallationJob.shape.result.unwrap().parse(result),
          message: 'CLI 镜像已安装，保存模板后供新任务使用',
        });
      } catch (error) {
        const failure = terminalCliInstallFailure(
          controller.signal.aborted
            ? 'TERMINAL_CLI_INTERRUPTED'
            : error instanceof AppError
              ? error.code
              : undefined,
          error instanceof AppError ? error.details : undefined,
        );
        this.update(job.id, {
          status: 'failed',
          code: failure.code,
          message: failure.message,
        });
      } finally {
        this.active.delete(job.id);
      }
    });
    this.active.set(job.id, { controller, promise });
  }
  /**
   * 拒绝新安装、取消探测和安装并持久标记中断；最多等待三秒收束宿主作业，避免退出无限阻塞。
   * EN: Rejects new work, cancels checks/installations and persists interruption, waiting at most three seconds for host work to settle.
   */
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
/**
 * 注册 CLI 检查、安装、历史及镜像应用接口；参数在边界校验，服务关闭时释放管理器活动工作。
 * EN: Registers CLI check/install/history/image routes with boundary validation and lifecycle cleanup of active management work.
 */
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
  app.get(root + '/installations', (request) => {
    const query = request.query as Record<string, unknown>;
    if (query.latest !== undefined) {
      z.object({ latest: z.literal('true') })
        .strict()
        .parse(query);
      return management.latest();
    }
    return Object.keys(query).length ? management.history(query) : management.jobs();
  });
  app.get<{ Params: { id: string } }>(root + '/installations/:id', (request) =>
    management.job(z.string().uuid().parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>(root + '/installations/:id/cancel', (request) =>
    management.cancel(request.params.id, request.body, request.url),
  );
  app.post<{ Params: { id: string } }>(root + '/installations/:id/apply', (request) =>
    management.apply(request.params.id, request.body, request.url),
  );
  app.post<{ Params: { id: string } }>(root + '/installations/:id/restore', (request) =>
    management.restore(request.params.id, request.body, request.url),
  );
  app.addHook('onClose', () => management.close());
  return management;
}
