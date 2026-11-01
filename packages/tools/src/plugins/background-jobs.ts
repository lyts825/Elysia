/** 后台命令沿用统一工具网关，读取和取消只作用于调用任务自己的作业。 */
import { z } from 'zod';
import { BackgroundCommand } from '../../../contracts/src/background-jobs.js';
import { invariant } from '../../../contracts/src/index.js';
import { defineTool, type ToolContribution } from '../tool-plugin.js';
import type { PluginContributions } from '../../../plugins/src/index.js';
import type { BackgroundJobs } from '../background-jobs.js';

export function backgroundJobTools(
  jobs: Pick<BackgroundJobs, 'start' | 'read' | 'cancel'>,
): PluginContributions<ToolContribution> {
  const selected = z.object({ jobId: z.string().uuid() }).strict();
  const page = selected.extend({
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(2).max(24000).default(12000),
  });
  return {
    manifest: { id: 'tools.background-jobs', version: '1.0.0', apiVersion: 1 },
    contributions: {
      job_start: defineTool(
        'job_start',
        BackgroundCommand,
        '在原授权工作区启动有界后台命令，立即返回jobId和executionOperationId；回执不代表命令成功。完成结果自动作为资料送回本任务。后台命令期间只能读资料、处理反馈或取消；禁止并发写入、提交验收或再次执行命令。超时受累计运行预算限制。',
        { transaction: false, serial: true, mutating: true, progress: false },
        ({ task, operation, signal }, args) => jobs.start(task, operation, args, signal),
      ),
      job_read: defineTool(
        'job_read',
        page,
        '读取本任务后台命令的持久状态及输出分页（offset/limit为字符位置，最多24000字符）。RUNNING和UNCERTAIN都不是成功。完成结果自动投递，无需循环轮询。',
        { transaction: false, serial: true, mutating: false, progress: false },
        ({ task }, args) => {
          const job = jobs.read(task.runId, args.jobId);
          invariant(job.taskId === task.id, 'JOB_SCOPE', '只能读取本任务的后台作业');
          const text = job.result
            ? job.result.stdout + (job.result.stderr ? '\n[stderr]\n' + job.result.stderr : '')
            : '';
          const boundary = (index: number) =>
            index > 0 &&
            index < text.length &&
            /[\uDC00-\uDFFF]/.test(text[index]) &&
            /[\uD800-\uDBFF]/.test(text[index - 1])
              ? index - 1
              : index;
          const offset = boundary(Math.min(args.offset, text.length)),
            end = boundary(Math.min(offset + args.limit, text.length));
          return {
            jobId: job.id,
            executionOperationId: job.executionOperationId,
            status: job.status,
            stopConfirmed: job.stopConfirmed,
            error: job.error,
            result: job.result
              ? {
                  exitCode: job.result.exitCode,
                  timedOut: job.result.timedOut,
                  truncated: job.result.truncated,
                }
              : undefined,
            output: {
              text: text.slice(offset, end),
              offset,
              nextOffset: end < text.length ? end : null,
              totalCharacters: text.length,
            },
            trust: 'untrusted',
          };
        },
      ),
      job_cancel: defineTool(
        'job_cancel',
        selected,
        '停止本任务的后台命令并等待退出核验；停止不撤销已经发生的副作用，UNCERTAIN需人工核验后才可继续。',
        { transaction: false, serial: true, mutating: false, progress: false },
        async ({ task }, args) => {
          invariant(
            jobs.read(task.runId, args.jobId).taskId === task.id,
            'JOB_SCOPE',
            '只能停止本任务的后台作业',
          );
          return jobs.cancel(task.runId, args.jobId);
        },
      ),
    },
  };
}
