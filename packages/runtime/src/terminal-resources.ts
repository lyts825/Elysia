/** 管理终端执行所需的资源池。 */
import { AppError } from '../../contracts/src/index.js';
import {
  terminalResourceRequirement,
  type TerminalResourcePreset,
  type TerminalResourceSnapshot,
} from '../../contracts/src/terminal-runtime.js';

type Kind = 'task' | 'installation' | 'probe';
type Reservation = { kind: Kind; resourcePreset?: TerminalResourcePreset };
/** Per-application admission, independent of the execution's immutable permission/budget binding. */
export class TerminalResourcePool {
  private state: TerminalResourceSnapshot['status'] = 'unknown';
  private message = '尚未读取 Docker 资源容量';
  private capacity = { sessions: 2, cpus: 4, memoryMiB: 4096 };
  private reservations = new Map<string, Reservation>();
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
      this.capacity.cpus < 1 || this.capacity.memoryMiB < 1024
        ? 'Docker 资源不足以启动轻量终端，请至少分配 1 CPU / 1024 MiB'
        : '按任务冻结的资源规格预约，最多同时运行两个终端';
    this.drain();
  }
  unavailable(message: string) {
    this.state = 'unavailable';
    this.message = message;
  }
  private amount(id: string, kind: Kind, preset?: TerminalResourcePreset) {
    if (kind !== 'probe') return terminalResourceRequirement(kind === 'task' ? preset : undefined);
    const sponsor = this.sponsors.get(id);
    return {
      sessions: 0,
      cpus: sponsor && this.reservations.has(sponsor) ? 0 : 1,
      memoryMiB: sponsor && this.reservations.has(sponsor) ? 0 : 256,
    };
  }
  private used() {
    return [...this.reservations].reduce(
      (sum, [id, reservation]) => {
        const value = this.amount(id, reservation.kind, reservation.resourcePreset);
        return {
          sessions: sum.sessions + value.sessions,
          cpus: sum.cpus + value.cpus,
          memoryMiB: sum.memoryMiB + value.memoryMiB,
        };
      },
      { sessions: 0, cpus: 0, memoryMiB: 0 },
    );
  }
  private fits(id = '', kind: Kind = 'task', preset?: TerminalResourcePreset) {
    const used = this.used(),
      amount = this.amount(id, kind, preset);
    return (
      this.state === 'ready' &&
      (kind !== 'probe' ||
        [...this.reservations.values()].filter((value) => value.kind === 'probe').length < 2) &&
      used.sessions + amount.sessions <= this.capacity.sessions &&
      used.cpus + amount.cpus <= this.capacity.cpus &&
      used.memoryMiB + amount.memoryMiB <= this.capacity.memoryMiB
    );
  }
  reason(preset?: TerminalResourcePreset): 'terminal-resources' | 'terminal-capacity' | 'terminal-engine' {
    if (this.state !== 'ready') return 'terminal-engine';
    const required = terminalResourceRequirement(preset);
    return required.cpus > this.capacity.cpus || required.memoryMiB > this.capacity.memoryMiB
      ? 'terminal-capacity'
      : 'terminal-resources';
  }
  canAcquireTask(id: string, preset?: TerminalResourcePreset) {
    return (
      this.has(id) ||
      (this.fits(id, 'task', preset) && !this.waiters.some((entry) => entry.kind === 'installation'))
    );
  }
  tryAcquire(id: string, kind: Kind = 'task', preset?: TerminalResourcePreset) {
    if (this.reservations.has(id)) return true;
    // A user-requested install gets the next available slot rather than starving behind fresh tasks.
    if (
      !this.fits(id, kind, preset) ||
      (kind === 'task' && this.waiters.some((entry) => entry.kind === 'installation'))
    )
      return false;
    this.reservations.set(id, { kind, ...(kind === 'task' && preset ? { resourcePreset: preset } : {}) });
    return true;
  }
  hold(id: string, reason?: string, kind: Kind = 'task', preset?: TerminalResourcePreset) {
    this.reservations.set(
      id,
      this.reservations.get(id) ?? { kind, ...(kind === 'task' && preset ? { resourcePreset: preset } : {}) },
    );
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
      ['task', 'installation'].includes(this.reservations.get(sponsorId)?.kind ?? '') &&
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
      this.reservations.set(entry.id, { kind: entry.kind });
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
      reservations: [...this.reservations].map(([id, reservation]) => ({
        id,
        kind: reservation.kind,
        resources: this.amount(id, reservation.kind, reservation.resourcePreset),
        ...(reservation.resourcePreset ? { resourcePreset: reservation.resourcePreset } : {}),
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
