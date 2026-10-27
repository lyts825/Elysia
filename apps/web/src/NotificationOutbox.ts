/**
 * 管理待发送通知及其发送健康状态。
 * 仅在内存保留有界的任务最新通知，投递前复核并退避重试；跨生命周期只延续失败计数，不重放任务正文。
 * EN: Manages pending notifications and delivery health. Keeps a bounded latest-notice queue in memory with pre-delivery checks and backoff; only failure counts survive lifecycle changes, not task-message bodies.
 */
import type { TaskCenterItem } from '../../../packages/contracts/src/task-center';

export type NotificationHealth = { pending: number; failed: number; lastFailureAt?: number };
type Notice = { id: string; status: NonNullable<TaskCenterItem['notification']>['status']; revision: number };
type Entry = Notice & { attempts: number; nextAt: number; createdAt: number };

/**
 * 有界、仅内存的通知发件箱：每任务只保留最近状态，投递前重新核对版本与状态。
 * 超过两分钟的变化丢弃，失败最多尝试三次并退避；只保存数量健康状态，不持久化任务正文。
 * EN: A bounded memory-only outbox retains latest state per task and revalidates before delivery. Drop changes over two minutes old; retry at most three times with backoff. Persist counts only, never task bodies.
 */
export class NotificationOutbox {
  private entries = new Map<string, Entry>();
  private inheritedFailures = 0;
  private lastFailureAt?: number;
  /**
   * 注入核验、投递和健康状态回调，并恢复有界失败计数；通知正文仍由当前生命周期重新入队。
   * EN: Injects verification, delivery, and health callbacks and restores a bounded failure count; notification bodies are enqueued afresh in the current lifecycle.
   */
  constructor(
    private io: {
      verify: (notice: Notice) => Promise<boolean>;
      deliver: (notice: Notice) => Promise<unknown>;
      changed: (health: NotificationHealth) => void;
    },
    prior?: NotificationHealth,
  ) {
    this.inheritedFailures = Math.min(999, Math.max(0, prior?.failed || 0));
    this.lastFailureAt = prior?.lastFailureAt;
  }
  /**
   * 只把高于已观察修订的新通知入队；同任务保留最高修订，并限制队列大小和发布健康状态。
   * EN: Enqueues notices newer than the observed revision, retaining the highest revision per task, bounding the queue, and publishing health state.
   */
  enqueue(item: TaskCenterItem, after: number) {
    /**
     * 同一任务只保留比已观察版本新的最近一次通知，避免发送过期状态。
     * EN: Keep the newest notification beyond the observed revision per task to avoid stale delivery.
     */
    const notice = item.notification;
    if (!notice || notice.revision <= after) return;
    const old = this.entries.get(item.id);
    if (old && old.revision >= notice.revision) return;
    this.entries.delete(item.id);
    this.entries.set(item.id, {
      id: item.id,
      status: notice.status,
      revision: notice.revision,
      attempts: 0,
      nextAt: 0,
      createdAt: Date.now(),
    });
    while (this.entries.size > 40) {
      /**
       * 队列有界；被淘汰的条目计入失败数，避免悄然丢失。
       * EN: Bound the queue and count evictions as failures instead of silently losing them.
       */
      this.entries.delete(this.entries.keys().next().value!);
      this.inheritedFailures = Math.min(999, this.inheritedFailures + 1);
      this.lastFailureAt = Date.now();
    }
    this.publish();
  }
  /**
   * 删除指定任务的待投递通知并重新发布队列健康状态。
   * EN: Removes the pending notice for one task and republishes queue health.
   */
  remove(id: string) {
    this.entries.delete(id);
    this.publish();
  }
  /**
   * 逐项处理已到重试时间的变化；取消后停止发布或移除，替换为新版本的旧项也不再投递。
   * EN: Process due entries serially; cancel publishing/removal after abort and do not deliver replaced old entries.
   */
  async drain(signal: AbortSignal, now = Date.now()) {
    /**
     * 投递前复核任务状态；过期或不再有效的通知直接移除。
     * EN: Revalidate before delivery and remove expired or invalid notices.
     */
    for (const entry of [...this.entries.values()]) {
      if (signal.aborted) return;
      if (entry.attempts >= 3 || entry.nextAt > now) continue;
      try {
        if (now - entry.createdAt > 120000 || !(await this.io.verify(entry))) {
          if (!signal.aborted && this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
          continue;
        }
        if (signal.aborted || this.entries.get(entry.id) !== entry) continue;
        await this.io.deliver(entry);
        if (!signal.aborted && this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
      } catch {
        if (!signal.aborted && this.entries.get(entry.id) === entry) {
          entry.attempts++;
          /**
           * 失败最多尝试三次，重试间隔按 2 秒、4 秒递增。
           * EN: Retry at most three times, using two- then four-second delays.
           */
          entry.nextAt = now + 2000 * 2 ** (entry.attempts - 1);
          this.lastFailureAt = Date.now();
        }
      }
    }
    if (!signal.aborted) this.publish();
  }
  /**
   * 清空继承失败计数和已耗尽重试的队列项，再发布状态；仍可重试的通知保留。
   * EN: Clears inherited failures and exhausted queue entries, then publishes health while retaining notices that can still retry.
   */
  dismissFailures() {
    this.inheritedFailures = 0;
    for (const [id, entry] of this.entries) if (entry.attempts >= 3) this.entries.delete(id);
    this.publish();
  }
  /**
   * 生命周期结束只保留已耗尽重试的失败计数，未投递内容不跨生命周期重放。
   * EN: At lifecycle end retain exhausted failure counts only; do not replay undelivered bodies across lifecycles.
   */
  stop() {
    this.inheritedFailures = Math.min(
      999,
      this.inheritedFailures + [...this.entries.values()].filter((entry) => entry.attempts >= 3).length,
    );
    this.entries.clear();
    this.publish();
  }
  /**
   * 汇总待处理与耗尽重试的数量，合并继承失败并限制计数，向订阅方发布最新健康快照。
   * EN: Counts pending and exhausted entries, incorporates inherited failures with a bounded count, and publishes the latest health snapshot.
   */
  private publish() {
    let pending = 0,
      failed = this.inheritedFailures;
    for (const entry of this.entries.values()) entry.attempts >= 3 ? failed++ : pending++;
    this.io.changed({
      pending,
      failed: Math.min(999, failed),
      ...(this.lastFailureAt ? { lastFailureAt: this.lastFailureAt } : {}),
    });
  }
}
