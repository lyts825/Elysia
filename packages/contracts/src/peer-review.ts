/**
 * 同行评审策略、提交与轮次状态的共享契约。
 * 候选、模型提交和内核核验结果分层保存，模型自报不能替代整轮门禁。
 *
 * EN: Defines peer-review policy, submissions, and round state.
 * Separates candidates, model submissions, and verified results; model claims cannot replace the round gate.
 */
import { z } from 'zod';
import type { Evidence, ProviderConfig } from './index.js';

/**
 * 每轮使用 1 至 3 个不同连接；分数阈值和轮数均受校验约束。
 *
 * EN: Each round uses one to three distinct connections; score thresholds and round counts are validated.
 */
export const PeerReviewPolicy = z
  .object({
    reviewerProviderIds: z.array(z.string().min(1)).min(1).max(3),
    minScore: z.number().int().min(0).max(100).default(80),
    maxRounds: z.number().int().min(1).max(3).default(3),
  })
  .strict()
  .refine(
    (value) => new Set(value.reviewerProviderIds).size === value.reviewerProviderIds.length,
    '评审模型配置不能重复',
  );
export type PeerReviewPolicy = z.infer<typeof PeerReviewPolicy>;

/**
 * 模型提交的逐项判断；验收项完整性、候选归属和证据引用由内核进一步交叉核验。
 *
 * EN: Model-submitted per-criterion judgments; the kernel further cross-checks criterion coverage, candidate ownership, and evidence references.
 */
export const PeerReviewSubmission = z
  .object({
    candidateId: z.string().uuid(),
    items: z
      .array(
        z
          .object({
            criterion: z.number().int().nonnegative(),
            score: z.number().int().min(0).max(100),
            verdict: z.enum(['pass', 'fail', 'insufficient']),
            evidenceRefs: z.array(z.string().min(1)).max(80),
            reason: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    summary: z.string().trim().min(1).max(8000),
  })
  .strict();
export type PeerReviewSubmission = z.infer<typeof PeerReviewSubmission>;

/**
 * 本轮冻结候选；指纹绑定当前作者、需求和证据版本，使变化后的候选必须重新评审。
 *
 * EN: The frozen candidate for this round; its fingerprint binds author, requirements, and evidence versions so changed candidates require new review.
 */
export interface PeerReviewCandidate {
  id: string;
  round: number;
  fingerprint: string;
  summary: string;
  evidence: Evidence[];
  acceptanceCriteria: string[];
  /**
   * 与该候选冻结合同一起保存的已应用用户更正。
   *
   * EN: Applied user corrections accompanying the frozen contract for this candidate.
   */
  requirements: { id: string; text: string }[];
  contractVersion: number;
  authorAgentId: string;
  authorModel: string;
  createdAt: string;
}
/**
 * 内核在模型提交之外添加真实评审身份、平均分与逐项阈值通过结果。
 *
 * EN: The kernel adds verified reviewer identity, average score, and per-criterion threshold results beyond the model submission.
 */
export interface PeerReviewScore extends PeerReviewSubmission {
  reviewerTaskId: string;
  reviewerProviderId: string;
  reviewerModel: string;
  score: number;
  passed: boolean;
  submittedAt: string;
}
/**
 * 一轮必须收齐所有冻结评审模型；stale 表示需求或执行条件变化使旧结论不能复用。
 *
 * EN: A round must collect every frozen reviewer; stale means requirements or execution conditions changed and prior judgments cannot be reused.
 */
export interface PeerReviewRound {
  candidate: PeerReviewCandidate;
  status: 'reviewing' | 'passed' | 'changes_requested' | 'limit_reached' | 'stale';
  scores: PeerReviewScore[];
  reason?: string;
}
export interface PeerReviewState {
  bindings: ProviderConfig[];
  reviewerTaskIds: string[];
  rounds: PeerReviewRound[];
}
