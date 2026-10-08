import { z } from 'zod';
export const VERSION = '0.10.1-preview.1';
export const Status = z.enum([
  'DRAFT',
  'READY',
  'RUNNING',
  'WAITING',
  'VERIFYING',
  'DONE',
  'FAILED',
  'CANCELLED',
]);
export type Status = z.infer<typeof Status>;
export const Permissions = z.object({
  read: z.boolean().default(true),
  write: z.boolean().default(false),
  exec: z.boolean().default(false),
  urls: z.array(z.string().url()).max(40).default([]),
  writePaths: z.array(z.string().min(1)).default(['.']),
});
export type Permissions = z.infer<typeof Permissions>;
export const Budget = z.object({
  maxRequests: z.number().int().min(1).max(80).default(80),
  maxTokens: z.number().int().min(1000).default(500000),
  maxCost: z.number().positive().nullable().default(null),
});
export type Budget = z.infer<typeof Budget>;
export const Limits = z.object({
  maxDepth: z.number().int().min(0).max(5).default(2),
  maxAgents: z.number().int().min(1).max(12).default(12),
  concurrency: z.number().int().min(1).max(4).default(4),
  toolConcurrency: z.number().int().min(1).max(4).default(4),
  maxSteps: z.number().int().min(1).max(20).default(20),
  maxMinutes: z.number().min(1).max(30).default(30),
});
export type Limits = z.infer<typeof Limits>;
export const Contract = z.object({
  version: z.number().int().positive().default(1),
  objective: z.string().min(1),
  scope: z.array(z.string()).min(1),
  nonGoals: z.array(z.string()),
  inputs: z.array(z.string()),
  deliverables: z.array(z.string()).min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  constraints: z.array(z.string()),
  permissionProfile: Permissions,
  budget: Budget,
  assumptions: z.array(z.string()),
});
export type Contract = z.infer<typeof Contract>;
export const ContextPolicy = z
  .object({
    mode: z.enum(['manual', 'managed']),
    windowTokens: z.number().int().min(4096).optional(),
  })
  .refine((policy) => policy.mode !== 'manual' || policy.windowTokens !== undefined, {
    message: '手动模式必须指定上下文窗口大小',
    path: ['windowTokens'],
  });
export type ContextPolicy = z.infer<typeof ContextPolicy>;
export const CONTEXT_SAFETY_TOKENS = 2048;
export const CONTEXT_MIN_INPUT_TOKENS = 1024;
/** Total window includes output and transport overhead, and is scoped to one model instance. */
export function minimumContextWindowTokens(provider: { outputLimit: number; authMode?: string }) {
  return Math.max(
    4096,
    provider.outputLimit +
      CONTEXT_SAFETY_TOKENS +
      (provider.authMode === 'codex' ? 16384 : 0) +
      CONTEXT_MIN_INPUT_TOKENS,
  );
}
export function effectiveContextWindowTokens(agent: {
  contextPolicy?: ContextPolicy;
  providerBinding: { contextLimit: number };
}) {
  return Math.min(
    agent.contextPolicy?.windowTokens ?? agent.providerBinding.contextLimit,
    agent.providerBinding.contextLimit,
  );
}
export const ContextRuntimeMetrics = z.object({
  agentId: z.string(),
  taskId: z.string(),
  sessionId: z.string(),
  agentRevision: z.number().int().nonnegative(),
  policy: ContextPolicy,
  windowTokens: z.number().int().positive(),
  providerLimit: z.number().int().positive(),
  outputReserveTokens: z.number().int().nonnegative(),
  safetyReserveTokens: z.literal(2048),
  runtimeReserveTokens: z.number().int().nonnegative(),
  inputBudgetTokens: z.number().int().nonnegative(),
  minimumWindowTokens: z.number().int().positive(),
  fixedTokens: z.number().int().nonnegative(),
  historyTokens: z.number().int().nonnegative(),
  estimatedInputTokens: z.number().int().nonnegative(),
  streamingOutputTokens: z.number().int().nonnegative(),
  observedInputTokens: z.number().nonnegative().nullable(),
  observedOutputTokens: z.number().nonnegative().nullable(),
  compression: z.object({
    status: z.enum(['idle', 'completed', 'blocked']),
    algorithm: z.literal('tiered-recoverable-v1'),
    beforeTokens: z.number().int().nonnegative(),
    afterTokens: z.number().int().nonnegative(),
    summarizedMessages: z.number().int().nonnegative(),
    prunedToolMessages: z.number().int().nonnegative(),
    summaryRef: z.string().nullable(),
    originalRef: z.string().nullable(),
  }),
  updatedAt: z.string(),
  phase: z.enum(['compiled', 'streaming', 'settled', 'blocked']),
});
export type ContextRuntimeMetrics = z.infer<typeof ContextRuntimeMetrics>;
export interface ContextProjection {
  agentId: string;
  taskId: string;
  agentRevision: number;
  parentAgentId: string | null;
  policy: ContextPolicy;
  windowTokens: number;
  providerLimit: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  runtimeReserveTokens: number;
  inputBudgetTokens: number;
  minimumWindowTokens: number;
  estimatedInputTokens: number | null;
  streamingOutputTokens: number;
  observedInputTokens: number | null;
  observedOutputTokens: number | null;
  remainingInputTokens: number | null;
  usageRatio: number | null;
  compression: ContextRuntimeMetrics['compression'] | null;
  metrics: ContextRuntimeMetrics | null;
  updatedAt: string | null;
  safeToConfigure: boolean;
  configureReason: string | null;
  assignedByAgentId: string | null;
}
export interface ContextSnapshot {
  runId: string;
  runRevision: number;
  agents: ContextProjection[];
}
export const TaskSpec = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  role: z.enum(['coordinator', 'worker', 'reviewer']).default('worker'),
  providerId: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: z
    .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    .nullable()
    .optional(),
  dependsOn: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  required: z.boolean().default(true),
  budget: Budget.optional(),
  contextWindowTokens: z.number().int().min(4096).optional(),
});
export type TaskSpec = z.infer<typeof TaskSpec>;
export const Plan = z.object({
  version: z.number().int().positive(),
  contractVersion: z.number().int().positive(),
  tasks: z.array(TaskSpec).max(11),
  snapshotIds: z.array(z.string()).default([]),
  summary: z.string().min(1),
});
export type Plan = z.infer<typeof Plan>;
export const ProviderConfig = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    kind: z.enum(['openai', 'deepseek']),
    authMode: z.enum(['apiKey', 'chatgpt', 'codex']).optional(),
    credentialId: z.string().uuid().nullable().optional(),
    reasoningEffort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .nullable()
      .optional(),
    archived: z.boolean().optional(),
    subscriptionAccountId: z.string().min(1).nullable().optional(),
    label: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    account: z.string().min(1),
    contextLimit: z.number().int().min(4096),
    outputLimit: z.number().int().min(256),
    concurrency: z.number().int().min(1).max(2).default(2),
    rpm: z.number().int().positive().default(60),
    tpm: z.number().int().positive().default(200000),
    cache: z.object({
      mode: z.enum(['automatic', 'configured', 'unknown']),
      minTokens: z.number().nullable(),
      ttl: z.string().nullable(),
      parameters: z.record(z.string(), z.unknown()).default({}),
    }),
    prices: z
      .object({
        version: z.string(),
        currency: z.enum(['USD', 'CNY']),
        input: z.number().nonnegative(),
        cacheRead: z.number().nonnegative(),
        cacheWrite: z.number().nonnegative().nullable(),
        output: z.number().nonnegative(),
      })
      .nullable()
      .default(null),
  })
  .refine((p) => p.outputLimit < p.contextLimit, '输出上限必须小于上下文上限')
  .refine(
    (p) =>
      !['chatgpt', 'codex'].includes(p.authMode || '') ||
      (p.kind === 'openai' &&
        p.baseUrl === 'https://api.openai.com/v1' &&
        !!p.subscriptionAccountId &&
        p.prices === null),
    'ChatGPT 订阅需要 OpenAI 官方端点、已登录账号；API 单价不适用于订阅',
  );
export type ProviderConfig = z.infer<typeof ProviderConfig> & {
  revision: number;
  checkedRevision: number | null;
  checkedAt?: string;
};
export interface Entity {
  id: string;
  revision: number;
  runId?: string;
}
export interface Project extends Entity {
  name: string;
  spaceId: string;
  archived: boolean;
  workspaceRoot: string;
  baseline: string | null;
  configVersion: number;
}
export interface ProjectSpace extends Entity {
  name: string;
  protected: boolean;
}
export const ModelChoice = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: z
    .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    .nullable()
    .optional(),
});
export type ModelChoice = z.infer<typeof ModelChoice>;
export interface Run extends Entity {
  projectId: string | null;
  kind: 'task' | 'chat';
  title: string;
  archived: boolean;
  objective: string;
  contract: Contract;
  plan: Plan | null;
  status: Status;
  coordinatorAgentId: string;
  rootTaskId: string;
  limits: Limits;
  authorized: boolean;
  acceptedPlanVersion: number | null;
  startedAt: number | null;
  createdAt: string;
  reason?: string;
}
export interface Task extends Entity {
  contractVersion: number;
  runId: string;
  parentTaskId: string | null;
  agentId: string;
  spec: TaskSpec;
  status: Status;
  phase: 'planning' | 'executing';
  depth: number;
  workspace: string | null;
  baseline: string | null;
  waitReason?: string;
  waitingFor: string[];
  rateLimit?: {
    resumeAt: number;
    source?: 'account' | 'provider';
    logicalId?: string;
    retry?: number;
  };
  result?: unknown;
}
export interface Agent extends Entity {
  runId: string;
  parentAgentId: string | null;
  taskId: string;
  providerId: string;
  providerBinding: ProviderConfig;
  sessionId: string;
  status: Status;
  profileVersion: string;
  contextPolicy?: ContextPolicy;
  contextAssignedByAgentId?: string;
  contextPolicyRevision?: number;
}
export interface Attempt extends Entity {
  runId: string;
  taskId: string;
  agentId: string;
  sequence: number;
  status: 'ACTIVE' | 'WAITING' | 'DONE' | 'FAILED' | 'CANCELLED';
  lease: number | null;
  steps: number;
  checkpointRef: string | null;
  error?: string;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface Message extends Entity {
  sourceInboxId?: string;
  purpose?: 'model_handoff';
  handoffHistoryRef?: string;
  requestId?: string;
  contentRef?: string;
  providerNativeRef?: string;
  runId: string;
  sessionId: string;
  ordinal: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  calls?: ToolCall[];
  callId?: string;
  native?: unknown[];
  reasoningContent?: string;
  providerKind?: string;
}
export interface Usage {
  inputTotal: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  uncachedInput: number | null;
  outputTotal: number | null;
  reasoning: number | null;
  cost: number | null;
  ttftMs: number | null;
  rawUsage: unknown;
  cacheWriteIncludedInInput: boolean | null;
}
const metric = z.number().nonnegative().nullable();
export const UsageSchema = z
  .object({
    inputTotal: metric,
    cacheRead: metric,
    cacheWrite: metric,
    uncachedInput: metric,
    outputTotal: metric,
    reasoning: metric,
    cost: metric,
    ttftMs: metric,
    rawUsage: z.unknown(),
    cacheWriteIncludedInInput: z.boolean().nullable(),
  })
  .refine(
    (u) => u.inputTotal === null || u.cacheRead === null || u.cacheRead <= u.inputTotal,
    '缓存读取不能超过输入总量',
  )
  .refine(
    (u) => u.outputTotal === null || u.reasoning === null || u.reasoning <= u.outputTotal,
    '推理用量必须包含于输出总量',
  );
export interface RequestRecord extends Entity {
  runId: string;
  taskId: string;
  attemptId: string;
  logicalId: string;
  providerId: string;
  providerBinding: ProviderConfig;
  manifest: Record<string, unknown>;
  reservedTokens: number;
  reservedCost: number | null;
  status: 'RESERVED' | 'SETTLED' | 'UNKNOWN' | 'RELEASED';
  usage: Usage | null;
  startedAt: number;
  error?: string;
}
export interface Artifact extends Entity {
  runId: string;
  taskId: string;
  name: string;
  hash: string;
  objectRef: string;
  source: string;
  version: number;
  verified: boolean;
  mediaType: string;
}
export interface Snapshot extends Entity {
  runId: string;
  taskId: string;
  source: string;
  hash: string;
  objectRef: string;
  fetchedAt: string;
  trust: 'untrusted';
  version: number;
}
export interface Operation extends Entity {
  runId: string;
  taskId: string;
  attemptId: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  status: 'INTENT' | 'DONE' | 'FAILED' | 'UNCERTAIN';
  result?: unknown;
  evidence?: Record<string, unknown>;
  error?: string;
}
export interface Event {
  runId: string;
  seq: number;
  eventId: string;
  type: string;
  taskId: string | null;
  attemptId: string | null;
  payload: unknown;
  occurredAt: string;
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public details: unknown = null,
    public httpStatus = 400,
  ) {
    super(message);
  }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(code, message);
}
export const Command = z.object({
  commandId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().optional(),
});
export const Evidence = z.object({
  criterion: z.number().int().nonnegative(),
  type: z.enum(['file', 'artifact', 'command']),
  ref: z.string().min(1),
  hash: z.string().optional(),
  note: z.string().min(1),
});
export type Evidence = z.infer<typeof Evidence>;
