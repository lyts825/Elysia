/** 原生代理的持久阶段和有界调度协议。EN: Durable native stages and bounded scheduling contracts. */
export type NativeStage = 'model' | 'tools' | 'finish';
export interface WorkLease {
  taskId: string;
  owner: string;
  fence: number;
  stage: NativeStage;
  messageId: string | null;
}
export interface BudgetTotal {
  requests: number;
  tokens: number;
  cost: number;
  currencies: string[];
}
export interface SchedulingIndex {
  countAgents(runId: string): number;
  countChildren(taskId: string): number;
  waitSummary(taskId: string): { total: number; complete: boolean; needsDecision: boolean; ids: string[] };
  recover(runId?: string): void;
  operationIds(taskId: string, options?: { name?: string; attemptId?: string; pending?: boolean }): string[];
  hasReviewers(runId: string): boolean;
  findTask(runId: string, key: string): string | undefined;
  taskIds(runId: string, options?: { parentId?: string; after?: string; limit?: number }): string[];
  attemptIds(taskId: string, statuses?: string[]): string[];
  descendantIds(taskId: string): string[];
  wouldCycle(taskId: string, dependencies: string[]): boolean;
  waitingParents(runId: string, limit?: number): string[];
  dirtyDependencies(runId: string, limit?: number): string[];
  acknowledgeDependency(taskId: string): void;
  budget(taskId: string): BudgetTotal;
  reviewModels(
    runId: string,
    replacing: string[],
  ): { key: string; title: string; role: string; model: string }[];
}

/** 宿主驻留上限与 CPU 核数无关；每任务仍受其冻结并发设置约束。 */
export const ASYNC_RESIDENT_LIMIT = 32;
export const ASYNC_QUEUE_BATCH = 64;
export const ASYNC_CHILD_PAGE = 32;
