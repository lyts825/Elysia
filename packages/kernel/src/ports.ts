/**
 * 定义核心领域依赖的存储和恢复接口。
 * 通过能力端口隔离领域与基础设施，事务仅允许同步工作，实体正文仍由存储实现保证。
 *
 * EN: Defines storage and recovery ports required by the domain core.
 * Capability ports isolate domain/infrastructure; transactions remain synchronous and storage supplies authoritative entities.
 */
import type { Entity, Event, Message } from '../../contracts/src/index.js';
import type { Table, RequestLedgerRow } from '../../contracts/src/persistence.js';
import type { ExecutionHold } from '../../contracts/src/run-reads.js';
import type { ProjectCapabilitySnapshot } from '../../contracts/src/project-intelligence.js';

export type RecoveryTable = 'runs' | 'tasks' | 'agents' | 'attempts' | 'requests' | 'tool_operations';
export interface ExecutionRecoveryPort {
  /**
   * 使用轻量状态投影选候选；具体记录读取后还必须验证身份和所属关系。
   *
   * EN: Uses lightweight state projections to select candidates; identity and ownership must still be verified after reading each record.
   */
  candidates(table: RecoveryTable, statuses: readonly string[], runId?: string): string[];
  read<T extends Entity>(table: RecoveryTable, id: string, retry?: boolean): T;
  /**
   * 将单条恢复工作包在隔离回滚边界内，失败后记录问题并返回 false。
   *
   * EN: Runs one recovery action inside an isolated rollback boundary; failure records an issue and returns false.
   */
  apply<T extends Entity>(
    table: RecoveryTable,
    id: string,
    work: (entity: T) => void,
    retry?: boolean,
  ): boolean;
}
export interface UnitOfWork {
  /**
   * 只允许同步工作；状态与事件一起提交，外部工作留在事务之外。
   *
   * EN: Synchronous only: state and events commit together; external work stays outside.
   */
  tx<T>(work: () => T): T;
}
/**
 * 实体读取与写入由存储实现；expectedRevision 可用于并发冲突检查。
 *
 * EN: Storage implements entity reads/writes; expectedRevision can detect concurrent conflicts.
 */
export interface EntityRepository {
  /**
   * get 允许缺失，require 缺失时失败；两者均返回权威业务实体。
   *
   * EN: get permits absence while require rejects it; both return authoritative business entities.
   */
  get<T>(table: Table, key: string): T | undefined;
  require<T>(table: Table, key: string): T;
  all<T>(table: Table, runId?: string): T[];
  put<T extends Entity>(table: Table, entity: T, expectedRevision?: number): T;
}
/**
 * 按运行及会话隔离的消息历史，ordinal 的分配以同一会话计数为准。
 *
 * EN: Message history is isolated by run and session; ordinals are allocated using the count of that session.
 */
export interface SessionHistory {
  sessionMessages(runId: string, sessionId: string): Message[];
  sessionMessageCount(runId: string, sessionId: string): number;
}
/**
 * 面向预算和限流的轻量请求视图，避免每次累计都展开完整请求正文。
 *
 * EN: A lightweight request view for budgets and rate limits, avoiding full-body expansion on every accumulation.
 */
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
/**
 * 内核只依赖这些持久化能力；接口不暴露 SQLite 连接或文件系统句柄。
 *
 * EN: The kernel depends only on these persistence capabilities, without access to SQLite or filesystem handles.
 */
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
  /**
   * 内容寻址保存并返回可回查引用；readObject 可选择限制实际读取字节数。
   *
   * EN: Saves content-addressed data and returns a retrievable reference; readObject may cap actual read bytes.
   */
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
  /**
   * 在创建事务中调用，以冻结当前获授权的能力修订。
   *
   * EN: Called inside the creation transaction to freeze the currently authorized capability revision.
   */
  captureProjectCapabilities?(projectId: string): ProjectCapabilitySnapshot;
}
