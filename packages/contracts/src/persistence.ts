/**
 * 持久化记录和请求账本的数据结构。
 * 为数据库实现提供闭合表名和轻量账本字段，避免领域逻辑依赖数据库连接细节。
 *
 * EN: Defines persisted records and the request ledger.
 * Provides closed table names and lightweight ledger fields without exposing database connections to domain logic.
 */
import type { RequestRecord } from './index.js';

/**
 * 账本投影保留请求身份、预约和用量；旧记录的连接元数据可能缺失。
 *
 * EN: Ledger projections retain request identity, reservations, and usage; older rows may lack connection metadata.
 */
export type RequestLedgerRow = Pick<
  RequestRecord,
  | 'purpose'
  | 'id'
  | 'revision'
  | 'runId'
  | 'taskId'
  | 'attemptId'
  | 'logicalId'
  | 'providerId'
  | 'status'
  | 'startedAt'
  | 'reservedTokens'
  | 'reservedCost'
> & {
  account?: string;
  priceCurrency?: string;
  providerKind?: string;
  authMode?: string;
  model?: string;
  providerLabel?: string;
  usage: Pick<
    NonNullable<RequestRecord['usage']>,
    'inputTotal' | 'outputTotal' | 'cost' | 'cacheRead' | 'ttftMs'
  > | null;
};
/**
 * 持久实体表的闭合集合；动态表名调用只能来自该联合，不能直接使用外部输入。
 *
 * EN: The closed set of entity tables; dynamic table names must come from this union, never directly from external input.
 */
export const tables = [
  'project_spaces',
  'projects',
  'providers',
  'runs',
  'tasks',
  'agents',
  'attempts',
  'messages',
  'snapshots',
  'artifacts',
  'requests',
  'tool_operations',
  'checkpoints',
  'decisions',
  'inbox',
] as const;
export type Table = (typeof tables)[number];
