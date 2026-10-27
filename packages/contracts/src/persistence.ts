// 持久化记录和请求账本的数据结构。
import type { RequestRecord } from './index.js';

// 账本投影保留请求身份、预约和用量；旧记录的连接元数据可能缺失。
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
/** 持久实体表的闭合集合；动态表名调用只能来自该联合，不能直接使用外部输入。 */
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
