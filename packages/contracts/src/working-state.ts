// 任务工作状态检查点及其批准记录的契约。
import type { Contract, Evidence, Status, TaskSpec } from './index.js';

/** A reviewable checkpoint, never a new permission grant or an inferred replacement of instructions. */
// 检查点同时绑定来源修订、历史摘要和需求摘要，用于判断审核时的上下文是否变化。
export interface TaskWorkingStateDraft {
  version: 1;
  revision: number;
  capturedAt: string;
  source: {
    runId: string;
    taskId: string;
    sessionId: string;
    projectId: string | null;
    runRevision: number;
    taskRevision: number;
    contractVersion: number;
    originalRef: string;
    messageCount: number;
    throughMessageId: string | null;
    throughMessageRevision: number | null;
    throughOrdinal: number | null;
    /** Includes message IDs, revisions, original text and tool/native payloads. */
    historyHash: string;
    /** Current contract and task specification; execution status is deliberately excluded. */
    requirementsHash: string;
  };
  state: {
    contract: Contract;
    task: {
      id: string;
      revision: number;
      spec: TaskSpec;
      status: Status;
      phase: 'planning' | 'executing';
      waitReason: string | null;
      waitingFor: string[];
    };
    children: {
      id: string;
      revision: number;
      title: string;
      objective: string;
      status: Status;
      required: boolean;
      waitReason: string | null;
      waitingFor: string[];
    }[];
    evidence: Evidence[];
    evidenceTotal: number;
  };
  /** Deterministic across GET/POST; capture time is not part of this hash. */
  snapshotHash: string;
}

/** 用户明确核对有效要求后的批准快照，后续新增消息仍保留原文且不在此批准范围内。 */
export interface ApprovedTaskWorkingState extends TaskWorkingStateDraft {
  currentRequirements: string;
  approval: {
    confirmed: true;
    commandId: string;
    approvedAt: string;
    /** Binds the complete checkpoint and the exact requirements reviewed by the user. */
    approvedHash: string;
  };
}

/** 保存修订与当前批准内容；清除批准也递增修订，防止旧确认覆盖新状态。 */
export interface TaskWorkingStateRecord {
  revision: number;
  approved: ApprovedTaskWorkingState | null;
}

/** 将当前草稿、是否可确认和旧批准是否仍有效分开，供界面在提交前核对。 */
export interface TaskWorkingStateView extends TaskWorkingStateRecord {
  draft: TaskWorkingStateDraft;
  canApprove: boolean;
  reason: string | null;
  approvedValid: boolean;
  approvedInvalidReason: string | null;
}
