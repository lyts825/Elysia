import { AppError } from '../../contracts/src/index.js';
import type { TerminalResourceSnapshot } from '../../contracts/src/terminal-runtime.js';

const requirement = { sessions: 1, cpus: 2, memoryMiB: 2048 };
type Kind = 'task' | 'installation';
/** Per-application admission, independent of the execution's immutable permission/budget binding. */
export class TerminalResourcePool {
  private state: TerminalResourceSnapshot['status'] = 'unknown';
  private message = '尚未读取 Docker 资源容量';
  private capacity = { sessions: 2, cpus: 4, memoryMiB: 4096 };
  private reservations = new Map<string, Kind>();
  private held = new Set<string>();
  private waiters: {
    id: string;
    resolve: () => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  }[] = [];
  private revision = 0;
  private last = '';
  has(id: string) {
    return this.reservations.has(id);
  }
  configure(cpus: number, memoryMiB: number) {
    if (!Number.isFinite(cpus) || cpus < 1 || !Number.isFinite(memoryMiB) || memoryMiB < 1) {
      this.unavailable('Docker 未返回可用的资源容量');
      return;
    }
    this.state = 'ready';
    this.capacity = {
      sessions: 2,
      cpus: Math.min(4, cpus),
      memoryMiB: Math.min(4096, Math.floor(memoryMiB)),
    };
    this.message =
      this.capacity.cpus < requirement.cpus || this.capacity.memoryMiB < requirement.memoryMiB
        ? 'Docker 资源不足以启动一个终端，请至少分配 2 CPU / 2048 MiB'
        : '终端按 2 CPU / 2048 MiB 预约，最多同时运行两个';
    this.drain();
  }
  unavailable(message: string) {
    this.state = 'unavailable';
    this.message = message;
  }
  private fits() {
    return (
      this.state === 'ready' &&
      (this.reservations.size + 1) * requirement.sessions <= this.capacity.sessions &&
      (this.reservations.size + 1) * requirement.cpus <= this.capacity.cpus &&
      (this.reservations.size + 1) * requirement.memoryMiB <= this.capacity.memoryMiB
    );
  }
  reason(): 'terminal-resources' | 'terminal-engine' {
    return this.state === 'ready' ? 'terminal-resources' : 'terminal-engine';
  }
  canAcquireTask(id: string) {
    return this.has(id) || (this.fits() && this.waiters.length === 0);
  }
  tryAcquire(id: string, kind: Kind = 'task') {
    if (this.reservations.has(id)) return true;
    // A user-requested install gets the next available slot rather than starving behind fresh tasks.
    if (!this.fits() || (kind === 'task' && this.waiters.length > 0)) return false;
    this.reservations.set(id, kind);
    return true;
  }
  hold(id: string) {
    this.reservations.set(id, 'task');
    this.held.add(id);
  }
  confirmStopped(id: string) {
    this.held.delete(id);
  }
  release(id: string) {
    if (this.held.has(id)) return;
    this.reservations.delete(id);
    this.drain();
  }
  async acquireInstallation(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.tryAcquire(id, 'installation')) return;
    if (this.state !== 'ready') throw new AppError('DOCKER_UNAVAILABLE', this.message);
    if (this.capacity.cpus < requirement.cpus || this.capacity.memoryMiB < requirement.memoryMiB)
      throw new AppError('TERMINAL_RESOURCE_CAPACITY', this.message);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiters = this.waiters.filter((entry) => entry.id !== id);
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason ?? new AppError('TERMINAL_CLI_CANCELLED', '安装已取消'));
        this.drain();
      };
      this.waiters.push({ id, resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else this.drain();
    });
    if (signal?.aborted) {
      this.release(id);
      signal.throwIfAborted();
    }
  }
  private drain() {
    while (this.waiters.length && this.fits()) {
      const entry = this.waiters.shift()!;
      this.reservations.set(entry.id, 'installation');
      entry.cleanup();
      entry.resolve();
    }
  }
  snapshot(): TerminalResourceSnapshot {
    const content = {
      status: this.state,
      message: this.message,
      capacity: { ...this.capacity },
      reserved: {
        sessions: this.reservations.size,
        cpus: this.reservations.size * requirement.cpus,
        memoryMiB: this.reservations.size * requirement.memoryMiB,
      },
      reservations: [...this.reservations].map(([id, kind]) => ({ id, kind, held: this.held.has(id) })),
      waitingInstallations: this.waiters.length,
      installationHardLimit: false as const,
    };
    const serialized = JSON.stringify(content);
    if (serialized !== this.last) {
      this.last = serialized;
      this.revision++;
    }
    return { revision: this.revision, ...content };
  }
}
