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

// 缓存允许保留尚未完成的输入，所以字段类型校验比执行配置宽松；恢复成功不等于可创建运行。
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

/**
 * 读取版本 1 的完整表单缓存，空值表示没有草稿；超长、非法 JSON 或未知版本明确抛错。
 * 调用方应保留无法读取的原文，不能用空草稿静默覆盖。可执行范围由表单提交前再次校验。
 */
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
/** 序列化前保留原表单，超出保存上限时明确失败而不生成截断草稿。 */
export function writeRunSetupDraft(draft: RunSetupDraft) {
  const raw = JSON.stringify({ version: 1, draft });
  if (raw.length > 200000) throw Error('创建配置草稿超过本机保存上限，请缩短输入；当前表单仍保留。');
  return raw;
}
