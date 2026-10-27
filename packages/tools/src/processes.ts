/**
 * 管理子进程执行及传递给子进程的环境变量。
 * EN: Manage child-process execution and the environment variables passed to children.
 *
 * 统一处理输出收集、取消、超时及进程树清理，并筛选子进程环境；结果返回退出码、输出截断和超时标记，不提供通用的取消原因字段。
 * EN: Centralize output, cancellation, timeout, process-tree cleanup, and environment filtering. Return exit code, output-truncation and timeout flags, without a general cancellation-reason field.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from '../../contracts/src/index.js';
/**
 * 仅传递启动程序和定位用户目录所需的环境变量，不继承其他变量。
 * EN: Pass only variables required to locate programs and user directories instead of inheriting the
 * entire environment.
 */
export function cleanEnv() {
  const keys = [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
  ];
  return Object.fromEntries(keys.filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
}
export class Processes {
  /**
   * 按 PID 保存所属任务，供任务取消时定向终止进程。
   * EN: Associate active PIDs with their task so task cancellation can target the correct process
   * tree.
   */
  children = new Map<number, { taskId: string; child: ReturnType<typeof spawn> }>();
  /**
   * Windows 使用 taskkill 终止进程树；其他平台终止独立进程组。
   * EN: Use taskkill for Windows process trees and terminate isolated process groups on other
   * platforms.
   */
  async kill(pid: number) {
    const record = this.children.get(pid);
    if (!record) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const p = spawn(
          path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore', env: cleanEnv() },
        );
        p.on('error', () => resolve());
        p.on('exit', () => resolve());
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
  }
  /**
   * 对活动 PID 表按任务过滤并并行终止；未传集合时清理本实例管理的全部进程。
   * EN: Filter active PIDs by task and terminate them concurrently. Omitting the set cleans all
   * processes managed by this instance.
   */
  async cancel(taskIds?: Set<string>) {
    await Promise.all(
      [...this.children.entries()]
        .filter(([, r]) => !taskIds || taskIds.has(r.taskId))
        .map(([pid]) => this.kill(pid)),
    );
  }
  /**
   * 在指定目录执行程序。stdout 与 stderr 共享 outputLimit 原始字节预算；超限后继续消费输出，
   * 只解码预算内的字节。超时会终止进程并通过 timedOut 标记，启动失败则抛错。
   * EN: Run a program in the specified directory. stdout and stderr share outputLimit raw bytes;
   * continue consuming excess output but decode only retained bytes. A timeout terminates the process
   * and sets timedOut; startup failure rejects.
   */
  run(
    taskId: string,
    program: string,
    args: string[],
    cwd: string,
    timeout: number,
    outputLimit: number,
    signal?: AbortSignal,
  ): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
  }> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const child = spawn(program, args, {
        cwd,
        env: cleanEnv(),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let stdout = '',
        stderr = '',
        bytes = 0,
        truncated = false,
        timedOut = false;
      if (child.pid) this.children.set(child.pid, { taskId, child });
      /**
       * 按两个输出流的共享预算截取原始字节，再分别累积解码文本。
       * EN: Retain raw bytes under the shared stdout/stderr budget and accumulate decoded text by stream.
       */
      const record = (target: 'stdout' | 'stderr', data: Buffer) => {
        // 两个输出流共用上限，以实际到达顺序分配剩余字节。
        // EN: Both streams share one budget, allocating remaining bytes in actual arrival order.
        const remaining = Math.max(0, outputLimit - bytes);
        bytes += data.length;
        const chunk = data.subarray(0, remaining).toString('utf8');
        if (target === 'stdout') stdout += chunk;
        else stderr += chunk;
        if (bytes > outputLimit) truncated = true;
      };
      child.stdout?.on('data', (data) => record('stdout', data));
      child.stderr?.on('data', (data) => record('stderr', data));
      /**
       * 请求终止已登记的子进程树，完成清理由close或error事件执行。
       * EN: Request termination of the registered child tree; close/error events perform lifecycle cleanup.
       */
      const abort = () => {
        if (child.pid) void this.kill(child.pid);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      /**
       * 清除超时、取消监听与PID登记，供启动错误和关闭事件共用。
       * EN: Clear timeout, abort listener, and PID registration for both startup errors and close events.
       */
      const cleanup = () => {
        // 启动错误和正常关闭都需要释放定时器、监听器及 PID 登记。
        // EN: Both startup errors and ordinary closure must release the timer, abort listener, and PID
        // registration.
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (child.pid) this.children.delete(child.pid);
      };
      child.on('error', (error) => {
        cleanup();
        reject(new AppError('PROCESS_START', error.message));
      });
      child.on('close', (exitCode) => {
        cleanup();
        resolve({ exitCode, stdout, stderr, truncated, timedOut });
      });
    });
  }
}
