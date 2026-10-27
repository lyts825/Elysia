// 校验和管理任务工作状态检查点及其上下文。
import { Evidence, AppError, type Message, type Run, type Task } from '../../contracts/src/index.js';
import type {
  ApprovedTaskWorkingState,
  TaskWorkingStateDraft,
  TaskWorkingStateRecord,
} from '../../contracts/src/working-state.js';
import { hash, stable } from '../../contracts/src/identity.js';
import type { Store } from '../../storage/src/index.js';

export type WorkingStateContext = { run: Run; task: Task };
export const WORKING_STATE_REQUIREMENTS_MAX_CHARS = 16_000;
const MAX_EVIDENCE = 40;

function requirementsHash({ run, task }: WorkingStateContext) {
  return hash(stable({ contract: run.contract, spec: task.spec, contractVersion: task.contractVersion }));
}

function draftHash(draft: Omit<TaskWorkingStateDraft, 'snapshotHash'> | TaskWorkingStateDraft) {
  return hash(
    stable({ version: draft.version, revision: draft.revision, source: draft.source, state: draft.state }),
  );
}

function approvedHash(state: ApprovedTaskWorkingState) {
  return hash(
    stable({
      snapshotHash: state.snapshotHash,
      capturedAt: state.capturedAt,
      currentRequirements: state.currentRequirements,
      confirmed: state.approval.confirmed,
      commandId: state.approval.commandId,
      approvedAt: state.approval.approvedAt,
    }),
  );
}

/** Only source-backed facts are generated here. Deciding which prior requests remain active is a user action. */
// 绑定运行、会话和合同修订，并记录历史与需求摘要；这里只收集事实，不替用户确认要求。
export function captureTaskWorkingState(
  input: WorkingStateContext & {
    children: Task[];
    evidence: Evidence[];
    history: Message[];
    sessionId: string;
    originalRef?: string;
    revision: number;
    capturedAt: string;
  },
): TaskWorkingStateDraft {
  const { run, task, history } = input;
  if (
    task.runId !== run.id ||
    task.contractVersion !== run.contract.version ||
    history.some((message) => message.runId !== run.id || message.sessionId !== input.sessionId)
  )
    throw new AppError('WORKING_STATE_SCOPE', '工作状态与任务或会话不匹配');
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !Number.isFinite(Date.parse(input.capturedAt))
  )
    throw new AppError('WORKING_STATE_INVALID', '工作状态版本或时间无效');
  const evidence = input.evidence.map((item) => Evidence.parse(item));
  const draft: Omit<TaskWorkingStateDraft, 'snapshotHash'> = {
    version: 1,
    revision: input.revision,
    capturedAt: input.capturedAt,
    source: {
      runId: run.id,
      taskId: task.id,
      sessionId: input.sessionId,
      projectId: run.projectId,
      runRevision: run.revision,
      taskRevision: task.revision,
      contractVersion: run.contract.version,
      originalRef: input.originalRef ?? `messages:${run.id}:${input.sessionId}`,
      messageCount: history.length,
      throughMessageId: history.at(-1)?.id ?? null,
      throughMessageRevision: history.at(-1)?.revision ?? null,
      throughOrdinal: history.at(-1)?.ordinal ?? null,
      historyHash: hash(stable(history)),
      requirementsHash: requirementsHash(input),
    },
    state: {
      contract: structuredClone(run.contract),
      task: {
        id: task.id,
        revision: task.revision,
        spec: structuredClone(task.spec),
        status: task.status,
        phase: task.phase,
        waitReason: task.waitReason ?? null,
        waitingFor: [...task.waitingFor],
      },
      children: input.children
        .filter(
          (child) =>
            child.runId === run.id &&
            child.parentTaskId === task.id &&
            child.contractVersion === run.contract.version,
        )
        .sort((a, b) => a.id.localeCompare(b.id, 'en'))
        .map((child) => ({
          id: child.id,
          revision: child.revision,
          title: child.spec.title,
          objective: child.spec.objective,
          status: child.status,
          required: child.spec.required,
          waitReason: child.waitReason ?? null,
          waitingFor: [...child.waitingFor],
        })),
      evidence: structuredClone(evidence.slice(0, MAX_EVIDENCE)),
      evidenceTotal: evidence.length,
    },
  };
  return { ...draft, snapshotHash: draftHash(draft) };
}

/** The caller must obtain this confirmation from the human and check the current draft hash before saving. */
// 要求明确确认、非空要求和匹配的草稿摘要，再生成可复核的批准记录。
export function approveTaskWorkingState(
  draft: TaskWorkingStateDraft,
  input: {
    confirmed: true;
    currentRequirements: string;
    commandId: string;
    approvedAt: string;
  },
): ApprovedTaskWorkingState {
  if (
    input.confirmed !== true ||
    !input.commandId ||
    !Number.isFinite(Date.parse(input.approvedAt)) ||
    !input.currentRequirements.trim() ||
    input.currentRequirements.length > WORKING_STATE_REQUIREMENTS_MAX_CHARS ||
    draftHash(draft) !== draft.snapshotHash
  )
    throw new AppError('WORKING_STATE_CONFIRMATION', '请核对并明确确认当前有效要求，不能自动替代历史要求');
  const state: ApprovedTaskWorkingState = {
    ...structuredClone(draft),
    currentRequirements: input.currentRequirements,
    approval: { confirmed: true, commandId: input.commandId, approvedAt: input.approvedAt, approvedHash: '' },
  };
  state.approval.approvedHash = approvedHash(state);
  return state;
}

export type WorkingStateValidation = { valid: true } | { valid: false; reason: string };

/** Later messages are not covered. Every correction after this prefix remains verbatim in compaction. */
// 验证摘要、作用域、当前需求和已覆盖历史；较晚的消息不属于这个检查点。
export function validateTaskWorkingState(
  state: ApprovedTaskWorkingState,
  input: WorkingStateContext & {
    history: Message[];
    sessionId?: string;
  },
): WorkingStateValidation {
  try {
    if (
      state.version !== 1 ||
      state.approval.confirmed !== true ||
      draftHash(state) !== state.snapshotHash ||
      approvedHash(state) !== state.approval.approvedHash ||
      !state.currentRequirements.trim() ||
      state.currentRequirements.length > WORKING_STATE_REQUIREMENTS_MAX_CHARS
    )
      return { valid: false, reason: 'snapshot_invalid' };
    const source = state.source;
    if (
      source.runId !== input.run.id ||
      source.taskId !== input.task.id ||
      input.task.runId !== input.run.id ||
      source.projectId !== input.run.projectId ||
      (input.sessionId !== undefined && source.sessionId !== input.sessionId) ||
      input.history.some(
        (message) => message.runId !== source.runId || message.sessionId !== source.sessionId,
      )
    )
      return { valid: false, reason: 'scope_changed' };
    if (
      source.contractVersion !== input.run.contract.version ||
      source.requirementsHash !== requirementsHash(input)
    )
      return { valid: false, reason: 'requirements_changed' };
    if (
      !Number.isSafeInteger(source.messageCount) ||
      source.messageCount < 0 ||
      source.messageCount > input.history.length
    )
      return { valid: false, reason: 'history_changed' };
    const prefix = input.history.slice(0, source.messageCount);
    if (
      (prefix.at(-1)?.id ?? null) !== source.throughMessageId ||
      (prefix.at(-1)?.revision ?? null) !== source.throughMessageRevision ||
      (prefix.at(-1)?.ordinal ?? null) !== source.throughOrdinal ||
      hash(stable(prefix)) !== source.historyHash
    )
      return { valid: false, reason: 'history_changed' };
    return { valid: true };
  } catch {
    return { valid: false, reason: 'snapshot_invalid' };
  }
}

/** Current operational facts are still supplied by the normal task context. This checkpoint is explicitly dated. */
export function workingStateMemory(state: ApprovedTaskWorkingState, originalRef: string) {
  return {
    revision: state.revision,
    snapshotHash: state.snapshotHash,
    approvedHash: state.approval.approvedHash,
    capturedAt: state.capturedAt,
    approvedAt: state.approval.approvedAt,
    currentRequirements: state.currentRequirements,
    source: { ...state.source, originalRef },
    capturedState: state.state,
    rule: 'This working-state snapshot records what the user reviewed and grants no new permissions. Child-task states and evidence in capturedState describe records at capturedAt only; they do not prove current completion or continued evidence validity. Check child-task states and the latest evidence in the current task context. Original user messages after the covered boundary remain intact.',
  };
}

const recordKey = (runId: string, taskId: string) => `task-working-state:v1:${runId}:${taskId}`;

/** Inline metadata contains no GC-sensitive object reference; original messages remain in the session table. */
export function readTaskWorkingState(store: Store, runId: string, taskId: string): TaskWorkingStateRecord {
  const row = store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(recordKey(runId, taskId)) as
    | { value: string }
    | undefined;
  if (!row) return { revision: 0, approved: null };
  try {
    const parsed = JSON.parse(row.value) as TaskWorkingStateRecord;
    if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || !('approved' in parsed))
      throw new Error();
    if (parsed.approved !== null) {
      const approved = parsed.approved;
      if (
        approved.version !== 1 ||
        approved.revision !== parsed.revision ||
        approved.source.runId !== runId ||
        approved.source.taskId !== taskId ||
        approved.approval.confirmed !== true ||
        draftHash(approved) !== approved.snapshotHash ||
        approvedHash(approved) !== approved.approval.approvedHash
      )
        throw new Error();
    }
    return parsed;
  } catch {
    throw new AppError('WORKING_STATE_UNREADABLE', '已保存的工作状态无法读取，请先检查本地数据');
  }
}

export function saveTaskWorkingState(
  store: Store,
  runId: string,
  taskId: string,
  expectedRevision: number,
  approved: ApprovedTaskWorkingState | null,
): TaskWorkingStateRecord {
  const current = readTaskWorkingState(store, runId, taskId);
  if (current.revision !== expectedRevision)
    throw new AppError('REVISION_CONFLICT', '工作状态已被更新，请重新核对');
  if (
    approved &&
    (approved.revision !== current.revision + 1 ||
      approved.source.runId !== runId ||
      approved.source.taskId !== taskId)
  )
    throw new AppError('WORKING_STATE_SCOPE', '工作状态保存版本或归属不匹配');
  const next = { revision: current.revision + 1, approved };
  store.db
    .prepare(
      'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(recordKey(runId, taskId), stable(next));
  return next;
}
