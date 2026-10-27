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
/** 持久会话身份与待续接请求；ready 只表示上一轮可靠完成，能否 resume 还须验证私有状态。 */
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
  // 私有 rollout 的相对路径和内容摘要用于防止会话文件被替换后继续沿用旧身份。
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
/** 按任务 ID 读取终端会话；记录不存在时返回 undefined，存在时校验结构。 */
export function readTerminalSession(store: Store, taskId: string): TerminalSessionRecord | undefined {
  const row = store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(key(taskId)) as
    | { value: string }
    | undefined;
  return row ? Session.parse(JSON.parse(row.value)) : undefined;
}
/** 校验会话结构并按任务 ID 写入存储元数据。 */
export function writeTerminalSession(store: Store, record: TerminalSessionRecord) {
  store.db
    .prepare(
      'INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key(record.taskId), stable(Session.parse(record)));
}
/** 计算执行配置及任务授权快照的指纹，用于判断会话续接是否仍匹配。 */
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
/** 仅在固定镜像的帮助信息已确认 resume 形态后使用；保留原命令权限参数并替换会话输入形式。 */
export function codexResumeProfile(profile: AgentTerminalProfile, sessionId: string): AgentTerminalProfile {
  return {
    ...profile,
    command: ['codex', 'exec', 'resume', ...profile.command.slice(2, -1), sessionId, '-'],
  };
}
