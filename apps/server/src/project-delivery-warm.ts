/**
 * 注册项目交付数据预热任务。
 * 串联项目内运行级回填并累积会话作业进度；子运行仍独立核验 epoch 与可读性，累计进度不代表项目已完整可验收。
 * EN: Registers project-delivery warm-up jobs. Chains per-run project backfills with session progress while retaining child epoch/readability checks; aggregate progress does not establish complete acceptance.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, type Run } from '../../../packages/contracts/src/index.js';
import { id, type Store } from '../../../packages/storage/src/index.js';
import {
  deliveryArtifactWarmReads,
  deliveryWarmSession,
  type DeliveryArtifactWarmJob,
} from './delivery-artifact-warm.js';

export type ProjectDeliveryWarmJob = {
  projectId: string;
  jobId: string;
  status: DeliveryArtifactWarmJob['status'];
  scanned: number;
  total: number;
  backfilled: number;
  completedRuns: number;
  totalRuns: number;
  unavailableRuns: number;
  currentRunId?: string;
  error?: { code: string; message: string };
};
type Source = { version: string; runs: string[] };
type Job = {
  view: ProjectDeliveryWarmJob;
  session: string;
  source: Source;
  epochs: string[];
  updated: number;
  controller: AbortController;
  child?: { runId: string; jobId: string };
  work?: Promise<void>;
};

/**
 * 项目作业拥有共享运行工作的订阅，不取消其他窗口读取。 项目预热作业绑定工作台来源版本、各运行 epoch 和会话，只持有共享运行读取的订阅。 取消一个项目作业只撤销其子订阅，不中止其他窗口的读取；定义/产物变化使旧作业失效。
 * EN: Project jobs own subscriptions to shared Run work, rather than cancelling another window's reader. Binds project warming to workbench source revision, run epochs, and session while holding subscriptions only. Cancelling a project job releases its children without stopping other windows; definition/artifact changes invalidate old jobs.
 */
export function registerProjectDeliveryWarm(
  app: FastifyInstance,
  store: Store,
  sourceFor: (projectId: string) => Source,
) {
  const runs = deliveryArtifactWarmReads(store),
    jobs = new Map<string, Job>();
  let closed = false;
  /**
   * 按项目、作业 ID 和会话验证预热归属；不存在或跨会话访问统一返回 410。
   * EN: Validates project/job/session warming ownership and returns uniform 410 for missing or foreign jobs.
   */
  const bound = (projectId: string, jobId: string, session: string) => {
    const job = jobs.get(jobId);
    if (!job || job.view.projectId !== projectId || job.session !== session)
      throw new AppError(
        'DELIVERY_WARM_GONE',
        '回填作业已结束或不属于当前会话，请重新读取',
        false,
        null,
        410,
      );
    return job;
  };
  /**
   * 仅结算 warming 作业，设置终态/可选错误、移除当前运行并更新时间，避免重复收尾覆盖结果。
   * EN: Settles warming jobs only, recording terminal state/error, clearing current run and updating time without overwriting settled results.
   */
  const finish = (
    job: Job,
    status: ProjectDeliveryWarmJob['status'],
    error?: ProjectDeliveryWarmJob['error'],
  ) => {
    if (job.view.status !== 'warming') return;
    Object.assign(job.view, { status, ...(error ? { error } : {}) });
    delete job.view.currentRunId;
    job.updated = Date.now();
  };
  /**
   * 中止项目预热及其当前运行子作业，再标记取消；关闭期间子作业已释放可忽略。
   * EN: Aborts project warming and its current run child, then marks cancelled; already disposed children during shutdown are tolerated.
   */
  const cancel = (job: Job) => {
    job.controller.abort();
    if (job.child) {
      try {
        runs.cancel(job.child.runId, job.child.jobId, job.session);
      } catch {
        /**
         * 关闭期间子订阅可能已经释放。
         * EN: Child may already be disposed during shutdown.
         */
      }
    }
    finish(job, 'cancelled');
  };
  /**
   * 关闭入口并取消所有进程内项目预热作业，供 Store 生命周期收尾。
   * EN: Closes admission and cancels all in-memory project warm jobs during Store shutdown.
   */
  const stop = () => {
    closed = true;
    for (const job of jobs.values()) cancel(job);
  };
  const removeCloseHook = store.onClose(stop);
  app.addHook('onClose', async () => {
    stop();
    await Promise.allSettled([...jobs.values()].map((job) => job.work));
    jobs.clear();
    removeCloseHook();
  });
  /**
   * 每轮和等待后都核对来源集合及正文 epoch，避免把旧候选的预热完成结果套到新工作台。
   * EN: Rechecks source sets and body epochs each round and after waiting, preventing old-candidate completion from being applied to a new workbench.
   */
  const requireCurrent = (job: Job) => {
    job.controller.signal.throwIfAborted();
    if (
      store.tx(
        () =>
          sourceFor(job.view.projectId).version !== job.source.version ||
          job.source.runs.some((runId, index) => epoch(runId) !== job.epochs[index]),
      )
    )
      throw new AppError('DELIVERY_CHANGED', '项目交付定义在准备期间已变化，请重新读取', true, null, 409);
  };
  /**
   * 读取运行产物 epoch，缺失返回空串，用于检测预热期间的产物变化。
   * EN: Reads artifact epoch, defaulting to empty, to detect changes during warming.
   */
  const epoch = (runId: string) =>
    (
      store.db.prepare('SELECT token FROM delivery_artifact_warm_epochs_v1 WHERE run_id=?').get(runId) as
        | { token: string }
        | undefined
    )?.token ?? '';
  /**
   * 只对同项目原生任务统计产物数；运行损坏、缺失或范围不符返回 null，不猜为零。
   * EN: Counts artifacts only for same-project native tasks; missing/damaged/out-of-scope runs return null rather than guessed zero.
   */
  const countFor = (projectId: string, runId: string) => {
    try {
      const run = store.require<Run>('runs', runId);
      if (
        run.projectId !== projectId ||
        run.kind !== 'task' ||
        (run.execution?.kind ?? 'native') !== 'native'
      )
        return null;
      return Number(store.db.prepare('SELECT COUNT(*) n FROM artifacts WHERE run_id=?').get(runId)!.n);
    } catch {
      return null;
    }
  };
  /**
   * 逐运行推进并聚合进度；不可读运行计入 unavailableRuns，而非把项目结果误报全部可读。
   * EN: Advances per run and aggregates progress; unreadable runs increment unavailableRuns rather than falsely reporting complete readability.
   */
  const drain = async (job: Job) => {
    const timeout = setTimeout(() => cancel(job), 300_000);
    timeout.unref();
    try {
      for (const runId of job.source.runs) {
        requireCurrent(job);
        if (countFor(job.view.projectId, runId) === null) {
          job.view.unavailableRuns++;
          job.view.completedRuns++;
          continue;
        }
        job.view.currentRunId = runId;
        const child = runs.start(runId, id(), job.session);
        job.child = { runId, jobId: child.view.jobId };
        const scanned = job.view.scanned,
          backfilled = job.view.backfilled;
        /**
         * 将当前子作业的扫描/回填数叠加到此前完成运行计数，更新项目公开进度。
         * EN: Adds current child scan/backfill counts to completed-run totals for public project progress.
         */
        const progress = () => {
          job.view.scanned = scanned + child.view.scanned;
          job.view.backfilled = backfilled + child.view.backfilled;
        };
        const timer = setInterval(progress, 25);
        timer.unref();
        try {
          progress();
          await child.done;
          progress();
          requireCurrent(job);
          if (child.view.status !== 'completed') {
            if (child.view.error?.code === 'DELIVERY_UNREADABLE') job.view.unavailableRuns++;
            else
              throw new AppError(
                child.view.error?.code ?? 'DELIVERY_WARM_CANCELLED',
                child.view.error?.message ?? '本次读取准备已取消，请重新读取',
                true,
                null,
                child.view.error?.code === 'DELIVERY_CHANGED' ? 409 : 422,
              );
          }
          job.view.completedRuns++;
        } finally {
          clearInterval(timer);
          runs.release(runId, child.view.jobId, job.session);
          delete job.child;
        }
      }
      requireCurrent(job);
      finish(job, 'completed');
    } catch (error) {
      if (job.controller.signal.aborted) finish(job, 'cancelled');
      else
        finish(
          job,
          'failed',
          error instanceof AppError
            ? { code: error.code, message: error.message }
            : { code: 'PROJECT_DELIVERY_UNREADABLE', message: '项目交付定义暂时无法读取，请修复记录后重试' },
        );
    } finally {
      clearTimeout(timeout);
    }
  };
  /**
   * 清除结束超过两分钟的进程内项目作业，保留活动 warming 作业。
   * EN: Prunes completed project jobs older than two minutes while retaining active warming jobs.
   */
  const prune = () => {
    for (const [key, job] of jobs)
      if (job.view.status !== 'warming' && Date.now() - job.updated > 120_000) jobs.delete(key);
  };
  const root = '/api/projects/:id/delivery/artifact-warm';
  app.post<{ Params: { id: string } }>(root, (request, reply) => {
    z.object({}).strict().parse(request.query);
    const { jobId } = z.object({ jobId: z.string().uuid() }).strict().parse(request.body),
      session = deliveryWarmSession(request);
    if (closed) throw new AppError('DELIVERY_WARM_CLOSED', '读取服务已关闭', true, null, 503);
    prune();
    if (jobs.has(jobId))
      return reply.status(202).send(structuredClone(bound(request.params.id, jobId, session).view));
    if (jobs.size >= 64) {
      const terminal = [...jobs.values()].find((job) => job.view.status !== 'warming');
      if (terminal) jobs.delete(terminal.view.jobId);
    }
    if (jobs.size >= 64)
      throw new AppError('DELIVERY_WARM_BUSY', '正在准备其他项目读取，请稍后重试', true, null, 429);
    const { source, total, epochs, needsWarm, unavailableRuns } = store.tx(() => {
      const source = sourceFor(request.params.id);
      let total = 0,
        needsWarm = false,
        unavailableRuns = 0;
      for (const runId of source.runs) {
        const count = countFor(request.params.id, runId);
        if (count === null) {
          unavailableRuns++;
          continue;
        }
        total += count;
        needsWarm ||= !!store.db
          .prepare('SELECT 1 FROM artifact_delivery_metadata_dirty_v1 WHERE run_id=? LIMIT 1')
          .get(runId);
      }
      return {
        source,
        total,
        epochs: source.runs.map(epoch),
        needsWarm,
        unavailableRuns,
      };
    });
    if (needsWarm && [...jobs.values()].filter((job) => job.view.status === 'warming').length >= 2)
      throw new AppError('DELIVERY_WARM_BUSY', '正在准备其他项目读取，请稍后重试', true, null, 429);
    const job: Job = {
      view: {
        projectId: request.params.id,
        jobId,
        status: needsWarm ? 'warming' : 'completed',
        scanned: needsWarm ? 0 : total,
        total,
        backfilled: 0,
        completedRuns: needsWarm ? 0 : source.runs.length,
        totalRuns: source.runs.length,
        unavailableRuns: needsWarm ? 0 : unavailableRuns,
      },
      session,
      source,
      epochs,
      updated: Date.now(),
      controller: new AbortController(),
    };
    jobs.set(jobId, job);
    if (needsWarm) job.work = drain(job);
    return reply.status(202).send(structuredClone(job.view));
  });
  app.get<{ Params: { id: string; jobId: string } }>(root + '/:jobId', (request) => {
    z.object({}).strict().parse(request.query);
    z.string().uuid().parse(request.params.jobId);
    prune();
    return structuredClone(bound(request.params.id, request.params.jobId, deliveryWarmSession(request)).view);
  });
  app.delete<{ Params: { id: string; jobId: string } }>(root + '/:jobId', (request) => {
    z.object({}).strict().parse(request.query);
    z.object({}).strict().parse(request.body);
    z.string().uuid().parse(request.params.jobId);
    const job = bound(request.params.id, request.params.jobId, deliveryWarmSession(request));
    cancel(job);
    return structuredClone(job.view);
  });
}
