// 项目请求量、令牌和费用汇总的数据契约。
import type { Status } from './index.js';
import type { RecordPage } from './run-reads.js';

// 用量缺失分别计数；完整性字段用于提示汇总是否覆盖了全部请求。
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
/** 按持久请求绑定聚合的连接用量，source 区分 API、订阅及无法核对来源的记录。 */
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
/** 项目完整总量与当前运行页分开；unassignedRunCount 揭示无法确认项目归属的旧/坏记录。 */
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
