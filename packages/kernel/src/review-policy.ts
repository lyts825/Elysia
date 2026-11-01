/**
 * 在保存或预留模型时校验评审模型的独立性。
 * 在保存/预约的同一事务比较当前及历史真实型号，避免换连接规避模型隔离。
 *
 * EN: Validates review-model independence when saving or reserving model choices.
 * Compares current/historical actual models in the saving/reservation transaction to prevent connection changes bypassing isolation.
 */
import { invariant, type Run } from '../../contracts/src/index.js';
import { reviewModelConflict, type ReviewModelAssignment } from '../../contracts/src/review-policy.js';
import type { KernelStore as Store } from './ports.js';

/**
 * 在保存或预留模型的同一事务中验证实际解析后的型号。
 * 校验本次候选与既有任务、历史已执行请求的模型隔离。replacingTaskIds 仅排除当前任务选择，
 * 不抹去其历史实际使用的模型；型号索引与原始记录在同一事务更新。
 *
 * EN: Validate the resolved models inside the same transaction that saves or reserves them.
 * Checks candidate isolation from current tasks and historically executed requests. The transactional index retains historical assignments when current choices are replaced.
 */
export function assertReviewModelPolicy(
  store: Store,
  run: Run,
  candidates: ReviewModelAssignment[],
  replacingTaskIds: string[] = [],
) {
  if (run.peerReview) {
    /**
     * 候选执行模型不能占用独立评分模式冻结的评审型号。
     *
     * EN: Candidate execution models cannot consume a model identity frozen for independent peer review.
     */
    const frozenModels = new Set(
      run.peerReview.bindings.map((binding) => binding.model.trim().toLowerCase()),
    );
    for (const candidate of candidates)
      invariant(
        candidate.role === 'reviewer' || !frozenModels.has(candidate.model.trim().toLowerCase()),
        'PEER_REVIEW_MODEL_CONFLICT',
        '执行代理不能使用已冻结的评审模型型号',
      );
  }
  if (
    run.kind !== 'task' ||
    run.execution?.kind === 'docker-agent' ||
    run.contract.allowSameModelReview === true
  )
    return;
  if (
    candidates.every((candidate) => candidate.role !== 'reviewer') &&
    !store.scheduling.hasReviewers(run.id)
  )
    return;
  const assignments = store.scheduling.reviewModels(run.id, replacingTaskIds) as ReviewModelAssignment[];
  invariant(
    assignments.every((item) => item.model && item.role),
    'REVIEW_MODEL_UNKNOWN',
    '历史模型无法核对，请修复记录后继续',
  );
  for (const candidate of candidates) {
    const conflict = reviewModelConflict([
      candidate,
      ...[...assignments, ...candidates].filter(
        (item) => (item.role === 'reviewer') !== (candidate.role === 'reviewer'),
      ),
    ]);
    invariant(!conflict, 'REVIEW_MODEL_CONFLICT', conflict ?? '');
  }
}
