// 定义核心领域依赖的存储和恢复接口。
import type { Entity, Event, Message } from '../../contracts/src/index.js';
import type { Table, RequestLedgerRow } from '../../contracts/src/persistence.js';
import type { ExecutionHold } from '../../contracts/src/run-reads.js';
import type { ProjectCapabilitySnapshot } from '../../contracts/src/project-intelligence.js';

export type RecoveryTable = 'runs' | 'tasks' | 'agents' | 'attempts' | 'requests' | 'tool_operations';
export interface ExecutionRecoveryPort {
  candidates(table: RecoveryTable, statuses: readonly string[], runId?: string): string[];
  read<T extends Entity>(table: RecoveryTable, id: string, retry?: boolean): T;
  apply<T extends Entity>(
    table: RecoveryTable,
    id: string,
    work: (entity: T) => void,
    retry?: boolean,
  ): boolean;
}
export interface UnitOfWork {
  /** Synchronous only: state and events commit together; external work stays outside. */
  tx<T>(work: () => T): T;
}
// 实体读取与写入由存储实现；expectedRevision 可用于并发冲突检查。
export interface EntityRepository {
  get<T>(table: Table, key: string): T | undefined;
  require<T>(table: Table, key: string): T;
  all<T>(table: Table, runId?: string): T[];
  put<T extends Entity>(table: Table, entity: T, expectedRevision?: number): T;
}
export interface SessionHistory {
  sessionMessages(runId: string, sessionId: string): Message[];
  sessionMessageCount(runId: string, sessionId: string): number;
}
export interface RequestLedger {
  requestLedger(filters?: {
    runId?: string;
    taskId?: string;
    account?: string;
    since?: number;
    logicalId?: string;
    attemptId?: string;
    status?: RequestLedgerRow['status'];
  }): RequestLedgerRow[];
}
export interface KernelStore extends UnitOfWork, EntityRepository, SessionHistory, RequestLedger {
  metadata(key: string): string | undefined;
  setMetadata(key: string, value: string): void;
  taskDependencies(taskId: string): string[];
  addTaskDependency(taskId: string, dependencyId: string): void;
  latestEvent(runId: string, taskId: string, type: string): Event | undefined;
  hasUncertainOperation(runId: string, taskId: string): boolean;
  event(
    runId: string,
    type: string,
    payload: unknown,
    taskId?: string | null,
    attemptId?: string | null,
  ): Event;
  events(runId: string, after?: number, filter?: { taskId?: string; type?: string; limit?: number }): Event[];
  object(content: string | Buffer): { hash: string; objectRef: string };
  readObject(reference: string, maxBytes?: number): Buffer;
  getExecutionHold(runId: string): ExecutionHold | undefined;
  stateCandidates<T extends Entity>(
    table: 'runs' | 'tasks' | 'requests' | 'tool_operations' | 'inbox',
    statuses: string[],
    options?: {
      runId?: string;
      exclude?: boolean;
      unarchived?: boolean;
      waitReasons?: string[];
      resumeBefore?: number;
      excludeRunIds?: readonly string[];
      excludeExecutionHolds?: boolean;
    },
  ): T[];
  readonly recovery: ExecutionRecoveryPort;
}
export interface KernelServices {
  /** Called inside the creation transaction to freeze the currently authorized capability revision. */
  captureProjectCapabilities?(projectId: string): ProjectCapabilitySnapshot;
}
