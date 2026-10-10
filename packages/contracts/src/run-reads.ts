export type RecordPage = {
  total: number;
  limit: number;
  before: string | null;
  hasMore: boolean;
  nextBefore: string | null;
};
export type RunUsageSummary = {
  requestCount: number;
  settledCount: number;
  unknownCount: number;
  totalTokens: number;
  costKnown: boolean;
  cost: number;
  providers: { providerId: string; input: number; cacheRead: number | null; ttftMs: number | null }[];
};
import type { Run } from './index.js';
export type RunListItem = Pick<
  Run,
  | 'id'
  | 'revision'
  | 'title'
  | 'objective'
  | 'kind'
  | 'projectId'
  | 'rootTaskId'
  | 'status'
  | 'reason'
  | 'archived'
  | 'createdAt'
> & { execution?: { kind: 'docker-agent' | 'native' } };
