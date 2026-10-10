import { AppError } from '../../contracts/src/index.js';
import type { TerminalResourceSnapshot } from '../../contracts/src/terminal-runtime.js';

const requirement = { sessions: 1, cpus: 2, memoryMiB: 2048 };
type Kind = 'task' | 'installation' | 'probe';
/** Per-application admission, independent of the execution's immutable permission/budget binding. */
export class TerminalResourcePool {
  private state: TerminalResourceSnapshot['status'] = 'unknown';
  private message = '尚未读取 Docker 资源容量';
  private capacity = { sessions: 2, cpus: 4, memoryMiB: 4096 };
  private reservations = new Map<string, Kind>();
  private held = new Set<string>();
  private heldReasons = new Map<string, string>();
  private sponsors = new Map<string, string>();
  private waiters: {
    id: string;
    kind: 'installation' | 'probe';
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
  private amount(id: string, kind: Kind) {
    if (kind !== 'probe') return requirement;
    const sponsor = this.sponsors.get(id);
    return {
      sessions: 0,
      cpus: sponsor && this.reservations.has(sponsor) ? 0 : 1,
      memoryMiB: sponsor && this.reservations.has(sponsor) ? 0 : 256,
    };
  }
  private used() {
    return [...this.reservations].reduce(
      (sum, [id, kind]) => {
        const value = this.amount(id, kind);
        return {
          sessions: sum.sessions + value.sessions,
          cpus: sum.cpus + value.cpus,
          memoryMiB: sum.memoryMiB + value.memoryMiB,
        };
      },
      { sessions: 0, cpus: 0, memoryMiB: 0 },
    );
  }
  private fits(id = '', kind: Kind = 'task') {
    const used = this.used(),
      amount = this.amount(id, kind);
    return (
      this.state === 'ready' &&
      (kind !== 'probe' || [...this.reservations.values()].filter((value) => value === 'probe').length < 2) &&
      used.sessions + amount.sessions <= this.capacity.sessions &&
      used.cpus + amount.cpus <= this.capacity.cpus &&
      used.memoryMiB + amount.memoryMiB <= this.capacity.memoryMiB
    );
  }
  reason(): 'terminal-resources' | 'terminal-engine' {
    return this.state === 'ready' ? 'terminal-resources' : 'terminal-engine';
  }
  canAcquireTask(id: string) {
    return this.has(id) || (this.fits(id) && !this.waiters.some((entry) => entry.kind === 'installation'));
  }
  tryAcquire(id: string, kind: Kind = 'task') {
    if (this.reservations.has(id)) return true;
    // A user-requested install gets the next available slot rather than starving behind fresh tasks.
    if (
      !this.fits(id, kind) ||
      (kind === 'task' && this.waiters.some((entry) => entry.kind === 'installation'))
    )
      return false;
    this.reservations.set(id, kind);
    return true;
  }
  hold(id: string, reason?: string, kind: Kind = 'task') {
    this.reservations.set(id, this.reservations.get(id) ?? kind);
    this.held.add(id);
    if (reason) this.heldReasons.set(id, reason);
  }
  confirmStopped(id: string) {
    this.held.delete(id);
    this.heldReasons.delete(id);
  }
  release(id: string) {
    if (this.held.has(id)) return;
    this.reservations.delete(id);
    this.sponsors.delete(id);
    this.drain();
  }
  sponsorProbe(id: string, sponsorId?: string) {
    if (
      sponsorId &&
      ['task', 'installation'].includes(this.reservations.get(sponsorId) ?? '') &&
      !this.held.has(sponsorId)
    ) {
      this.sponsors.set(id, sponsorId);
      this.drain();
    }
  }
  acquireProbe(id: string, signal?: AbortSignal, sponsorId?: string) {
    this.sponsorProbe(id, sponsorId);
    return this.acquire(id, 'probe', signal);
  }
  acquireInstallation(id: string, signal?: AbortSignal) {
    return this.acquire(id, 'installation', signal);
  }
  private async acquire(id: string, kind: 'installation' | 'probe', signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.tryAcquire(id, kind)) return;
    if (this.state !== 'ready') throw new AppError('DOCKER_UNAVAILABLE', this.message);
    const amount = this.amount(id, kind);
    if (this.capacity.cpus < amount.cpus || this.capacity.memoryMiB < amount.memoryMiB)
      throw new AppError('TERMINAL_RESOURCE_CAPACITY', this.message);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiters = this.waiters.filter((entry) => entry.id !== id);
        this.sponsors.delete(id);
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason ?? new AppError('TERMINAL_CLI_CANCELLED', '安装已取消'));
        this.drain();
      };
      this.waiters.push({
        id,
        kind,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort),
      });
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
    while (this.waiters.length) {
      const index = this.waiters.findIndex((entry) => this.fits(entry.id, entry.kind));
      if (index < 0) break;
      const [entry] = this.waiters.splice(index, 1);
      this.reservations.set(entry.id, entry.kind);
      entry.cleanup();
      entry.resolve();
    }
  }
  snapshot(): TerminalResourceSnapshot {
    const content = {
      status: this.state,
      message: this.message,
      capacity: { ...this.capacity },
      reserved: this.used(),
      reservations: [...this.reservations].map(([id, kind]) => ({
        id,
        kind,
        held: this.held.has(id),
        ...(this.heldReasons.has(id) ? { reason: this.heldReasons.get(id) } : {}),
      })),
      waitingInstallations: this.waiters.filter((entry) => entry.kind === 'installation').length,
      waitingProbes: this.waiters.filter((entry) => entry.kind === 'probe').length,
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
