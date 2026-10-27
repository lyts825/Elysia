/**
 * 预热交付物元数据并管理异步读取任务。
 * 提供单运行、会话归属的异步回填作业，使用 epoch 检测扫描变化；只更新派生资料，部分结果不能当完整交付证据。
 * EN: Warms delivery-artifact metadata and manages asynchronous read jobs. Provides session-owned per-run backfill jobs with epoch change detection; modifies derived metadata only and partial scans are not complete evidence.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, invariant, type Run } from '../../../packages/contracts/src/index.js';
import { hash, id, type Store } from '../../../packages/storage/src/index.js';

export type DeliveryArtifactWarmJob = {
  jobId: string;
  runId: string;
  status: 'warming' | 'completed' | 'cancelled' | 'failed';
  scanned: number;
  total: number;
  backfilled: number;
  error?: { code: string; message: string };
};
type Job = {
  view: DeliveryArtifactWarmJob;
  session: string;
  updated: number;
  done: Promise<void>;
  resolve: () => void;
  worker?: Worker;
};
type Worker = {
  runId: string;
  epoch: string;
  controller: AbortController;
  jobs: Set<Job>;
  work?: Promise<void>;
};
const managers = new WeakMap<Store, DeliveryArtifactWarmReads>();

/**
 * 用会话 cookie 的摘要隔离预热订阅，公开作业视图不保存或返回 cookie 原文。
 * EN: Isolates warm subscriptions with a session-cookie digest; public jobs neither store nor return raw cookies.
 */
export const deliveryWarmSession = (request: FastifyRequest) =>
  hash(
    request.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('elysia_session='))
      ?.slice(15) ?? 'internal-reader',
  );

/**
 * 独立调用者共享有界批次工作，取消一个调用不会取消其他订阅者。 管理按运行和会话绑定的交付元数据预热任务及工作进程。
 * EN: Independent callers share bounded batch work. Cancelling one caller never cancels another subscriber. Manages run/session-bound delivery-metadata subscriptions and workers.
 */
export class DeliveryArtifactWarmReads {
  private jobs = new Map<string, Job>();
  private workers = new Map<string, Worker>();
  private draining = new Set<Worker>();
  private closed = false;
  private removeCloseHook: () => void;
  /**
   * 登记存储关闭钩子，并建立产物变化 epoch 表与触发器，使异步预热可以识别扫描期间的数据库变动。
   * EN: Registers close cleanup and creates artifact epoch tables/triggers so asynchronous warming detects mutations during scans.
   */
  constructor(private store: Store) {
    this.removeCloseHook = store.onClose(() => this.stop());
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS delivery_artifact_warm_epochs_v1(run_id TEXT PRIMARY KEY,token TEXT NOT NULL);`,
    );
    /**
     * 为触发器生成指定运行的 epoch 更新 SQL；参数来自内部 NEW/OLD 表达式，不接受外部 SQL。
     * EN: Builds per-run epoch SQL for triggers from internal NEW/OLD expressions, never external SQL input.
     */
    const touch = (run: string) =>
      `INSERT INTO delivery_artifact_warm_epochs_v1 VALUES(${run},lower(hex(randomblob(16)))) ON CONFLICT(run_id) DO UPDATE SET token=excluded.token;`;
    store.db
      .exec(`CREATE TRIGGER IF NOT EXISTS delivery_artifact_warm_insert AFTER INSERT ON artifacts BEGIN ${touch('NEW.run_id')} END;
      CREATE TRIGGER IF NOT EXISTS delivery_artifact_warm_delete AFTER DELETE ON artifacts BEGIN ${touch('OLD.run_id')} END;
      CREATE TRIGGER IF NOT EXISTS delivery_artifact_warm_update AFTER UPDATE ON artifacts
        WHEN NEW.content IS NOT OLD.content OR NEW.run_id IS NOT OLD.run_id OR NEW.revision IS NOT OLD.revision
        BEGIN ${touch('OLD.run_id')} ${touch('NEW.run_id')} END;`);
  }
  /**
   * 读取运行的产物变更令牌；尚无产物变更记录时返回空串。
   * EN: Reads the run's artifact epoch token, returning an empty string when none exists.
   */
  private epoch(runId: string) {
    return (
      (
        this.store.db
          .prepare('SELECT token FROM delivery_artifact_warm_epochs_v1 WHERE run_id=?')
          .get(runId) as { token: string } | undefined
      )?.token ?? ''
    );
  }
  /**
   * 通过轻量索引判断是否仍有待重建产物元数据，不加载产物正文。
   * EN: Checks the lightweight dirty index for pending artifact metadata without loading bodies.
   */
  private dirty(runId: string) {
    return !!this.store.db
      .prepare('SELECT 1 FROM artifact_delivery_metadata_dirty_v1 WHERE run_id=? LIMIT 1')
      .get(runId);
  }
  /**
   * 仅首次终结生效；移除订阅后无调用者的 worker 才可退休，并唤醒等待该 job 的读取者。
   * EN: Only the first terminal transition takes effect. A worker retires only after its last subscriber leaves, and job waiters are notified.
   */
  private finish(
    job: Job,
    status: DeliveryArtifactWarmJob['status'],
    error?: DeliveryArtifactWarmJob['error'],
  ) {
    if (job.view.status !== 'warming') return;
    Object.assign(job.view, { status, ...(error ? { error } : {}) });
    job.updated = Date.now();
    job.worker?.jobs.delete(job);
    if (job.worker && !job.worker.jobs.size) this.retire(job.worker);
    job.resolve();
  }
  /**
   * 取消指定工作者，仅当它仍为当前运行的登记实例时移除，避免旧任务删除新工作者。
   * EN: Cancels a worker and removes it only if still current for that run, preventing an old task from removing its successor.
   */
  private retire(worker: Worker) {
    worker.controller.abort();
    if (this.workers.get(worker.runId) === worker) this.workers.delete(worker.runId);
  }
  /**
   * 淘汰结束超过两分钟的进程内作业视图，保留仍在 warming 的任务。
   * EN: Evicts completed in-memory job views older than two minutes while retaining active warming jobs.
   */
  private prune() {
    for (const [key, job] of this.jobs)
      if (job.view.status !== 'warming' && Date.now() - job.updated > 120_000) this.jobs.delete(key);
  }
  /**
   * jobId 必须同时匹配运行和会话，不能凭猜到的作业 ID 读取或取消其他窗口的工作。
   * EN: Job IDs must match both run and session; guessing an ID cannot expose or cancel another window's work.
   */
  private bound(runId: string, jobId: string, session: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.view.runId !== runId || job.session !== session)
      throw new AppError(
        'DELIVERY_WARM_GONE',
        '回填作业已结束或不属于当前会话，请重新读取',
        false,
        null,
        410,
      );
    return job;
  }
  /**
   * 返回订阅副本；未指定 ID 时仅查当前会话，缺失时反映队列是否仍有待处理记录。
   * EN: Returns a subscription copy; without an ID, checks only this session and reports remaining dirty records when no subscription exists.
   */
  view(runId: string, session: string, jobId?: string) {
    this.prune();
    const job = jobId
      ? this.bound(runId, jobId, session)
      : [...this.jobs.values()].reverse().find((j) => j.view.runId === runId && j.session === session);
    return job
      ? structuredClone(job.view)
      : {
          runId,
          jobId: null,
          status: this.dirty(runId) ? 'pending' : 'completed',
          scanned: 0,
          total: 0,
          backfilled: 0,
        };
  }
  /**
   * 幂等创建会话订阅；同运行共享有界回填 worker，不同调用者保留各自取消身份。 限制保留作业数和同时工作的运行数；无脏记录时立即完成，不启动后台循环。
   * EN: Creates a session subscription idempotently while run-level workers share bounded backfill work. Callers retain separate cancellation identity. Retained jobs and concurrent runs are capped; no dirty records means immediate completion without a background loop.
   */
  start(runId: string, jobId: string, session: string) {
    if (this.closed) throw new AppError('DELIVERY_WARM_CLOSED', '读取服务已关闭', true, null, 503);
    const run = this.store.require<Run>('runs', runId);
    invariant(
      (run.execution?.kind ?? 'native') === 'native',
      'DELIVERY_SURFACE',
      '交付读取预热仅支持原生任务',
    );
    this.prune();
    if (this.jobs.has(jobId)) return this.bound(runId, jobId, session);
    if (this.jobs.size >= 64) {
      const terminal = [...this.jobs.values()].find((job) => job.view.status !== 'warming');
      if (terminal) this.jobs.delete(terminal.view.jobId);
    }
    if (this.jobs.size >= 64 || (this.dirty(runId) && !this.workers.has(runId) && this.workers.size >= 2))
      throw new AppError('DELIVERY_WARM_BUSY', '正在准备其他交付读取，请稍后重试', true, null, 429);
    let resolve!: () => void;
    const total = Number(
      this.store.db.prepare('SELECT COUNT(*) n FROM artifacts WHERE run_id=?').get(runId)!.n,
    );
    const job: Job = {
      view: { jobId, runId, status: 'warming', scanned: 0, total, backfilled: 0 },
      session,
      updated: Date.now(),
      done: new Promise<void>((r) => (resolve = r)),
      /**
       * 完成工作者等待承诺，供关闭与重启等待其实际收束。
       * EN: Resolves the worker completion promise used by shutdown/replacement waits.
       */
      resolve: () => resolve(),
    };
    this.jobs.set(jobId, job);
    if (!this.dirty(runId)) {
      job.view.scanned = total;
      this.finish(job, 'completed');
      return job;
    }
    let worker = this.workers.get(runId);
    if (!worker || worker.controller.signal.aborted) {
      worker = { runId, epoch: this.epoch(runId), controller: new AbortController(), jobs: new Set() };
      this.workers.set(runId, worker);
    }
    worker.jobs.add(job);
    job.worker = worker;
    if (!worker.work) {
      const target = worker;
      this.draining.add(target);
      target.work = this.drain(target).finally(() => {
        this.retire(target);
        this.draining.delete(target);
      });
    }
    return job;
  }
  /**
   * 只取消选定订阅；仍有其他订阅者时不会停止共享 worker。
   * EN: Cancels only the selected subscription; other subscribers keep the shared worker alive.
   */
  cancel(runId: string, jobId: string, session: string) {
    const job = this.bound(runId, jobId, session);
    this.finish(job, 'cancelled');
    return structuredClone(job.view);
  }
  /**
   * 终结作业可主动从保留集合移除，活动作业必须先走取消或完成流程。
   * EN: Terminal jobs may leave the retained set; active jobs must first finish or cancel.
   */
  release(runId: string, jobId: string, session: string) {
    const job = this.bound(runId, jobId, session);
    if (job.view.status !== 'warming') this.jobs.delete(jobId);
  }
  /**
   * 分批提交回填并在批次间让出事件循环；前后都核对产物 epoch，变更后拒绝混合结果。 根据批次耗时在 32/64 条间调整工作量，五分钟未收束或不可读时向各订阅报告失败。
   * EN: Commits backfill in yielding batches and checks artifact epochs before and after work, rejecting mixed generations. Batch cost adjusts work between 32 and 64 entries; unreadability or a five-minute deadline fails subscribers explicitly.
   */
  private async drain(worker: Worker) {
    const timer = setTimeout(() => worker.controller.abort(), 300_000);
    timer.unref();
    let limit = 32;
    try {
      for (;;) {
        worker.controller.signal.throwIfAborted();
        if (this.epoch(worker.runId) !== worker.epoch)
          throw new AppError('DELIVERY_CHANGED', '交付内容在回填期间已变化，请重新读取', true, null, 409);
        const batchStarted = performance.now();
        const result = this.store.artifactDeliveryWarmBatch(worker.runId, limit);
        const batchMs = performance.now() - batchStarted;
        /**
         * 低耗时批次减少短事务数量；大批次耗时增长时退回较小批次。
         * EN: Fewer short commits when batches are cheap; back off when a larger batch runs long.
         */
        if (limit === 32 && batchMs < 5) limit = 64;
        else if (limit === 64 && batchMs > 10) limit = 32;
        for (const job of worker.jobs)
          Object.assign(job.view, {
            total: result.total,
            scanned: result.total - result.remaining,
            backfilled: job.view.backfilled + result.backfilled,
          });
        const complete = this.store.tx(() => {
          if (this.epoch(worker.runId) !== worker.epoch)
            throw new AppError('DELIVERY_CHANGED', '交付内容在回填期间已变化，请重新读取', true, null, 409);
          return !this.dirty(worker.runId);
        });
        if (complete) {
          this.retire(worker);
          for (const job of [...worker.jobs]) this.finish(job, 'completed');
          return;
        }
        await new Promise<void>((r) => setImmediate(r));
      }
    } catch (error) {
      const issue =
        error instanceof AppError
          ? { code: error.code, message: error.message }
          : {
              code: worker.controller.signal.aborted ? 'DELIVERY_WARM_CANCELLED' : 'DELIVERY_UNREADABLE',
              message: worker.controller.signal.aborted
                ? '交付回填已停止，请重新读取'
                : '交付产物暂时无法读取，请修复记录后重试',
            };
      this.retire(worker);
      for (const job of [...worker.jobs]) this.finish(job, 'failed', issue);
    } finally {
      clearTimeout(timer);
      worker.controller.abort();
    }
  }
  /**
   * 等待自己的订阅完成；signal 取消只释放本调用，完成前的错误不执行后续正式读取。
   * EN: Waits for this subscription only. Abort releases this caller, and pre-completion failures prevent the authoritative read afterward.
   */
  async warm(runId: string, signal?: AbortSignal, session = hash('internal-reader')) {
    signal?.throwIfAborted();
    if (this.closed) throw new AppError('DELIVERY_WARM_CLOSED', '读取服务已关闭', true, null, 503);
    if (!this.dirty(runId)) return;
    const job = this.start(runId, id(), session);
    /**
     * 将请求取消映射到当前会话自己的预热作业取消，不越过 session 归属。
     * EN: Maps request cancellation to its session-owned warm job without bypassing session ownership.
     */
    const abort = () => this.cancel(runId, job.view.jobId, session);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      await job.done;
      signal?.throwIfAborted();
      if (job.view.status !== 'completed')
        throw new AppError(
          job.view.error?.code ?? 'DELIVERY_WARM_CANCELLED',
          job.view.error?.message ?? '本次回填已取消，请重新读取',
          true,
          null,
          job.view.error?.code === 'DELIVERY_CHANGED' ? 409 : 422,
        );
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  /**
   * 停止接入并取消订阅，等全部在途 worker 收束后移除存储关闭钩子。
   * EN: Stops new subscriptions, cancels existing ones, and waits for workers before removing the Store close hook.
   */
  async close() {
    this.stop();
    await Promise.allSettled([...this.draining].map((w) => w.work));
    this.jobs.clear();
    this.removeCloseHook();
  }
  /**
   * 关闭预热入口，取消所有排空中的工作者，并将剩余作业视图标为取消。
   * EN: Closes warming admission, cancels draining workers and marks remaining job views cancelled.
   */
  private stop() {
    this.closed = true;
    for (const worker of this.draining) this.retire(worker);
    for (const job of this.jobs.values()) this.finish(job, 'cancelled');
  }
}
/**
 * 为同一个 Store 复用交付元数据预热管理器。
 * EN: Reuses one delivery-metadata warm manager for each Store.
 */
export function deliveryArtifactWarmReads(store: Store) {
  let manager = managers.get(store);
  if (!manager) {
    manager = new DeliveryArtifactWarmReads(store);
    managers.set(store, manager);
  }
  return manager;
}
/**
 * 调用单 Store 管理器的等待接口，供交付读取入口复用。
 * EN: Delegates delivery reads to the single-Store warm manager's wait operation.
 */
export function warmDeliveryMetadata(store: Store, runId: string, signal?: AbortSignal, session?: string) {
  return deliveryArtifactWarmReads(store).warm(runId, signal, session);
}

/**
 * 将 HTTP 断连绑定到本读取者的预热取消，逐个准备运行后执行同步 read 回调。 allowUnreadable 仅容许特定不可读问题交给回调自行降级，版本冲突及其他错误仍向上传递。
 * EN: Binds HTTP disconnect to this reader's cancellation, prepares runs sequentially, then invokes synchronous read. allowUnreadable lets only specific unreadability reach the callback for degradation; version conflicts and other errors still propagate.
 */
export async function withWarmDeliveryMetadata<T>(
  store: Store,
  runId: string | string[],
  request: FastifyRequest,
  reply: FastifyReply,
  read: () => T,
  allowUnreadable = false,
) {
  const controller = new AbortController(),
    /**
     * 中止本 HTTP 请求关联的只读预热信号。
     * EN: Aborts the read-only warming signal associated with this HTTP request.
     */
    abort = () => controller.abort(),
    /**
     * 响应提前关闭才触发取消，正常写完不误取消已交付结果。
     * EN: Cancels only on premature response closure, preserving normally delivered results.
     */
    close = () => {
      if (!reply.raw.writableEnded) abort();
    };
  request.raw.once('aborted', abort);
  reply.raw.once('close', close);
  try {
    if (request.raw.aborted) abort();
    for (const key of typeof runId === 'string' ? [runId] : runId) {
      try {
        await warmDeliveryMetadata(store, key, controller.signal, deliveryWarmSession(request));
      } catch (error) {
        if (!allowUnreadable || !(error instanceof AppError) || error.code !== 'DELIVERY_UNREADABLE')
          throw error;
      }
    }
    controller.signal.throwIfAborted();
    return read();
  } finally {
    request.raw.off('aborted', abort);
    reply.raw.off('close', close);
  }
}
/**
 * 注册会话绑定的创建/查询/取消接口；服务器关闭时等待管理器释放，避免遗留回填工作。
 * EN: Registers session-bound create, query, and cancel routes. Server shutdown awaits manager disposal to avoid orphaned backfill work.
 */
export function registerDeliveryArtifactWarm(app: FastifyInstance, store: Store) {
  const manager = deliveryArtifactWarmReads(store);
  app.addHook('onClose', async () => {
    await manager.close();
    if (managers.get(store) === manager) managers.delete(store);
  });
  const root = '/api/runs/:id/delivery/artifact-warm';
  app.post<{ Params: { id: string } }>(root, (request, reply) => {
    z.object({}).strict().parse(request.query);
    const body = z.object({ jobId: z.string().uuid() }).strict().parse(request.body);
    const job = manager.start(request.params.id, body.jobId, deliveryWarmSession(request));
    return reply.status(202).send(structuredClone(job.view));
  });
  app.get<{ Params: { id: string; jobId?: string } }>(root + '/:jobId', (request) => {
    z.object({}).strict().parse(request.query);
    z.string().uuid().parse(request.params.jobId);
    return manager.view(request.params.id, deliveryWarmSession(request), request.params.jobId);
  });
  app.get<{ Params: { id: string } }>(root, (request) => {
    z.object({}).strict().parse(request.query);
    store.require<Run>('runs', request.params.id);
    return manager.view(request.params.id, deliveryWarmSession(request));
  });
  app.delete<{ Params: { id: string; jobId: string } }>(root + '/:jobId', (request) => {
    z.object({}).strict().parse(request.query);
    z.object({}).strict().parse(request.body);
    z.string().uuid().parse(request.params.jobId);
    return manager.cancel(request.params.id, request.params.jobId, deliveryWarmSession(request));
  });
}
