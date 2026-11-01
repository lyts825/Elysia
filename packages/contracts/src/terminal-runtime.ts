/**
 * 终端任务运行阶段、活动和资源预设的契约。
 * 公开执行阶段与任务状态分开；review/verification 表示等待验收或核验，而非 CLI 仍在运行。
 * 状态快照只解释当前准入与资源占用，不承诺排队顺序、CLI效果或真实环境验收。
 *
 * EN: Defines terminal runtime phases, activity, and resource presets.
 * Public execution phases are separate from task status; review/verification means awaiting acceptance or reconciliation, not that the CLI is still running.
 * Snapshots explain current admission/resource use without promising queue order, CLI effectiveness, or live acceptance.
 */
export type TerminalRuntimePhase =
  | 'preparing'
  | 'starting'
  | 'running'
  | 'finalizing'
  | 'review'
  | 'verification'
  | 'unavailable'
  | 'stopped';

/**
 * 公开活动时间不含 CLI 私有推理或原始传输诊断。
 *
 * EN: Public activity times never include private CLI reasoning or raw transport diagnostics.
 */
export interface TerminalTaskRuntime {
  runId: string;
  taskId: string;
  operationId?: string;
  phase: TerminalRuntimePhase;
  phaseStartedAt: number;
  lastPublicActivityAt?: number;
  revision: number;
}
/**
 * 队列原因区分并发、依赖和终端资源等限制，供状态展示使用。
 *
 * EN: Queue reasons distinguish concurrency, dependencies, and terminal resources for display.
 */
export type RuntimeQueueReason =
  | 'ready'
  | 'global-concurrency'
  | 'run-concurrency'
  | 'account-concurrency'
  | 'resident-memory'
  | 'dependencies'
  | 'execution-preparing'
  | 'execution-unavailable'
  | 'terminal-resources'
  | 'terminal-capacity'
  | 'terminal-engine';
export const terminalResourcePresets = ['light', 'standard', 'large'] as const;
export type TerminalResourcePreset = (typeof terminalResourcePresets)[number];
/**
 * 调度预留量；memoryMiB 使用 MiB，不能与字节统计直接相加。
 *
 * EN: Scheduling reservations; memoryMiB is in MiB and must not be added directly to byte counts.
 */
export interface TerminalResourceAmount {
  sessions: number;
  cpus: number;
  memoryMiB: number;
}
/**
 * 缺少字段时保持原有标准资源分配，不改写已冻结模板。
 *
 * EN: Missing values retain the original standard allocation without changing frozen profiles.
 */
export function terminalResourceRequirement(preset?: TerminalResourcePreset): TerminalResourceAmount {
  const cpus = preset === 'light' ? 1 : preset === 'large' ? 4 : 2;
  return { sessions: 1, cpus, memoryMiB: cpus * 1024 };
}
/**
 * 当前轮次的排队说明，position 和 reason 是快照，不构成永久执行顺序或启动承诺。
 *
 * EN: Queue information for this pass; position and reason are snapshots, not a permanent order or a promise to start.
 */
export interface RuntimeQueueEntry {
  runId: string;
  taskId: string;
  position: number;
  reason: RuntimeQueueReason;
  resourcePreset?: TerminalResourcePreset;
}
export interface ExecutorRuntimeSnapshot {
  revision: number;
  queue: RuntimeQueueEntry[];
  activeTaskIds: string[];
  queuedTotal?: number;
  queueTruncated?: boolean;
  residentLimit?: number;
}
/**
 * 容量、预留和各类占用的同一修订视图；held 资源需要恢复/清理确认后才能释放。
 *
 * EN: One revision of capacity, reservations, and usage; held resources require confirmed recovery/cleanup before release.
 */
export interface TerminalResourceSnapshot {
  revision: number;
  status: 'unknown' | 'ready' | 'unavailable';
  message: string;
  capacity: { sessions: number; cpus: number; memoryMiB: number };
  reserved: { sessions: number; cpus: number; memoryMiB: number };
  reservations: {
    id: string;
    kind: 'task' | 'installation' | 'probe';
    held: boolean;
    resources: TerminalResourceAmount;
    resourcePreset?: TerminalResourcePreset;
    reason?: string;
    owner?: {
      runId: string;
      taskId: string;
      operationId?: string;
      runTitle: string;
      taskTitle: string;
      reason: string;
    };
  }[];
  waitingInstallations: number;
  waitingProbes: number;
  /**
   * 这里协调 Docker 构建准入，并非 BuildKit 的内存硬限制。
   *
   * EN: Docker build admission is coordinated here; this is not a BuildKit memory hard limit.
   */
  installationHardLimit: false;
}
export interface TerminalRuntimeSnapshot {
  revision: number;
  tasks: TerminalTaskRuntime[];
  resources: TerminalResourceSnapshot;
}
/**
 * 能力支持、适配器验证和真实环境验收分开，conditional/unknown 不能按已支持展示。
 *
 * EN: Capability support, adapter validation, and real-environment acceptance are separate; conditional/unknown must not be displayed as supported.
 */
export interface TerminalFeatureCapability {
  status: 'supported' | 'conditional' | 'unsupported' | 'unknown';
  validation: 'adapter' | 'fixed-image-required' | 'unverified';
  realVerified: boolean;
  reason: string;
}
export interface TerminalCliCapability {
  appId: 'codex' | 'dsh' | 'claude' | 'gemini' | 'antigravity' | 'custom';
  execution: TerminalFeatureCapability;
  planning: TerminalFeatureCapability;
  resume: TerminalFeatureCapability;
  usage: TerminalFeatureCapability;
}
