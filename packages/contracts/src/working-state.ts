import type { Contract, Evidence, Status, TaskSpec } from './index.js';

/** A reviewable checkpoint, never a new permission grant or an inferred replacement of instructions. */
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

export interface TaskWorkingStateRecord {
  revision: number;
  approved: ApprovedTaskWorkingState | null;
}

export interface TaskWorkingStateView extends TaskWorkingStateRecord {
  draft: TaskWorkingStateDraft;
  canApprove: boolean;
  reason: string | null;
  approvedValid: boolean;
  approvedInvalidReason: string | null;
}
