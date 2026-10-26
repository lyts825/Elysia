import type { RequestRecord } from './index.js';

export type RequestLedgerRow = Pick<
  RequestRecord,
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
