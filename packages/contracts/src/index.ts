/**
 * 汇总核心领域模型、校验规则和公共契约。
 * 集中定义实体、权限和生命周期的数据边界；状态转换与副作用必须通过内核和运行时执行。
 *
 * EN: Collects core domain models, validators, and public contracts.
 * Centralizes entity, permission, and lifecycle data boundaries; transitions and side effects go through kernel/runtime operations.
 */
import { ToolReviewPolicy, CommandBackendPolicy, type ToolReviewReceipt } from './execution-policy.js';
import { z } from 'zod';
import { TerminalConnectionBinding } from './terminal-control.js';
import { terminalResourcePresets } from './terminal-runtime.js';
import type { NativeProjectDefaults, RunSourceSnapshot, DeliveryUserReview } from './workflow.js';
import type { RoleRoutingSnapshot, RoleRoutingDecision } from './model-routing.js';
import type { ProjectCapabilitySnapshot } from './project-intelligence.js';
import { PeerReviewPolicy, type PeerReviewState } from './peer-review.js';
export * from './peer-review.js';
export * from './terminal-control.js';
export type { TerminalLogMatch, TerminalLogSearchPage } from './log-search.js';
export const VERSION = '1.23.14';
export type { RecordPage, RunUsageSummary, RunListItem } from './run-reads.js';
export * from './terminal-runtime.js';
export * from './terminal-maintenance.js';
export * from './tool-calls.js';
/**
 * 各实体共享这些生命周期状态；是否允许在状态间转换由领域操作校验。
 *
 * EN: Entities share these lifecycle states; domain operations determine which transitions are allowed.
 */
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
/**
 * 默认只读；写入、执行、允许访问的 URL 和可写路径需要在合同中明确指定。
 *
 * EN: Read-only by default. The contract must explicitly specify writing, execution, allowed URLs, and writable paths.
 */
export const Permissions = z.object({
  read: z.boolean().default(true),
  write: z.boolean().default(false),
  exec: z.boolean().default(false),
  /**
   * 网络工具逐个核对允许的目标；模型提供一个 URL 本身不产生授权。
   *
   * EN: Network tools validate each allowed destination; a URL supplied by a model does not itself grant access.
   */
  urls: z.array(z.string().url()).max(40).default([]),
  writePaths: z.array(z.string().min(1)).default(['.']),
});
export type Permissions = z.infer<typeof Permissions>;
/**
 * 预算约束累计请求、令牌和费用；maxCost 为 null 表示未设置费用上限。
 *
 * EN: Limits cumulative requests, tokens, and cost; null maxCost means no configured cost ceiling.
 */
export const Budget = z.object({
  maxRequests: z.number().int().min(1).max(80).default(80),
  maxTokens: z.number().int().min(1000).default(500000),
  maxCost: z.number().positive().nullable().default(null),
});
export type Budget = z.infer<typeof Budget>;
/**
 * 限制代理深度、数量、并发、步骤及运行时间，不替代预算约束。
 *
 * EN: Limits agent depth/count, concurrency, steps, and elapsed time independently of the budget.
 */
export const Limits = z.object({
  maxDepth: z.number().int().min(0).max(5).default(2),
  maxAgents: z.number().int().min(1).max(12).default(12),
  concurrency: z.number().int().min(1).max(4).default(4),
  toolConcurrency: z.number().int().min(1).max(4).default(4),
  maxSteps: z.number().int().min(1).max(20).default(20),
  maxMinutes: z.number().min(1).max(30).default(30),
});
export type Limits = z.infer<typeof Limits>;
/**
 * 合同汇集目标、范围、交付和验收标准，以及权限、预算和可选执行策略。
 *
 * EN: The contract combines goals, scope, deliverables, acceptance criteria, permissions, budget, and optional execution policies.
 */
export const Contract = z.object({
  /**
   * 需求重新规划时递增；任务和计划必须引用同一合同版本。
   *
   * EN: Increments when requirements are replanned; tasks and the plan must reference the same contract version.
   */
  version: z.number().int().positive().default(1),
  objective: z.string().min(1),
  scope: z.array(z.string()).min(1),
  nonGoals: z.array(z.string()),
  inputs: z.array(z.string()),
  deliverables: z.array(z.string()).min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  constraints: z.array(z.string()),
  /**
   * 普通执行/复核隔离的显式例外，不适用于独立同行评分模式。
   *
   * EN: An explicit exception to ordinary execution/review model separation; it does not apply to independent peer scoring.
   */
  allowSameModelReview: z.boolean().default(false),
  peerReview: PeerReviewPolicy.optional(),
  toolReview: ToolReviewPolicy.optional(),
  commandBackend: CommandBackendPolicy.optional(),
  permissionProfile: Permissions,
  budget: Budget,
  assumptions: z.array(z.string()),
});
export type Contract = z.infer<typeof Contract>;
export const CONTEXT_TOKEN_UNIT = 1000;
export const CONTEXT_MAX_WINDOW_TOKENS = 1000 * CONTEXT_TOKEN_UNIT;
export const CONTEXT_WINDOW_PRESETS = [
  CONTEXT_MAX_WINDOW_TOKENS,
  512 * CONTEXT_TOKEN_UNIT,
  256 * CONTEXT_TOKEN_UNIT,
] as const;
/**
 * 旧策略保持可读；新输入由下方的 ContextPolicy 校验。
 *
 * EN: Existing policies remain readable; new input is validated by ContextPolicy below.
 */
const StoredContextPolicy = z
  .object({
    mode: z.enum(['manual', 'managed']),
    windowTokens: z.number().int().min(4096).optional(),
  })
  .refine((policy) => policy.mode !== 'manual' || policy.windowTokens !== undefined, {
    message: '手动模式必须指定上下文窗口大小',
    path: ['windowTokens'],
  });
/**
 * 新输入限制最大窗口，手动模式以整数 K 为单位；旧记录仍可通过存储格式读取。
 *
 * EN: New input caps the window and requires whole K units in manual mode; the storage schema still accepts older records.
 */
export const ContextPolicy = StoredContextPolicy.refine(
  (policy) => policy.windowTokens === undefined || policy.windowTokens <= CONTEXT_MAX_WINDOW_TOKENS,
  { message: '上下文窗口最高支持 1M（1000K）', path: ['windowTokens'] },
).refine((policy) => policy.mode !== 'manual' || (policy.windowTokens ?? 0) % CONTEXT_TOKEN_UNIT === 0, {
  message: '手动窗口大小须为整数 K（1K = 1000 Token）',
  path: ['windowTokens'],
});
export type ContextPolicy = z.infer<typeof ContextPolicy>;
export const CONTEXT_SAFETY_TOKENS = 2048;
export const CONTEXT_MIN_INPUT_TOKENS = 1024;
/**
 * 总窗口包含输出与传输开销，且只作用于一个模型实例。
 *
 * EN: Total window includes output and transport overhead, and is scoped to one model instance.
 */
export function minimumContextWindowTokens(provider: { outputLimit: number; authMode?: string }) {
  return Math.max(
    4096,
    provider.outputLimit +
      CONTEXT_SAFETY_TOKENS +
      (provider.authMode === 'codex' ? 16384 : 0) +
      CONTEXT_MIN_INPUT_TOKENS,
  );
}
/**
 * 实际窗口取策略、连接上限与应用上限中的最小值。
 *
 * EN: The effective window is the minimum of the selected policy, connection limit, and application limit.
 */
export function effectiveContextWindowTokens(agent: {
  contextPolicy?: ContextPolicy;
  providerBinding: { contextLimit: number };
}) {
  return Math.min(
    agent.contextPolicy?.windowTokens ?? agent.providerBinding.contextLimit,
    agent.providerBinding.contextLimit,
    CONTEXT_MAX_WINDOW_TOKENS,
  );
}
export const ContextRuntimeMetrics = z.object({
  agentId: z.string(),
  taskId: z.string(),
  sessionId: z.string(),
  agentRevision: z.number().int().nonnegative(),
  policy: StoredContextPolicy,
  windowTokens: z.number().int().positive(),
  providerLimit: z.number().int().positive(),
  outputReserveTokens: z.number().int().nonnegative(),
  safetyReserveTokens: z.literal(2048),
  runtimeReserveTokens: z.number().int().nonnegative(),
  inputBudgetTokens: z.number().int().nonnegative(),
  minimumWindowTokens: z.number().int().positive(),
  /**
   * 系统规则、任务和工具等固定内容的保守估算，不是供应商 tokenizer 的测量值。
   *
   * EN: A conservative estimate for fixed rules, task data, and tools; not a measurement from the provider tokenizer.
   */
  fixedTokens: z.number().int().nonnegative(),
  historyTokens: z.number().int().nonnegative(),
  estimatedInputTokens: z.number().int().nonnegative(),
  streamingOutputTokens: z.number().int().nonnegative(),
  /**
   * 供应商已报告的输入/输出；未返回时为 null，不能用估算值伪装实测。
   *
   * EN: Input/output reported by the provider; absent values stay null and must not be replaced by estimates presented as measurements.
   */
  observedInputTokens: z.number().nonnegative().nullable(),
  observedOutputTokens: z.number().nonnegative().nullable(),
  compression: z.object({
    status: z.enum(['idle', 'completed', 'blocked']),
    algorithm: z.enum(['tiered-recoverable-v1', 'tiered-recoverable-v2']),
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
/**
 * 可由模型提出的任务规范；真实 ID、父子关系、工作区和授权由内核另行创建。
 *
 * EN: A model-proposed task specification; the kernel separately creates real IDs, hierarchy, workspace, and authorization.
 */
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
  /**
   * 计划内引用 key，创建后由内核解析为任务 ID 并检查依赖环。
   *
   * EN: References plan-local keys, which the kernel resolves to task IDs and checks for dependency cycles.
   */
  dependsOn: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  required: z.boolean().default(true),
  budget: Budget.optional(),
  contextWindowTokens: z.number().int().min(4096).max(CONTEXT_MAX_WINDOW_TOKENS).optional(),
});
export type TaskSpec = z.infer<typeof TaskSpec>;
/**
 * 待用户接受的下一版计划；contractVersion 绑定需求，version 绑定本次计划修订。
 *
 * EN: The next candidate plan awaiting user acceptance; contractVersion binds requirements and version identifies this plan revision.
 */
export const Plan = z.object({
  version: z.number().int().positive(),
  contractVersion: z.number().int().positive(),
  tasks: z.array(TaskSpec).max(11),
  snapshotIds: z.array(z.string()).default([]),
  summary: z.string().min(1),
});
export type Plan = z.infer<typeof Plan>;
/**
 * 模型连接与资源/价格声明。运行创建和子任务分配时保存完整绑定副本，
 * 后续编辑当前配置不会改写历史任务；revision 与 checkedRevision 在持久类型中补充。
 *
 * EN: Declares a model connection and resource/pricing metadata. Runs and child agents store full binding copies, so later configuration edits do not rewrite historical tasks. Persisted types add revision and checkedRevision.
 */
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
    /**
     * 并发和限流的账号域标识；同账号多个配置仍共享运行时账号额度。
     *
     * EN: The account domain for concurrency and rate limits; multiple configurations for one account share runtime limits.
     */
    account: z.string().min(1),
    contextLimit: z.number().int().min(4096),
    outputLimit: z.number().int().min(256),
    concurrency: z.number().int().min(1).max(2).default(2),
    rpm: z.number().int().positive().default(60),
    tpm: z.number().int().positive().default(200000),
    /**
     * 缓存声明及协议参数，不代表当前请求已经命中缓存。
     *
     * EN: Cache capabilities and protocol parameters do not prove that this request actually hit a cache.
     */
    cache: z.object({
      mode: z.enum(['automatic', 'configured', 'unknown']),
      minTokens: z.number().nullable(),
      ttl: z.string().nullable(),
      parameters: z.record(z.string(), z.unknown()).default({}),
    }),
    /**
     * 每百万 token 单价；未知为 null，订阅连接不套用 API 单价。
     *
     * EN: Prices per million tokens; unknown prices stay null, and subscription connections do not use API prices.
     */
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
  nativeDefaults?: NativeProjectDefaults | null;
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
/**
 * CLI 模板：记录命令、输出协议、资源和连接；创建终端任务时冻结为 ExecutionBinding。
 *
 * EN: A CLI template records command, output protocol, resources, and connection; task creation freezes it into ExecutionBinding.
 */
export const AgentTerminalProfile = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(80),
  agent: z.enum(['codex', 'claude', 'dsh', 'gemini', 'antigravity', 'custom']),
  image: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/),
  command: z.array(z.string().min(1).max(2000)).min(1).max(40),
  protocol: z.enum([
    'codex-jsonl',
    'claude-stream-json',
    'dsh-jsonl',
    'gemini-stream-json',
    'antigravity-stream-json',
    'text',
  ]),
  resourcePreset: z.enum(terminalResourcePresets).optional(),
  connectionId: z.string().uuid().nullable().optional(),
  connection: TerminalConnectionBinding.optional(),
  /**
   * 允许传递的环境变量名称清单，值在执行时从受控环境取得。
   *
   * EN: Names of environment variables allowed through; values are resolved from the controlled environment at execution time.
   */
  environment: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
    .max(12)
    .default([]),
  timeoutMs: z.number().int().min(1000).max(1800000).default(1800000),
  outputLimit: z.number().int().min(1000).max(200000).default(100000),
  network: z.enum(['none', 'bridge']).default('bridge'),
});
export type AgentTerminalProfile = z.infer<typeof AgentTerminalProfile>;
export type WorkspaceSurface = 'native' | 'terminal';
/**
 * 终端入口的模板集合，修订用于编辑并发检查，默认 ID 必须存在于集合。
 *
 * EN: Templates for the terminal surface; revision detects concurrent editing and the default ID must belong to the collection.
 */
export const SurfaceTerminalSettings = z
  .object({
    revision: z.number().int().nonnegative(),
    profiles: z.array(AgentTerminalProfile).min(1).max(20),
    defaultProfileId: z.string().uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.profiles.map((profile) => profile.id)).size !== value.profiles.length)
      context.addIssue({ code: 'custom', path: ['profiles'], message: '终端模板 ID 必须唯一' });
    if (!value.profiles.some((profile) => profile.id === value.defaultProfileId))
      context.addIssue({
        code: 'custom',
        path: ['defaultProfileId'],
        message: '请选择现有终端模板作为默认值',
      });
  });
export type SurfaceTerminalSettings = z.infer<typeof SurfaceTerminalSettings>;
/**
 * 按入口冻结执行方式；历史字段名 docker-agent 同时作为终端执行的持久标识。
 *
 * EN: Freezes execution per surface; the historical docker-agent field also remains the persisted identifier for terminal execution.
 */
export const ExecutionBinding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native') }),
  z.object({ kind: z.literal('docker-agent'), profile: AgentTerminalProfile }),
]);
export type ExecutionBinding = z.infer<typeof ExecutionBinding>;
/**
 * 运行记录保存冻结的模型、能力、合同和执行入口，交付审核与执行状态分开记录。
 *
 * EN: A run stores frozen model, capabilities, contract, and execution surface; delivery review is tracked separately from execution state.
 */
export interface Run extends Entity {
  peerReview?: PeerReviewState;
  /**
   * 创建时捕获角色选择，不改写协调代理的显式选择。
   *
   * EN: Role choices captured at creation; never changes the coordinator's explicit choice.
   */
  modelRouting?: RoleRoutingSnapshot;
  /**
   * 内核为路由后的计划项生成来源信息，不能采用模型输入冒充来源。
   *
   * EN: Kernel-generated provenance for routed plan entries, never taken from model input.
   */
  planRouting?: Record<string, RoleRoutingDecision>;
  capabilities?: ProjectCapabilitySnapshot;
  projectId: string | null;
  kind: 'task' | 'chat';
  title: string;
  archived: boolean;
  objective: string;
  contract: Contract;
  toolReviewBinding?: ProviderConfig;
  plan: Plan | null;
  /**
   * 旧记录缺少该字段时，默认启用计划模式。
   *
   * EN: Missing on older records means plan mode is enabled.
   */
  planMode?: boolean;
  /**
   * 任务创建时冻结；缺少该字段的记录使用原生 API 执行器。
   *
   * EN: Frozen when the task is created; absent records use the native API runner.
   */
  execution?: ExecutionBinding;
  status: Status;
  coordinatorAgentId: string;
  rootTaskId: string;
  limits: Limits;
  /**
   * 是否已获当前执行授权；计划模式还必须核对 acceptedPlanVersion。
   *
   * EN: Indicates whether current execution is authorized; plan mode must also match acceptedPlanVersion.
   */
  authorized: boolean;
  acceptedPlanVersion: number | null;
  /**
   * 累计运行时限的起点；任务暂停不会把它重置为新的完整时长。
   *
   * EN: The origin for cumulative runtime limits; pausing does not reset it to a new full duration.
   */
  startedAt: number | null;
  createdAt: string;
  reason?: string;
  /**
   * 用户选择的公开来源资料，在创建时冻结；不会授予权限。
   *
   * EN: Selected public source material, frozen at creation; never grants permissions.
   */
  source?: RunSourceSnapshot;
  /**
   * 用户对带指纹交付的显式复核，独立于执行状态。
   *
   * EN: Explicit user review of a fingerprinted delivery; independent of execution status.
   */
  deliveryReview?: DeliveryUserReview;
}
/**
 * 任务绑定代理与工作区，额外保留依赖阻塞、限流和无进展等等待信息。
 *
 * EN: A task binds an agent and workspace while retaining dependency, rate-limit, and no-progress waiting details.
 */
export interface Task extends Entity {
  peerReview?: { candidateId: string; reviewerProviderId: string };
  /**
   * 创建任务时适用的合同版本，防止旧子任务混入新需求的执行或上下文。
   *
   * EN: The contract version applicable at task creation, preventing old children from entering execution or context for new requirements.
   */
  contractVersion: number;
  runId: string;
  parentTaskId: string | null;
  agentId: string;
  spec: TaskSpec;
  status: Status;
  phase: 'planning' | 'executing';
  depth: number;
  workspace: string | null;
  /**
   * 对其他任务工作区的只读别名，不是独立拥有的检出目录。
   *
   * EN: Read-only alias of another task's workspace, never an independently owned checkout.
   */
  workspaceOwnerTaskId?: string;
  baseline: string | null;
  /**
   * WAITING 的具体原因决定可执行的恢复动作，不能仅凭 WAITING 自动重启。
   *
   * EN: The specific WAITING reason determines legal recovery actions; WAITING alone never authorizes automatic restart.
   */
  waitReason?: string;
  waitingFor: string[];
  /**
   * 恢复选定分支期间保留的失败依赖路径。
   *
   * EN: Failed dependency paths, retained while the selected branch is being recovered.
   */
  dependencyBlock?: {
    causes: {
      taskId: string;
      status: 'FAILED' | 'CANCELLED' | 'WAITING';
      waitReason?: 'no_progress';
      chain: string[];
    }[];
  };
  /**
   * 最近一次实质状态变化之后，有界保存的确定性工具失败。
   *
   * EN: Bounded deterministic tool failures since the last material state change.
   */
  noProgress?: {
    progressKey: string;
    failures: { fingerprint: string; tool: string; code: string; count: number; lastCallId: string }[];
    warned: boolean;
  };
  rateLimit?: {
    resumeAt: number;
    source?: 'account' | 'provider';
    logicalId?: string;
    retry?: number;
  };
  result?: unknown;
}
/**
 * 任务的模型实例与独立会话；providerBinding 是执行时使用的冻结副本。
 *
 * EN: The task model instance and separate session; providerBinding is the frozen copy used for execution.
 */
export interface Agent extends Entity {
  routingDecision?: RoleRoutingDecision;
  runId: string;
  parentAgentId: string | null;
  taskId: string;
  providerId: string;
  providerBinding: ProviderConfig;
  /**
   * 显式模型切换创建新会话，旧供应商的私有重放数据不跨会话复用。
   *
   * EN: An explicit model switch creates a new session; private provider replay data is not reused across sessions.
   */
  sessionId: string;
  status: Status;
  profileVersion: string;
  contextPolicy?: ContextPolicy;
  contextAssignedByAgentId?: string;
  contextPolicyRevision?: number;
}
/**
 * 每次执行尝试独立记录租约、步骤和检查点，供中断后恢复使用。
 *
 * EN: Each attempt separately records lease, steps, and checkpoint for recovery after interruption.
 */
export interface Attempt extends Entity {
  runId: string;
  taskId: string;
  agentId: string;
  sequence: number;
  status: 'ACTIVE' | 'WAITING' | 'DONE' | 'FAILED' | 'CANCELLED';
  /**
   * 活动尝试的截止 epoch 毫秒；等待或结束时清空。
   *
   * EN: The active attempt deadline in epoch milliseconds; cleared while waiting or after completion.
   */
  lease: number | null;
  steps: number;
  checkpointRef: string | null;
  error?: string;
}
/**
 * 模型返回的原始工具调用；arguments 保留 JSON 字符串，执行前由工具 schema 校验。
 *
 * EN: The original model tool call; arguments remains a JSON string until the tool schema validates it before execution.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
/**
 * 会话按 ordinal 排序；工具结果通过 callId 对应模型发起的调用。
 *
 * EN: Messages are ordered by ordinal; tool results answer model calls through callId.
 */
export interface Message extends Entity {
  /**
   * 只读展示元数据；完整供应商推理仍保存在 reasoningContent 中供重放。
   *
   * EN: Read-only display metadata. Full provider reasoning remains in reasoningContent for replay.
   */
  reasoning?: import('./reasoning.js').ReasoningDisplay;
  sourceInboxId?: string;
  purpose?: 'model_handoff' | 'runtime_notice';
  handoffHistoryRef?: string;
  requestId?: string;
  contentRef?: string;
  providerNativeRef?: string;
  runId: string;
  sessionId: string;
  ordinal: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /**
   * 仅 assistant 消息持有调用；后续 tool 消息逐个按 callId 回答。
   *
   * EN: Only assistant messages own calls; later tool messages answer each one by callId.
   */
  calls?: ToolCall[];
  callId?: string;
  /**
   * 当前供应商协议所需的原生重放项，不等同于公开正文或通用交接资料。
   *
   * EN: Native replay items required by the current provider protocol, distinct from public text or generic handoff material.
   */
  native?: unknown[];
  reasoningContent?: string;
  providerKind?: string;
}
/**
 * 各项用量可为 null：未知不等于零；原始供应商数据单独保留。
 *
 * EN: Usage fields may be null: unknown is not zero, and original provider data is retained separately.
 */
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
  /**
   * 区分缓存写入是否已包含在 inputTotal，避免重复计费；未知时保持 null。
   *
   * EN: Records whether cache writes are already included in inputTotal to prevent double billing; unknown remains null.
   */
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
/**
 * 请求先预约资源，再记录结算、未知或释放状态；usage 可缺失。
 *
 * EN: Requests reserve resources first, then become settled, unknown, or released; usage may be absent.
 */
export interface RequestRecord extends Entity {
  purpose?: 'assistant' | 'tool-review';
  /**
   * 只读展示元数据；展示缓存独立于请求计费账本。
   *
   * EN: Read-only display metadata; the display cache is independent of request accounting.
   */
  reasoning?: import('./reasoning.js').ReasoningDisplay;
  runId: string;
  taskId: string;
  attemptId: string;
  /**
   * 同一个逻辑请求的标识，与每次实际请求记录的 id 分开。
   *
   * EN: Identifies one logical request separately from the ID of each actual request record.
   */
  logicalId: string;
  providerId: string;
  providerBinding: ProviderConfig;
  manifest: Record<string, unknown>;
  /**
   * 输入估算加完整输出预留；UNKNOWN 状态继续占用，直到核验后结算或释放。
   *
   * EN: Reserves estimated input plus the full output allowance; UNKNOWN retains the reservation until verified settlement or release.
   */
  reservedTokens: number;
  reservedCost: number | null;
  status: 'RESERVED' | 'SETTLED' | 'UNKNOWN' | 'RELEASED';
  usage: Usage | null;
  startedAt: number;
  error?: string;
}
/**
 * 已登记的内容寻址产物；verified 是验收标记，登记成功本身不代表验收通过。
 *
 * EN: A registered content-addressed artifact; verified marks acceptance, and registration alone does not imply acceptance.
 */
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
/**
 * 对外部文件/页面读取结果的冻结快照，来源正文始终作为不可信资料处理。
 *
 * EN: A frozen snapshot of an external file/page read; its source body is always treated as untrusted data.
 */
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
/**
 * 工具副作用账本：先登记 INTENT，完成或失败后保存回执，中断时可能转为 UNCERTAIN。
 *
 * EN: Tool side-effect ledger: record INTENT first, then a success/failure receipt; interruption can leave UNCERTAIN.
 */
export interface Operation extends Entity {
  review?: ToolReviewReceipt;
  runId: string;
  taskId: string;
  attemptId: string;
  toolCallId: string;
  /**
   * 持久保存的、拥有本次调用的助手响应身份；供应商调用 ID 保持不变。
   *
   * EN: Durable assistant response owning this invocation; provider IDs remain unchanged.
   */
  assistantMessageId?: string;
  name: string;
  args: Record<string, unknown>;
  status: 'INTENT' | 'DONE' | 'FAILED' | 'UNCERTAIN';
  result?: unknown;
  /**
   * 例如写入前后哈希或命令后端信息，用于中断后的结果核验。
   *
   * EN: Evidence such as before/after write hashes or command backend information, used to verify outcomes after interruption.
   */
  evidence?: Record<string, unknown>;
  error?: string;
}
/**
 * 同一运行内 seq 单调排序，供 SSE 续读；eventId 为事件身份，不作为跨运行游标。
 *
 * EN: seq is monotonic within one run for SSE continuation; eventId identifies an event and is not a cross-run cursor.
 */
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
/**
 * 带稳定错误码、重试提示、诊断详情及 HTTP 状态的应用错误。
 *
 * EN: An application error with a stable code, retry hint, diagnostics, and HTTP status.
 */
export class AppError extends Error {
  /** 创建宿主可映射的错误；默认不自动重试且 HTTP 状态为 400，details 由具体入口决定是否公开。
   * EN: Creates a host-mappable error; defaults to nonretryable HTTP 400, with each endpoint deciding whether details are public.
   */
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
/**
 * 统一拒绝违反领域前提的操作；成功时向 TypeScript 收窄 condition。
 *
 * EN: Rejects violated domain preconditions consistently; a successful check narrows condition for TypeScript.
 */
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(code, message);
}
/**
 * 用户命令的幂等身份与可选乐观并发修订。
 *
 * EN: Idempotent identity for a user command, with an optional optimistic concurrency revision.
 */
export const Command = z.object({
  commandId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().optional(),
});
/**
 * 将一条验收标准索引绑定到实际文件、产物或命令；哈希用于核验引用内容未变化。
 *
 * EN: Binds an acceptance-criterion index to a real file, artifact, or command; hashes verify that referenced content has not changed.
 */
export const Evidence = z.object({
  criterion: z.number().int().nonnegative(),
  type: z.enum(['file', 'artifact', 'command']),
  ref: z.string().min(1),
  hash: z.string().optional(),
  note: z.string().min(1),
});
export type Evidence = z.infer<typeof Evidence>;
