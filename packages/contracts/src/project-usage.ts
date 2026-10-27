// 项目请求量、令牌和费用汇总的数据契约。
import type { Status } from './index.js';
import type { RecordPage } from './run-reads.js';

export interface ProjectUsageTotals {
  requestCount: number;
  readableCount: number;
  unavailableCount: number;
  statuses: { reserved: number; settled: number; unknown: number; released: number };
  inputTokens: number;
  outputTokens: number;
  tokenUnknownCount: number;
  tokenComplete: boolean;
  /** Stored usage cost estimates for settled requests, separated by frozen price currency. */
  costs: { currency: 'USD' | 'CNY'; amount: number; requestCount: number }[];
  costUnknownCount: number;
  costComplete: boolean;
}
export interface ProjectUsageConnection extends ProjectUsageTotals {
  providerId: string;
  label: string;
  model: string | null;
  providerKind: string | null;
  account: string | null;
  source: 'api' | 'subscription' | 'unknown';
}
export interface ProjectUsageRun extends ProjectUsageTotals {
  runId: string;
  title: string;
  status: Status | null;
  archived: boolean;
}
export interface ProjectUsageSummary {
  projectId: string;
  generatedAt: string;
  version: string;
  runCount: number;
  /** Global legacy/corrupt run records whose project membership cannot be established. */
  unassignedRunCount: number;
  readCoverage: { complete: boolean; unavailable: number };
  totals: ProjectUsageTotals;
  connections: ProjectUsageConnection[];
  runs: ProjectUsageRun[];
  page: RecordPage;
}
