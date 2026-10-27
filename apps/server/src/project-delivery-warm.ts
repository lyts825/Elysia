/** 注册项目交付数据预热任务。 */
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

/** Project jobs own subscriptions to shared Run work, rather than cancelling another window's reader. */
export function registerProjectDeliveryWarm(
  app: FastifyInstance,
  store: Store,
  sourceFor: (projectId: string) => Source,
) {
  const runs = deliveryArtifactWarmReads(store),
    jobs = new Map<string, Job>();
  let closed = false;
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
  const cancel = (job: Job) => {
    job.controller.abort();
    if (job.child) {
      try {
        runs.cancel(job.child.runId, job.child.jobId, job.session);
      } catch {
        /* Child may already be disposed during shutdown. */
      }
    }
    finish(job, 'cancelled');
  };
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
  const epoch = (runId: string) =>
    (
      store.db.prepare('SELECT token FROM delivery_artifact_warm_epochs_v1 WHERE run_id=?').get(runId) as
        | { token: string }
        | undefined
    )?.token ?? '';
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
