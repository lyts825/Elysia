// 同行评审策略、提交与轮次状态的共享契约。
import { z } from 'zod';
import type { Evidence, ProviderConfig } from './index.js';

// 每轮使用 1 至 3 个不同连接；分数阈值和轮数均受校验约束。
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

export interface PeerReviewCandidate {
  id: string;
  round: number;
  fingerprint: string;
  summary: string;
  evidence: Evidence[];
  acceptanceCriteria: string[];
  /** Applied user corrections accompanying the frozen contract for this candidate. */
  requirements: { id: string; text: string }[];
  contractVersion: number;
  authorAgentId: string;
  authorModel: string;
  createdAt: string;
}
export interface PeerReviewScore extends PeerReviewSubmission {
  reviewerTaskId: string;
  reviewerProviderId: string;
  reviewerModel: string;
  score: number;
  passed: boolean;
  submittedAt: string;
}
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
