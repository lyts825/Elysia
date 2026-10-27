/* 读取和写入任务设置草稿。 */
import type {
  ToolReviewPolicy,
  CommandBackendPolicy,
} from '../../../packages/contracts/src/execution-policy';
import { z } from 'zod';
import { AgentTerminalProfile, type ContextPolicy } from '../../../packages/contracts/src/index';
import type { ModelChoice } from './ModelPicker';
import type { PeerReviewPolicy } from '../../../packages/contracts/src/peer-review';

export type RunSetupDraft = {
  planMode: boolean;
  executionKind: 'native' | 'docker-agent';
  terminalProfile: AgentTerminalProfile;
  choice: ModelChoice;
  contextPolicy: ContextPolicy;
  write: boolean;
  exec: boolean;
  urls: string;
  inputs: string;
  writePaths: string;
  maxRequests: number;
  maxTokens: number;
  concurrency: number;
  maxCost?: number | null;
  deliverables?: string;
  acceptanceCriteria?: string;
  allowSameModelReview?: boolean;
  peerReview?: PeerReviewPolicy;
  toolReview?: ToolReviewPolicy;
  commandBackend?: CommandBackendPolicy;
};

// Drafts may contain incomplete input. Validate their shape here; the form validates execution values.
const draftShape = z.object({
  planMode: z.boolean(),
  executionKind: z.enum(['native', 'docker-agent']),
  terminalProfile: AgentTerminalProfile.extend({
    id: z.string(),
    label: z.string(),
    image: z.string(),
    command: z.array(z.string()),
    environment: z.array(z.string()),
    timeoutMs: z.number(),
    outputLimit: z.number(),
  }),
  choice: z.object({
    providerId: z.string(),
    model: z.string().optional(),
    reasoningEffort: z.string().nullable().optional(),
  }),
  contextPolicy: z.object({ mode: z.enum(['manual', 'managed']), windowTokens: z.number().optional() }),
  write: z.boolean(),
  exec: z.boolean(),
  urls: z.string(),
  inputs: z.string(),
  writePaths: z.string(),
  maxRequests: z.number(),
  maxTokens: z.number(),
  concurrency: z.number(),
  maxCost: z.number().nullable().optional(),
  deliverables: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  allowSameModelReview: z.boolean().optional(),
  toolReview: z
    .object({ mode: z.enum(['off', 'rules', 'model']), providerId: z.string().optional() })
    .optional(),
  commandBackend: z.object({ kind: z.enum(['local', 'docker']), image: z.string().optional() }).optional(),
  peerReview: z
    .object({
      reviewerProviderIds: z.array(z.string()),
      minScore: z.number(),
      maxRounds: z.number(),
    })
    .optional(),
});

export function readRunSetupDraft(raw: unknown): RunSetupDraft | undefined {
  if (raw === undefined || raw === '') return;
  if (typeof raw !== 'string' || raw.length > 200000) throw Error('创建配置草稿格式无法读取，原文仍保留。');
  try {
    const value = z.object({ version: z.literal(1), draft: draftShape }).parse(JSON.parse(raw));
    return value.draft as RunSetupDraft;
  } catch {
    throw Error('创建配置草稿格式或版本无法读取，原文仍保留。');
  }
}
export function writeRunSetupDraft(draft: RunSetupDraft) {
  const raw = JSON.stringify({ version: 1, draft });
  if (raw.length > 200000) throw Error('创建配置草稿超过本机保存上限，请缩短输入；当前表单仍保留。');
  return raw;
}
