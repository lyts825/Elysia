/**
 * 管理终端执行所需的资源池。
 * 按 CPU/内存/会话容量预约任务、安装和探测，取消与幂等释放维护真实持有量；只是应用准入计数，容器限制由启动配置实施。
 * EN: Manages the terminal execution resource pool. Reserves CPU/memory/session capacity for tasks/installations/probes with cancellation/idempotent release; application admission complements actual container limits.
 */
import { AppError } from '../../contracts/src/index.js';
import {
  terminalResourceRequirement,
  type TerminalResourcePreset,
  type TerminalResourceSnapshot,
} from '../../contracts/src/terminal-runtime.js';

type Kind = 'task' | 'installation' | 'probe';
type Reservation = { kind: Kind; resourcePreset?: TerminalResourcePreset };
/**
 * 应用内资源准入独立于执行任务冻结的权限和预算绑定。
 * EN: Per-application admission, independent of the execution's immutable permission/budget binding.
 */
export class TerminalResourcePool {
  /**
   * 预约按本应用持有的事实计数，不将持久 UI 阶段或 Docker 总空闲量直接当成释放证据。
   * EN: Reservations reflect resources this application still owns; persistent UI phases or Docker-wide free capacity are not proof of release.
   */
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
  /**
   * 检查本池是否仍持有该ID的预约，包含尚待核验停止的held资源。
   * EN: Checks whether this pool still owns the reservation, including held resources awaiting stop verification.
   */
  has(id: string) {
    return this.reservations.has(id);
  }
  /**
   * 根据 Docker 容量更新可预约上限，并唤醒可以满足的等待者。
   * EN: Updates reservable limits from Docker capacity and wakes waiters whose requirements can now be met.
   */
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
  /**
   * 保存引擎不可用原因，后续准入据此拒绝新预约，不擅自释放已有资源。
   * EN: Records engine unavailability so future admission rejects new reservations without releasing existing ownership.
   */
  unavailable(message: string) {
    this.state = 'unavailable';
    this.message = message;
  }
  /**
   * 探测可由已有任务或安装预约赞助；赞助失效后恢复独立资源计费。
   * EN: Existing task or installation reservations may sponsor probes; invalid sponsorship restores independent resource accounting.
   */
  private amount(id: string, kind: Kind, preset?: TerminalResourcePreset) {
    if (kind !== 'probe') return terminalResourceRequirement(kind === 'task' ? preset : undefined);
    const sponsor = this.sponsors.get(id);
    return {
      sessions: 0,
      cpus: sponsor && this.reservations.has(sponsor) ? 0 : 1,
      memoryMiB: sponsor && this.reservations.has(sponsor) ? 0 : 256,
    };
  }
  /**
   * 汇总本池所有预约的会话、CPU和内存需求，探测成本按当前有效赞助关系计算。
   * EN: Totals session, CPU, and memory requirements across reservations, calculating probe cost from current sponsorship.
   */
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
  /**
   * 同时核对引擎就绪、探测并发数和三类容量上限，不修改预约状态。
   * EN: Checks engine readiness, concurrent-probe count, and all capacity limits without changing reservations.
   */
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
  /**
   * 区分引擎不可用、规格超过总容量和资源暂时被占用三种排队原因。
   * EN: Distinguishes engine unavailability, requirements exceeding total capacity, and temporarily occupied resources.
   */
  reason(preset?: TerminalResourcePreset): 'terminal-resources' | 'terminal-capacity' | 'terminal-engine' {
    if (this.state !== 'ready') return 'terminal-engine';
    const required = terminalResourceRequirement(preset);
    return required.cpus > this.capacity.cpus || required.memoryMiB > this.capacity.memoryMiB
      ? 'terminal-capacity'
      : 'terminal-resources';
  }
  /**
   * 队列展示与真实申请共用条件；等待安装具有优先权，避免用户触发的安装被新任务饿死。
   * EN: Queue display and actual admission share conditions. Waiting installations take priority so newly arriving tasks cannot starve explicit user installation.
   */
  canAcquireTask(id: string, preset?: TerminalResourcePreset) {
    return (
      this.has(id) ||
      (this.fits(id, 'task', preset) && !this.waiters.some((entry) => entry.kind === 'installation'))
    );
  }
  /**
   * 同 ID 重复预约幂等；检查 CPU、内存、会话数及安装优先级后同步登记。
   * EN: Repeated reservation of the same ID is idempotent; synchronously records it after checking CPU, memory, session count, and installation priority.
   */
  tryAcquire(id: string, kind: Kind = 'task', preset?: TerminalResourcePreset) {
    if (this.reservations.has(id)) return true;
    /**
     * 用户请求的安装取得下一个可用槽位，不被新到任务长期挤占。
     * EN: A user-requested install gets the next available slot rather than starving behind fresh tasks.
     */
    if (
      !this.fits(id, kind, preset) ||
      (kind === 'task' && this.waiters.some((entry) => entry.kind === 'installation'))
    )
      return false;
    this.reservations.set(id, { kind, ...(kind === 'task' && preset ? { resourcePreset: preset } : {}) });
    return true;
  }
  /**
   * 清理结果不确定时保留预约，防止仍在运行的容器被重复计入空闲容量。
   * EN: Retains reservations when cleanup is uncertain, preventing a possibly running container from being counted as free capacity.
   */
  hold(id: string, reason?: string, kind: Kind = 'task', preset?: TerminalResourcePreset) {
    this.reservations.set(
      id,
      this.reservations.get(id) ?? { kind, ...(kind === 'task' && preset ? { resourcePreset: preset } : {}) },
    );
    this.held.add(id);
    if (reason) this.heldReasons.set(id, reason);
  }
  /**
   * 只解除“停止未确认”保护；真正释放由 release 完成，调用方必须先取得停止证据。
   * EN: Clears only the unconfirmed-stop hold; release performs actual deletion after the caller obtains stop evidence.
   */
  confirmStopped(id: string) {
    this.held.delete(id);
    this.heldReasons.delete(id);
  }
  /**
   * held 预约不会被普通 finally 释放；确认停止后才可删除预约并唤醒等待者。
   * EN: Ordinary finally cleanup cannot release held reservations; confirmed stopping permits deletion and wakes waiters.
   */
  release(id: string) {
    if (this.held.has(id)) return;
    this.reservations.delete(id);
    this.sponsors.delete(id);
    this.drain();
  }
  /**
   * 有效任务/安装可承担自身检查的资源成本；已被 hold 的赞助方不能支持新探测。
   * EN: Valid tasks and installations may bear their own probe costs; held sponsors cannot support new probes.
   */
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
  /**
   * 先登记可用赞助关系，再等待探测资源；赞助只影响资源成本，不授予执行权限。
   * EN: Registers valid sponsorship before waiting for probe resources; sponsorship affects cost, not execution authorization.
   */
  acquireProbe(id: string, signal?: AbortSignal, sponsorId?: string) {
    this.sponsorProbe(id, sponsorId);
    return this.acquire(id, 'probe', signal);
  }
  /**
   * 以安装类别进入有取消能力的资源等待路径，由统一队列优先级与容量判断。
   * EN: Enters the abortable installation-resource wait path under shared priority and capacity rules.
   */
  acquireInstallation(id: string, signal?: AbortSignal) {
    return this.acquire(id, 'installation', signal);
  }
  /**
   * 等待安装或探测资源；取消时从队列移除，预约后取消则释放资源。
   * EN: Waits for installation or probe resources. Abort removes queued work, or releases resources if reservation already succeeded.
   */
  private async acquire(id: string, kind: 'installation' | 'probe', signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.tryAcquire(id, kind)) return;
    if (this.state !== 'ready') throw new AppError('DOCKER_UNAVAILABLE', this.message);
    const amount = this.amount(id, kind);
    if (this.capacity.cpus < amount.cpus || this.capacity.memoryMiB < amount.memoryMiB)
      throw new AppError('TERMINAL_RESOURCE_CAPACITY', this.message);
    await new Promise<void>((resolve, reject) => {
      /**
       * 从等待队列和赞助表移除当前申请，拒绝等待并重新尝试唤醒其他可满足的请求。
       * EN: Removes the request from waiters and sponsorship, rejects its wait, and retries other satisfiable requests.
       */
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
        /**
         * 预约成功或离开队列后移除旧取消监听，避免后来的信号误影响已结束等待。
         * EN: Removes the old abort listener after reservation or queue departure so later cancellation cannot affect a finished wait.
         */
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
  /**
   * 从等待队列中取当前可满足的首项，避免首项大规格阻塞后续可以执行的小检查。
   * EN: Selects the first currently satisfiable waiter, preventing a large request at the head from blocking smaller probes.
   */
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
  /**
   * 生成只读快照；仅当内容发生变化时递增 revision。
   * EN: Produces a read-only snapshot and advances revision only when its content changes.
   */
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
