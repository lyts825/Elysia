/** 原生后台命令的启动、执行结果和上下文投递是三个独立事实。 */
import { z } from 'zod';

export const BackgroundCommand = z
  .object({
    program: z.string().min(1).max(4096),
    args: z.array(z.string().max(32768)).max(100),
    cwd: z.string().min(1).max(4096).default('.'),
    timeout: z.number().int().min(100).max(3600000).default(300000),
    outputLimit: z.number().int().min(1000).max(200000).default(40000),
  })
  .strict();
export type BackgroundCommand = z.infer<typeof BackgroundCommand>;
export const BackgroundResult = z
  .object({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
  })
  .strict();
export type BackgroundResult = z.infer<typeof BackgroundResult>;
export const BackgroundJob = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    attemptId: z.string().uuid(),
    executionOperationId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'RESOLVED']),
    command: BackgroundCommand,
    createdAt: z.string(),
    updatedAt: z.string(),
    finishedAt: z.string().optional(),
    deliveredAt: z.string().optional(),
    cancelRequestedAt: z.string().optional(),
    stopConfirmed: z.boolean().default(false),
    result: BackgroundResult.optional(),
    error: z.string().max(2000).optional(),
    account: z.string(),
    accountConcurrency: z.number().int().positive(),
  })
  .strict();
export type BackgroundJob = z.infer<typeof BackgroundJob>;
export type BackgroundJobSummary = Omit<BackgroundJob, 'result' | 'command'> & {
  command: Pick<BackgroundCommand, 'program' | 'cwd' | 'timeout' | 'outputLimit'>;
  resultAvailable: boolean;
};
export const unsettledBackgroundJob = (job: BackgroundJob) =>
  job.status === 'RUNNING' || job.status === 'UNCERTAIN';
