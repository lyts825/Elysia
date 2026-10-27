/**
 * 读取交付状态、运行谱系和修订历史并注册接口。
 * 用版本和幂等命令保存人工复核及当时基线；验收独立于执行完成，旧结论不能自动证明变化后的交付通过。
 * EN: Reads delivery state, run lineage, and revision history and registers their routes. Persists revisioned idempotent manual reviews and baselines independently of execution completion; old decisions cannot establish acceptance of changed delivery.
 */
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
import { id, now, type Store } from '../../../packages/storage/src/index.js';
import { deliveryReviewReads } from './delivery-summary.js';
import { initializeDeliveryReadCache } from './delivery-read-cache.js';
import { registerDeliveryArtifactWarm, withWarmDeliveryMetadata } from './delivery-artifact-warm.js';
import {
  appendDeliveryReview,
  captureDeliveryBaseline,
  type DeliveryBaseline,
  deliveryChanges,
  deliveryArtifactChanges,
  deliveryReviewHistory,
  deliveryReviewHistoryDetail,
  ensureCurrentReviewSnapshot,
  initializeDeliveryReviewHistory,
} from './delivery-review-history.js';
export { deliveryFingerprint } from './delivery-fingerprint.js';

/**
 * 判断是否为原生运行；兼容缺少 execution 字段的旧记录。
 * EN: Recognizes native runs, including legacy rows without execution metadata.
 */
const isNative = (run: Run) => (run.execution?.kind ?? 'native') === 'native';
/**
 * 复核和修订只在原生入口处理；历史记录也不得借此跨入终端执行数据。
 * EN: Reviews and revisions belong to the native surface; historical records cannot cross into terminal execution data through these reads.
 */
function nativeRun(store: Store, runId: string) {
  const run = store.require<Run>('runs', runId);
  invariant(isNative(run), 'DELIVERY_SURFACE', '交付复核和修订查询仅支持原生任务');
  return run;
}
/**
 * 保存前比较客户端看到的修订，并把当前修订附在409诊断中供重新核对。
 * EN: Checks the revision the client observed before saving and includes the current revision in 409 diagnostics for revalidation.
 */
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

/**
 * 根据当前交付指纹判断用户复核是否过期，并返回变更摘要。
 * EN: Compares the current delivery fingerprint to identify stale user review and returns a change summary.
 */
export function deliveryUserState(
  store: Store,
  run: Run,
  root: Task,
  baseline: DeliveryBaseline = captureDeliveryBaseline(store, run, root),
): DeliveryReviewState {
  const fingerprint = baseline.fingerprint;
  const reviewId = ensureCurrentReviewSnapshot(store, run);
  return {
    runId: run.id,
    runRevision: run.revision,
    rootRevision: root.revision,
    fingerprint,
    userReview: run.deliveryReview
      ? { ...run.deliveryReview, reviewId, stale: run.deliveryReview.fingerprint !== fingerprint }
      : null,
    changeSummary: reviewId ? deliveryChanges(store, run.id, reviewId, baseline) : null,
  };
}
/**
 * 沿来源链读取原生运行祖先，限制深度并检测循环。
 * EN: Reads native-run ancestors along source links with a depth bound and cycle detection.
 */
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
    /**
     * 即使历史来源元数据损坏，也不能跨入口边界读取。
     * EN: Never cross a surface boundary, even for malformed historical source metadata.
     */
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
/**
 * 分页读取从指定原生运行派生的修订任务。
 * EN: Paginates revision tasks derived from the selected native run.
 */
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
/**
 * 装配复核历史、交付摘要、差异和谱系路由。只读大元数据先预热；保存结论通过幂等命令 核对运行/根版本、交付指纹和验收项索引，再在同次提交中保留历史并更新当前结论。
 * EN: Registers review-history, delivery-summary, difference, and lineage routes. Large metadata reads warm first; idempotent review saves check run/root revisions, fingerprint, and criterion indexes, preserving history and updating the current decision atomically.
 */
export function registerDeliveryLifecycle(
  app: FastifyInstance,
  store: Store,
  assertMutable: (runId: string | null, projectId?: string) => void,
) {
  initializeDeliveryReviewHistory(store);
  initializeDeliveryReadCache(store);
  registerDeliveryArtifactWarm(app, store);
  const summaries = deliveryReviewReads(store);
  app.get<{ Params: { id: string } }>('/api/runs/:id/delivery/reviews', (request) => {
    const query = z.object({ before: z.string().uuid().optional() }).strict().parse(request.query);
    return store.tx(() => deliveryReviewHistory(store, nativeRun(store, request.params.id), query.before));
  });
  app.get<{ Params: { id: string; reviewId: string } }>(
    '/api/runs/:id/delivery/reviews/:reviewId',
    (request, reply) => {
      z.object({}).strict().parse(request.query);
      const reviewId = z.string().uuid().parse(request.params.reviewId);
      return withWarmDeliveryMetadata(store, request.params.id, request, reply, () =>
        store.tx(() => deliveryReviewHistoryDetail(store, nativeRun(store, request.params.id), reviewId)),
      );
    },
  );
  app.get<{ Params: { id: string; reviewId: string } }>(
    '/api/runs/:id/delivery/reviews/:reviewId/artifact-changes',
    (request, reply) => {
      const params = z.object({ id: z.string().uuid(), reviewId: z.string().uuid() }).parse(request.params);
      const query = z
        .object({
          expectedCurrentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          artifactId: z.string().uuid().optional(),
          offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
        })
        .strict()
        .parse(request.query);
      return withWarmDeliveryMetadata(store, params.id, request, reply, () =>
        store.tx(() =>
          deliveryArtifactChanges(
            store,
            nativeRun(store, params.id),
            params.reviewId,
            query.expectedCurrentFingerprint,
            query.offset,
            query.artifactId,
          ),
        ),
      );
    },
  );
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
        const baseline = captureDeliveryBaseline(store, run, root);
        const fingerprint = baseline.fingerprint;
        if (fingerprint !== body.expectedFingerprint)
          throw new AppError('DELIVERY_CHANGED', '交付内容已变化，请重新读取并复核', false, null, 409);
        invariant(
          new Set(body.criteriaNotes.map((item) => item.index)).size === body.criteriaNotes.length &&
            body.criteriaNotes.every((item) => item.index < root.spec.acceptanceCriteria.length),
          'CRITERION_SCOPE',
          '逐项备注必须对应现有验收项，且不能重复',
        );
        /**
         * 先保存尚未迁移的旧结论，再追加本次带完整基线的新结论，避免覆盖唯一旧记录。
         * EN: Preserves the surviving legacy decision before appending a new full-baseline review, avoiding loss of the only old record.
         */
        ensureCurrentReviewSnapshot(store, run);
        const review: DeliveryUserReview = {
          reviewId: id(),
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
        appendDeliveryReview(store, run.id, review, baseline);
        const updated = store.put<Run>('runs', { ...run, deliveryReview: review }, run.revision);
        store.event(run.id, 'run.updated', updated);
        return deliveryUserState(store, updated, root, baseline);
      },
    );
  });
}
