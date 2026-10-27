// 管理子进程执行及传递给子进程的环境变量。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from '../../contracts/src/index.js';
/** 仅传递启动程序和定位用户目录所需的环境变量，不继承其他变量。 */
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
  /** 按 PID 保存所属任务，供任务取消时定向终止进程。 */
  children = new Map<number, { taskId: string; child: ReturnType<typeof spawn> }>();
  /** Windows 使用 taskkill 终止进程树；其他平台终止独立进程组。 */
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
      const record = (target: 'stdout' | 'stderr', data: Buffer) => {
        // 两个输出流共用上限，以实际到达顺序分配剩余字节。
        const remaining = Math.max(0, outputLimit - bytes);
        bytes += data.length;
        const chunk = data.subarray(0, remaining).toString('utf8');
        if (target === 'stdout') stdout += chunk;
        else stderr += chunk;
        if (bytes > outputLimit) truncated = true;
      };
      child.stdout?.on('data', (data) => record('stdout', data));
      child.stderr?.on('data', (data) => record('stderr', data));
      const abort = () => {
        if (child.pid) void this.kill(child.pid);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => {
        // 启动错误和正常关闭都需要释放定时器、监听器及 PID 登记。
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
