/**
 * 校验和管理任务工作状态检查点及其上下文。
 * 事实采集与用户批准分开，摘要绑定原历史前缀，保存批准不直接恢复或启动任务。
 *
 * EN: Validates and manages task working-state checkpoints and their context.
 * Separates fact capture/user approval, binds the original prefix, and never resumes/starts execution by saving approval.
 */
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

/**
 * 合同、任务规范及合同版本共同确定当前需求；执行状态变化不使需求摘要失效。
 *
 * EN: Contract, task specification, and contract version determine current requirements; execution-status changes do not invalidate the requirement digest.
 */
function requirementsHash({ run, task }: WorkingStateContext) {
  return hash(stable({ contract: run.contract, spec: task.spec, contractVersion: task.contractVersion }));
}

/**
 * 草稿摘要覆盖版本、来源和事实快照，供批准时确认用户核对的是同一份内容。
 *
 * EN: The draft digest covers version, source, and fact snapshot so approval checks the exact reviewed content.
 */
function draftHash(draft: Omit<TaskWorkingStateDraft, 'snapshotHash'> | TaskWorkingStateDraft) {
  return hash(
    stable({ version: draft.version, revision: draft.revision, source: draft.source, state: draft.state }),
  );
}

/**
 * 将用户确认的有效要求与批准命令绑定到草稿，防止保存后单独改写确认内容。
 *
 * EN: Binds user-confirmed active requirements and the approval command to the draft, preventing later isolated rewrites.
 */
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

/**
 * 这里只生成有来源依据的事实；哪些先前要求仍有效由用户决定。
 * 绑定运行、会话和合同修订，并记录历史与需求摘要；这里只收集事实，不替用户确认要求。
 *
 * EN: Only source-backed facts are generated here. Deciding which prior requests remain active is a user action.
 * Binds run, session, and contract revisions and records history/requirement digests; collects facts without deciding requirements for the user.
 */
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

/**
 * 调用方必须向用户取得该确认，并在保存前核对当前草稿哈希。
 * 要求明确确认、非空要求和匹配的草稿摘要，再生成可复核的批准记录。
 *
 * EN: The caller must obtain this confirmation from the human and check the current draft hash before saving.
 * Requires explicit confirmation, nonempty requirements, and a matching draft digest before generating an auditable approval.
 */
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

/**
 * 不覆盖后续消息；该前缀之后的所有更正在压缩中逐字保留。
 * 验证摘要、作用域、当前需求和已覆盖历史；较晚的消息不属于这个检查点。
 *
 * EN: Later messages are not covered. Every correction after this prefix remains verbatim in compaction.
 * Checks digest, scope, current requirements, and covered history; later messages are outside this checkpoint.
 */
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

/**
 * 当前操作事实仍由正常任务上下文提供，此检查点明确带有日期。
 * 生成明确带时间的历史检查点；其中的子任务状态和证据不代表当前仍然有效。
 *
 * EN: Current operational facts are still supplied by the normal task context. This checkpoint is explicitly dated.
 * Builds an explicitly dated historical checkpoint; child-task states/evidence within it do not claim current validity.
 */
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

/** 将运行和任务身份一起编码到工作状态键，隔离不同任务的批准记录。
 * EN: Includes run and task identity in the working-state key to isolate approval records.
 */
const recordKey = (runId: string, taskId: string) => `task-working-state:v1:${runId}:${taskId}`;

/**
 * 内联元数据没有受对象回收影响的引用；原始消息仍保存在会话表。
 *
 * EN: Inline metadata contains no GC-sensitive object reference; original messages remain in the session table.
 */
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

/**
 * 按 expectedRevision 做乐观并发保存；批准快照须正好对应下一个修订及同一运行/任务。
 * approved 为 null 表示清除当前批准内容，但修订仍递增，避免旧页面覆盖新决定。
 *
 * EN: Saves optimistically against expectedRevision; the approved snapshot must match the next revision and same run/task. null clears approval but still increments revision so an old page cannot overwrite a later decision.
 */
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
