/**
 * 项目请求量、令牌和费用汇总的数据契约。
 * 完整汇总和分页明细分开表达，未知用量和币种不能作为零值混入完整费用。
 *
 * EN: Defines project request, token, and cost summaries.
 * Separates full summaries from paged details; unknown usage/currency cannot be treated as zero complete cost.
 */
import type { Status } from './index.js';
import type { RecordPage } from './run-reads.js';

/**
 * 用量缺失分别计数；完整性字段用于提示汇总是否覆盖了全部请求。
 *
 * EN: Missing usage is counted separately; completeness fields indicate whether all requests were covered.
 */
export interface ProjectUsageTotals {
  requestCount: number;
  readableCount: number;
  unavailableCount: number;
  statuses: { reserved: number; settled: number; unknown: number; released: number };
  inputTokens: number;
  outputTokens: number;
  tokenUnknownCount: number;
  tokenComplete: boolean;
  /**
   * 按冻结价格币种分别汇总已结算请求保存的费用估算。
   *
   * EN: Stored usage cost estimates for settled requests, separated by frozen price currency.
   */
  costs: { currency: 'USD' | 'CNY'; amount: number; requestCount: number }[];
  costUnknownCount: number;
  costComplete: boolean;
}
/**
 * 按持久请求绑定聚合的连接用量，source 区分 API、订阅及无法核对来源的记录。
 *
 * EN: Connection usage aggregates by persisted request bindings; source distinguishes API, subscription, and unverifiable origins.
 */
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
/**
 * 项目完整总量与当前运行页分开；unassignedRunCount 揭示无法确认项目归属的旧/坏记录。
 *
 * EN: Full project totals are separate from the current run page; unassignedRunCount exposes old/corrupt rows with unknown project ownership.
 */
export interface ProjectUsageSummary {
  projectId: string;
  generatedAt: string;
  version: string;
  runCount: number;
  /**
   * 无法确认项目归属的全局旧版或损坏运行记录。
   *
   * EN: Global legacy/corrupt run records whose project membership cannot be established.
   */
  unassignedRunCount: number;
  readCoverage: { complete: boolean; unavailable: number };
  totals: ProjectUsageTotals;
  connections: ProjectUsageConnection[];
  runs: ProjectUsageRun[];
  page: RecordPage;
}
