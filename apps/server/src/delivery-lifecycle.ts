import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, invariant, type Run, type Task } from '../../../packages/contracts/src/index.js';
import {
  DeliveryReviewInput,
  type DeliveryReviewState,
  type DeliveryUserReview,
  type RunLineage,
  type RunRevisions,
  type RunSourceSnapshot,
} from '../../../packages/contracts/src/workflow.js';
import { now, type Store } from '../../../packages/storage/src/index.js';
import { deliveryFingerprint } from './delivery-fingerprint.js';
import { deliveryReviewReads } from './delivery-summary.js';
export { deliveryFingerprint } from './delivery-fingerprint.js';

const isNative = (run: Run) => (run.execution?.kind ?? 'native') === 'native';
function nativeRun(store: Store, runId: string) {
  const run = store.require<Run>('runs', runId);
  invariant(isNative(run), 'DELIVERY_SURFACE', '交付复核和修订查询仅支持原生任务');
  return run;
}
function revision(expected: number, actual: number) {
  if (expected !== actual)
    throw new AppError(
      'REVISION_CONFLICT',
      '交付记录已更新，请重新读取后确认',
      false,
      { currentRevision: actual },
      409,
    );
}

export function deliveryUserState(store: Store, run: Run, root: Task): DeliveryReviewState {
  const fingerprint = deliveryFingerprint(store, run, root);
  return {
    runId: run.id,
    runRevision: run.revision,
    rootRevision: root.revision,
    fingerprint,
    userReview: run.deliveryReview
      ? { ...run.deliveryReview, stale: run.deliveryReview.fingerprint !== fingerprint }
      : null,
  };
}
export function runLineage(store: Store, runId: string): RunLineage {
  let current: Run | undefined = nativeRun(store, runId);
  const ancestors: RunLineage['ancestors'] = [];
  const seen = new Set([runId]);
  let cycleDetected = false;
  while (current?.source && ancestors.length < 20) {
    const source: RunSourceSnapshot = current.source;
    if (seen.has(source.runId)) {
      cycleDetected = true;
      break;
    }
    seen.add(source.runId);
    const candidate: Run | undefined = store.get<Run>('runs', source.runId);
    // Never cross a surface boundary, even for malformed historical source metadata.
    const parent: Run | undefined = candidate && isNative(candidate) ? candidate : undefined;
    ancestors.push({
      runId: source.runId,
      title: (parent?.title ?? source.title).slice(0, 300),
      kind: parent?.kind ?? null,
      status: parent?.status ?? null,
      projectId: parent?.projectId ?? null,
      archived: parent?.archived ?? null,
      missing: !parent,
      capturedAt: source.capturedAt,
    });
    current = parent;
  }
  return { runId, ancestors, hasMore: !!current?.source && ancestors.length === 20, cycleDetected };
}
export function runRevisions(store: Store, runId: string, before?: string): RunRevisions {
  nativeRun(store, runId);
  const page = store.runRevisions(runId, 20, before);
  return {
    runId,
    items: page.items
      .filter((run) => isNative(run) && run.source?.runId === runId)
      .map((run) => ({
        runId: run.id,
        title: run.title.slice(0, 300),
        kind: run.kind,
        status: run.status,
        projectId: run.projectId,
        archived: run.archived,
        createdAt: run.createdAt,
        sourceRunId: run.source?.runId ?? null,
      })),
    page: page.page,
  };
}
export function registerDeliveryLifecycle(
  app: FastifyInstance,
  store: Store,
  assertMutable: (runId: string | null, projectId?: string) => void,
) {
  const summaries = deliveryReviewReads(store);
  app.get<{ Params: { id: string } }>('/api/runs/:id/delivery/summary', async (request) => {
    const query = z
      .object({ retry: z.enum(['true', 'false']).optional() })
      .strict()
      .parse(request.query);
    if (!store.db.prepare('SELECT 1 FROM runs WHERE id=?').get(request.params.id))
      throw new AppError('NOT_FOUND', '任务不存在', false, null, 404);
    if (query.retry === 'true') summaries.retryFailures(request.params.id);
    return summaries.read(() => summaries.cached(request.params.id), request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/revisions', (request) => {
    const query = z.object({ before: z.string().uuid().optional() }).strict().parse(request.query);
    return runRevisions(store, request.params.id, query.before);
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/lineage', (request) => {
    z.object({}).strict().parse(request.query);
    return runLineage(store, request.params.id);
  });
  app.put<{ Params: { id: string } }>('/api/runs/:id/delivery/review', (request) => {
    const body = DeliveryReviewInput.parse(request.body);
    return store.command(
      body.commandId,
      { route: `/runs/${request.params.id}/delivery/review`, body },
      () => {
        const run = nativeRun(store, request.params.id),
          root = store.require<Task>('tasks', run.rootTaskId);
        assertMutable(run.id, run.projectId ?? undefined);
        invariant(!run.archived, 'RUN_ARCHIVED', '请先恢复归档记录再复核');
        invariant(
          run.kind === 'task' && !!run.projectId && run.status === 'DONE' && root.status === 'DONE',
          'DELIVERY_NOT_DONE',
          '只有已交付的原生项目任务可以记录用户复核',
        );
        revision(body.expectedRevision, run.revision);
        revision(body.expectedRootRevision, root.revision);
        const fingerprint = deliveryFingerprint(store, run, root);
        if (fingerprint !== body.expectedFingerprint)
          throw new AppError('DELIVERY_CHANGED', '交付内容已变化，请重新读取并复核', false, null, 409);
        invariant(
          new Set(body.criteriaNotes.map((item) => item.index)).size === body.criteriaNotes.length &&
            body.criteriaNotes.every((item) => item.index < root.spec.acceptanceCriteria.length),
          'CRITERION_SCOPE',
          '逐项备注必须对应现有验收项，且不能重复',
        );
        const review: DeliveryUserReview = {
          decision: body.decision,
          note: body.note,
          criteriaNotes: body.criteriaNotes.map(({ index, note }) => ({
            index,
            note,
            criterionText: root.spec.acceptanceCriteria[index],
          })),
          fingerprint,
          reviewedAt: now(),
          rootTaskId: root.id,
          rootRevision: root.revision,
        };
        const updated = store.put<Run>('runs', { ...run, deliveryReview: review }, run.revision);
        store.event(run.id, 'run.updated', updated);
        return deliveryUserState(store, updated, root);
      },
    );
  });
}
