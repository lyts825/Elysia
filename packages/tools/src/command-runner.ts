/**
 * 封装命令执行请求及 Docker 命令参数构造。
 * EN: Define command execution requests and construct Docker backend arguments.
 *
 * 将命令语义转换为选定后端所需参数，保留工作目录、权限和限制信息；进程生命周期及结果登记由执行层管理。
 * EN: Translate command semantics into backend arguments while retaining directory, permission, and limit information; execution manages lifecycle and result records.
 */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { AppError, invariant } from '../../contracts/src/index.js';
import { hash } from '../../contracts/src/identity.js';
import type { CommandBackendPolicy } from '../../contracts/src/execution-policy.js';
import { contained } from './path-policy.js';
import { Processes } from './processes.js';

export type ProcessRunner = Pick<Processes, 'run'>;
export interface CommandRequest {
  /**
   * 操作账本 ID，同时参与确定容器名称，便于取消和中断恢复。
   * EN: The operation-ledger ID also determines the container name for cancellation and interrupted
   * recovery.
   */
  operationId: string;
  /**
   * 用于归属进程和取消范围，不作为容器内路径。
   * EN: Identify process ownership and cancellation scope; this is not a container path.
   */
  taskId: string;
  /**
   * 任务根目录；Docker 后端只挂载该目录。
   * EN: The task root directory is the only directory mounted by the Docker backend.
   */
  workspace: string;
  /**
   * 真实工作目录，必须在 workspace 内，映射为容器的 /workspace 相对路径。
   * EN: The real working directory must be inside workspace and is mapped beneath /workspace in the
   * container.
   */
  cwd: string;
  /**
   * 直接执行的程序和独立参数，不作为拼接后的 shell 字符串解释。
   * EN: Execute a program with separate arguments, not a concatenated shell command string.
   */
  program: string;
  args: string[];
  /**
   * 附着运行阶段的超时毫秒数；容器创建和清理另有各自上限。
   * EN: Timeout in milliseconds for attached execution; container creation and cleanup have separate
   * limits.
   */
  timeout: number;
  /**
   * stdout/stderr 共享的原始字节保留预算。
   * EN: A shared raw-byte retention budget for stdout and stderr.
   */
  outputLimit: number;
  /**
   * 整个工作区是否可写；部分路径写入授权不能提升为整目录可写挂载。
   * EN: Whether the entire workspace may be mounted writable. Partial path grants cannot become
   * whole-directory write access.
   */
  writable: boolean;
  /**
   * 来自运行冻结合同的后端配置；Docker 失败不会回退本机。
   * EN: The backend is frozen in the run contract; Docker failure never falls back to local execution.
   */
  backend: CommandBackendPolicy;
}
export interface CommandRunner {
  /**
   * 启动一次命令并返回结束状态；结果不代表业务副作用已通过验收。
   * EN: Run one command and return its termination result; this does not verify the business effects
   * of the command.
   */
  run(request: CommandRequest, signal: AbortSignal): ReturnType<Processes['run']>;
  /**
   * 未传 taskIds 时停止全部受本实例管理的命令，传入空集合时不匹配任何任务。
   * EN: Omitting taskIds cancels all commands owned by this instance; an empty set matches none.
   */
  cancel(taskIds?: Set<string>): Promise<void>;
  /**
   * 清理本数据目录遗留的后端资源，不能据此认定历史副作用已经撤销。
   * EN: Clean resources left by this data-directory backend. Cleanup does not prove earlier side
   * effects were undone.
   */
  recover?(): Promise<void>;
}

/**
 * 将本机工作目录映射到容器内的 /workspace，并生成 docker create 参数。
 * scope 是数据目录派生的标签，用于恢复时只查找本实例遗留的命令容器。
 * EN: Map the host working directory under container /workspace and build docker create arguments.
 * scope is a data-directory-derived label restricting recovery to containers owned by this instance.
 */
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

/**
 * 只有模型调用的exec使用此后端，宿主维护用Git和界面进程保持独立。
 * EN: Only model-invoked exec uses this backend. Host maintenance Git and UI processes remain
 * separate.
 */
export class ConfiguredCommandRunner implements CommandRunner {
  private readonly scope: string;
  private readonly active = new Map<string, string>();
  private ready?: Promise<void>;
  /**
   * directory 只用于派生稳定资源标签；admin 独立执行清理，避免随任务取消一起失效。
   * EN: Use directory only to derive a stable resource label. The independent admin runner performs
   * cleanup without sharing task cancellation.
   */
  constructor(
    private processes: ProcessRunner,
    directory: string,
    private admin: ProcessRunner = new Processes(),
  ) {
    this.scope = hash(path.resolve(directory)).slice(0, 24);
  }
  /**
   * 强制移除一个已知容器；不存在视为清理完成，其他错误或超时仍需保留待核验状态。
   * EN: Force-remove a known container. Absence counts as cleaned; other failures or timeout leave
   * cleanup unconfirmed.
   */
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
  /**
   * 并发启动复用一次恢复结果，恢复失败清除 ready 以便后续显式重试。
   * EN: Share one recovery attempt across concurrent starts; clear ready after failure to permit a
   * later explicit retry.
   */
  recover() {
    // 并发调用共享同一次恢复；失败后清除缓存，允许下次重试。
    // EN: Concurrent callers share recovery; failure clears the cached promise so a later call can
    // retry.
    return (this.ready ??= this.cleanStaleContainers().catch((error) => {
      this.ready = undefined;
      throw error;
    }));
  }
  /**
   * 只查找当前数据目录标签的容器，核对每个 Docker ID 后逐个移除。
   * 清单截断、超时或引擎不可用均中止恢复，不能把不完整清单当作已经清空。
   * EN: Find only containers labeled for this data directory, validate every Docker ID, and remove
   * them. Abort on truncated lists, timeout, or unavailable engine rather than treating an incomplete
   * list as empty.
   */
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
  /**
   * 所有匹配容器均尝试清理；成功项移出活动表，失败项保留供后续重试并汇总错误。
   * EN: Attempt cleanup for every matching container. Remove successful entries from the active map,
   * retain failed entries for retry, and aggregate errors.
   */
  async cancel(taskIds?: Set<string>) {
    // 等待所有匹配容器的清理结果，失败的容器保留在 active 中以便重试。
    // EN: Wait for all matching cleanup attempts; keep failed containers in active for later retry.
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
  /**
   * 本机模式直接委托进程执行，Docker 模式先完成遗留恢复和真实路径核验。
   * 容器先登记并创建，再附着运行；finally 始终清理，清理失败必须向上传递，
   * 避免把可能仍运行的命令报告成已安全结束。
   * EN: Delegate local execution directly. For Docker, first recover leftovers and verify real paths,
   * then register and create the container before attaching. Always clean in finally, propagating
   * cleanup failure rather than reporting a possibly live command safely stopped.
   */
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
    // 初始化失败可重试，但绝不回退为宿主命令。
    // EN: Failed initialization may be retried, but never falls back to a host command.
    await this.recover();
    signal.throwIfAborted();
    request = { ...request, workspace: await realpath(request.workspace), cwd: await realpath(request.cwd) };
    const { name, args } = dockerCommandArguments(request, this.scope);
    this.active.set(name, request.taskId);
    try {
      // 先创建后附着运行，使取消或失败时仍能按确定的名称清理容器。
      // EN: Create before attaching so cancellation or failure can still clean the container by a
      // deterministic name.
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
