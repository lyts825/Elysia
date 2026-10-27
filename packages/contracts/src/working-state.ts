/**
 * 任务工作状态检查点及其批准记录的契约。
 * 检查点只有在用户批准且历史/需求摘要仍匹配时可参与压缩，后续更正保持原文。
 *
 * EN: Defines task working-state checkpoints and their approvals.
 * A checkpoint participates in compaction only after approval and matching history/requirements; later corrections stay verbatim.
 */
import type { Contract, Evidence, Status, TaskSpec } from './index.js';

/**
 * 可审阅的检查点，既不授予新权限，也不推断替换原始指令。
 * 检查点同时绑定来源修订、历史摘要和需求摘要，用于判断审核时的上下文是否变化。
 *
 * EN: A reviewable checkpoint, never a new permission grant or an inferred replacement of instructions.
 * A checkpoint binds source revisions, history digest, and requirement digest to detect context changes during approval.
 */
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
    /**
     * 包含消息 ID、修订、原文和工具/原生负载。
     *
     * EN: Includes message IDs, revisions, original text and tool/native payloads.
     */
    historyHash: string;
    /**
     * 当前合同和任务规范，刻意排除执行状态。
     *
     * EN: Current contract and task specification; execution status is deliberately excluded.
     */
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
  /**
   * GET/POST 间保持确定；捕获时间不参与该摘要。
   *
   * EN: Deterministic across GET/POST; capture time is not part of this hash.
   */
  snapshotHash: string;
}

/**
 * 用户明确核对有效要求后的批准快照，后续新增消息仍保留原文且不在此批准范围内。
 *
 * EN: An approval snapshot after the user explicitly verifies active requirements; later messages remain verbatim outside its coverage.
 */
export interface ApprovedTaskWorkingState extends TaskWorkingStateDraft {
  currentRequirements: string;
  approval: {
    confirmed: true;
    commandId: string;
    approvedAt: string;
    /**
     * 绑定完整检查点和用户实际核对的要求。
     *
     * EN: Binds the complete checkpoint and the exact requirements reviewed by the user.
     */
    approvedHash: string;
  };
}

/**
 * 保存修订与当前批准内容；清除批准也递增修订，防止旧确认覆盖新状态。
 *
 * EN: Stores revision and current approval; clearing approval still increments revision so an old confirmation cannot overwrite a new decision.
 */
export interface TaskWorkingStateRecord {
  revision: number;
  approved: ApprovedTaskWorkingState | null;
}

/**
 * 将当前草稿、是否可确认和旧批准是否仍有效分开，供界面在提交前核对。
 *
 * EN: Separates the current draft, ability to approve, and validity of prior approval for pre-submission checking.
 */
export interface TaskWorkingStateView extends TaskWorkingStateRecord {
  draft: TaskWorkingStateDraft;
  canApprove: boolean;
  reason: string | null;
  approvedValid: boolean;
  approvedInvalidReason: string | null;
}
