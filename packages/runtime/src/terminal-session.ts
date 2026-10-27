/** 定义和读写终端会话及其状态。 */
import { z } from 'zod';
import type { AgentTerminalProfile, Run, Task } from '../../contracts/src/index.js';
import { hash, stable, type Store } from '../../storage/src/index.js';

export type TerminalContinuationMode = 'resume' | 'new-session';
export interface TerminalSessionView {
  supported: boolean;
  canResume: boolean;
  canStartNew: boolean;
  reason: string;
  revision: number;
  sessionId?: string;
  lastOperationId?: string;
}
export const TerminalSessionRecordSchema = z.object({
  revision: z.number().int().nonnegative(),
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  profileHash: z.string(),
  authorityHash: z.string(),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  homeOperationId: z.string().uuid(),
  lastOperationId: z.string().uuid(),
  ready: z.boolean(),
  sessionId: z.string().max(200).optional(),
  state: z.object({ path: z.string().max(1000), hash: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  pending: z
    .object({
      requestId: z.string().uuid(),
      mode: z.enum(['resume', 'new-session']),
      text: z
        .string()
        .trim()
        .min(1)
        .max(1024 * 1024),
      sourceOperationId: z.string().uuid(),
      inboxIds: z.array(z.string().uuid()).max(100).optional(),
    })
    .optional(),
});
const Session = TerminalSessionRecordSchema;
export type TerminalSessionRecord = z.infer<typeof Session>;
export const TerminalStateOwnerSchema = z.object({
  format: z.literal('elysia-terminal-state-v1'),
  owner: z.string().regex(/^[a-f0-9]{32}$/),
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  operationId: z.string().uuid(),
  homeOperationId: z.string().uuid(),
  stopped: z.boolean().optional(),
});
export type TerminalStateOwner = z.infer<typeof TerminalStateOwnerSchema>;
export interface TerminalMaintenanceSnapshot {
  run: Run;
  task: Task;
  operation: import('../../contracts/src/index.js').Operation;
  record: TerminalSessionRecord;
  home: string;
  workspace: string;
  imageId: string;
  rollout: { path: string; relativePath: string; exists: boolean; hash: string | null };
  consistent: boolean;
}
const key = (taskId: string) => `terminal-session:${taskId}`;
export function readTerminalSession(store: Store, taskId: string): TerminalSessionRecord | undefined {
  const row = store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(key(taskId)) as
    | { value: string }
    | undefined;
  return row ? Session.parse(JSON.parse(row.value)) : undefined;
}
export function writeTerminalSession(store: Store, record: TerminalSessionRecord) {
  store.db
    .prepare(
      'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key(record.taskId), stable(Session.parse(record)));
}
export function terminalSessionIdentity(run: Run, task: Task) {
  return {
    profileHash: hash(stable(run.execution?.kind === 'docker-agent' ? run.execution.profile : null)),
    authorityHash: hash(
      stable({
        contract: run.contract,
        limits: run.limits,
        authorized: run.authorized,
        kind: run.kind,
        planMode: run.planMode,
        contractVersion: task.contractVersion,
        spec: task.spec,
      }),
    ),
  };
}
/** Called only after the exact immutable image's help has confirmed this argv shape. */
export function codexResumeProfile(profile: AgentTerminalProfile, sessionId: string): AgentTerminalProfile {
  return {
    ...profile,
    command: ['codex', 'exec', 'resume', ...profile.command.slice(2, -1), sessionId, '-'],
  };
}
