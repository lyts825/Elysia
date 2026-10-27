// 封装命令执行请求及 Docker 命令参数构造。
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { AppError, invariant } from '../../contracts/src/index.js';
import { hash } from '../../contracts/src/identity.js';
import type { CommandBackendPolicy } from '../../contracts/src/execution-policy.js';
import { contained } from './path-policy.js';
import { Processes } from './processes.js';

export type ProcessRunner = Pick<Processes, 'run'>;
export interface CommandRequest {
  operationId: string;
  taskId: string;
  workspace: string;
  cwd: string;
  program: string;
  args: string[];
  timeout: number;
  outputLimit: number;
  writable: boolean;
  backend: CommandBackendPolicy;
}
export interface CommandRunner {
  run(request: CommandRequest, signal: AbortSignal): ReturnType<Processes['run']>;
  cancel(taskIds?: Set<string>): Promise<void>;
  recover?(): Promise<void>;
}

export function dockerCommandArguments(request: CommandRequest, scope: string) {
  invariant(request.backend.kind === 'docker', 'COMMAND_BACKEND', '命令后端不匹配');
  invariant(
    contained(request.workspace, request.cwd) && !request.workspace.includes(','),
    'EXEC_SCOPE',
    '容器挂载路径无效或超出任务目录',
  );
  const workdir =
    '/workspace' +
    (path.relative(request.workspace, request.cwd)
      ? '/' + path.relative(request.workspace, request.cwd).split(path.sep).join('/')
      : '');
  const name = 'elysia-cmd-' + request.operationId;
  invariant(/^[a-zA-Z0-9-]+$/.test(name), 'COMMAND_ID', '命令标识无效');
  return {
    name,
    args: [
      'create',
      '--name',
      name,
      '--label',
      'elysia.command-scope=' + scope,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--memory',
      '1g',
      '--cpus',
      '1',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--mount',
      `type=bind,src=${request.workspace},dst=/workspace${request.writable ? '' : ',readonly'}`,
      '--workdir',
      workdir,
      '--pull',
      'never',
      '--entrypoint',
      request.program,
      request.backend.image,
      ...request.args,
    ],
  };
}

/** Only model-invoked exec uses this backend. Host maintenance Git and UI processes stay separate. */
export class ConfiguredCommandRunner implements CommandRunner {
  private readonly scope: string;
  private readonly active = new Map<string, string>();
  private ready?: Promise<void>;
  constructor(
    private processes: ProcessRunner,
    directory: string,
    private admin: ProcessRunner = new Processes(),
  ) {
    this.scope = hash(path.resolve(directory)).slice(0, 24);
  }
  private async remove(name: string) {
    const result = await this.admin.run(
      'container-cleanup',
      'docker',
      ['rm', '--force', name],
      process.cwd(),
      15000,
      8000,
    );
    if (result.timedOut || (result.exitCode !== 0 && !/No such container/i.test(result.stderr)))
      throw new AppError('COMMAND_CLEANUP', '无法确认命令容器已停止：' + result.stderr);
  }
  recover() {
    return (this.ready ??= this.cleanStaleContainers().catch((error) => {
      this.ready = undefined;
      throw error;
    }));
  }
  private async cleanStaleContainers() {
    const result = await this.admin.run(
      'container-recovery',
      'docker',
      ['ps', '-aq', '--filter', 'label=elysia.command-scope=' + this.scope],
      process.cwd(),
      15000,
      16000,
    );
    invariant(
      result.exitCode === 0 && !result.truncated && !result.timedOut,
      'DOCKER_UNAVAILABLE',
      'Docker 引擎不可用：' + result.stderr,
    );
    for (const id of result.stdout.split(/\s+/).filter(Boolean)) {
      invariant(/^[a-f0-9]{12,64}$/.test(id), 'COMMAND_RECOVERY', '容器清单无法核验');
      await this.remove(id);
    }
  }
  async cancel(taskIds?: Set<string>) {
    const results = await Promise.allSettled(
      [...this.active]
        .filter(([, task]) => !taskIds || taskIds.has(task))
        .map(async ([name]) => {
          await this.remove(name);
          this.active.delete(name);
        }),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length)
      throw new AggregateError(
        failed.map((r) => r.reason),
        '命令容器停止未确认',
      );
  }
  async run(request: CommandRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (request.backend.kind === 'local')
      return this.processes.run(
        request.taskId,
        request.program,
        request.args,
        request.cwd,
        request.timeout,
        request.outputLimit,
        signal,
      );
    // A failed initialization can be retried, but never falls back to a host command.
    await this.recover();
    signal.throwIfAborted();
    request = { ...request, workspace: await realpath(request.workspace), cwd: await realpath(request.cwd) };
    const { name, args } = dockerCommandArguments(request, this.scope);
    this.active.set(name, request.taskId);
    try {
      const created = await this.processes.run(
        request.taskId,
        'docker',
        args,
        request.cwd,
        30000,
        8000,
        signal,
      );
      signal.throwIfAborted();
      invariant(
        created.exitCode === 0 && !created.timedOut,
        'COMMAND_CONTAINER',
        '命令容器创建失败：' + created.stderr,
      );
      return await this.processes.run(
        request.taskId,
        'docker',
        ['start', '--attach', name],
        request.cwd,
        request.timeout,
        request.outputLimit,
        signal,
      );
    } finally {
      await this.remove(name);
      this.active.delete(name);
    }
  }
}
