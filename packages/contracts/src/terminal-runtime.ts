export type TerminalRuntimePhase =
  | 'preparing'
  | 'starting'
  | 'running'
  | 'finalizing'
  | 'review'
  | 'verification'
  | 'unavailable'
  | 'stopped';

/** Public activity times never include private CLI reasoning or raw transport diagnostics. */
export interface TerminalTaskRuntime {
  runId: string;
  taskId: string;
  operationId?: string;
  phase: TerminalRuntimePhase;
  phaseStartedAt: number;
  lastPublicActivityAt?: number;
  revision: number;
}
export type RuntimeQueueReason =
  | 'ready'
  | 'global-concurrency'
  | 'run-concurrency'
  | 'account-concurrency'
  | 'dependencies'
  | 'terminal-resources'
  | 'terminal-capacity'
  | 'terminal-engine';
export const terminalResourcePresets = ['light', 'standard', 'large'] as const;
export type TerminalResourcePreset = (typeof terminalResourcePresets)[number];
export interface TerminalResourceAmount {
  sessions: number;
  cpus: number;
  memoryMiB: number;
}
/** Missing values retain the original standard allocation without changing frozen profiles. */
export function terminalResourceRequirement(preset?: TerminalResourcePreset): TerminalResourceAmount {
  const cpus = preset === 'light' ? 1 : preset === 'large' ? 4 : 2;
  return { sessions: 1, cpus, memoryMiB: cpus * 1024 };
}
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
}
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
  /** Docker build admission is coordinated here; this is not a BuildKit memory hard limit. */
  installationHardLimit: false;
}
export interface TerminalRuntimeSnapshot {
  revision: number;
  tasks: TerminalTaskRuntime[];
  resources: TerminalResourceSnapshot;
}
export interface TerminalFeatureCapability {
  status: 'supported' | 'conditional' | 'unsupported' | 'unknown';
  validation: 'adapter' | 'fixed-image-required' | 'unverified';
  realVerified: boolean;
  reason: string;
}
export interface TerminalCliCapability {
  appId: 'codex' | 'dsh' | 'claude' | 'gemini' | 'custom';
  execution: TerminalFeatureCapability;
  planning: TerminalFeatureCapability;
  resume: TerminalFeatureCapability;
  usage: TerminalFeatureCapability;
}
