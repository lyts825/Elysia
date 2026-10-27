// 在保存或预留模型时校验评审模型的独立性。
import { invariant, type Agent, type RequestRecord, type Run, type Task } from '../../contracts/src/index.js';
import { reviewModelConflict, type ReviewModelAssignment } from '../../contracts/src/review-policy.js';
import type { RequestLedgerRow } from '../../contracts/src/persistence.js';
import type { KernelStore as Store } from './ports.js';

/** Validate the resolved models inside the same transaction that saves or reserves them. */
/**
 * 校验本次候选与既有任务、历史已执行请求的模型隔离。replacingTaskIds 仅排除当前任务选择，
 * 不抹去其历史实际使用的模型；ledger 可由同事务的调用方传入以避免重复读取。
 */
export function assertReviewModelPolicy(
  store: Store,
  run: Run,
  candidates: ReviewModelAssignment[],
  replacingTaskIds: string[] = [],
  ledger?: RequestLedgerRow[],
) {
  if (run.peerReview) {
    // 候选执行模型不能占用独立评分模式冻结的评审型号。
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
  const tasks = store.all<Task>('tasks', run.id);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const assignments = tasks
    .filter((task) => task.status !== 'CANCELLED' && !replacingTaskIds.includes(task.id))
    .map((task) => ({
      key: task.id,
      title: task.spec.title,
      role: task.spec.role,
      model: store.require<Agent>('agents', task.agentId).providerBinding.model,
    }));
  for (const request of ledger ?? store.requestLedger({ runId: run.id })) {
    // 已释放请求和工具审核请求不作为普通执行／评审模型的历史分配。
    if (request.status === 'RELEASED' || request.purpose === 'tool-review') continue;
    // Legacy ledgers may lack model metadata. Read the authoritative record only in that case.
    const original =
      !request.model || !request.taskId ? store.require<RequestRecord>('requests', request.id) : undefined;
    const task = byId.get(request.taskId ?? original?.taskId ?? '');
    const model = request.model ?? original?.providerBinding.model;
    invariant(task && model, 'REVIEW_MODEL_UNKNOWN', '历史请求的任务或模型无法核对，请修复记录后继续');
    assignments.push({ key: request.id, title: task.spec.title, role: task.spec.role, model });
  }
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
