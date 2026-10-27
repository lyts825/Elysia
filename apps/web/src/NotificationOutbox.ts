/* 管理待发送通知及其发送健康状态。 */
import type { TaskCenterItem } from '../../../packages/contracts/src/task-center';

export type NotificationHealth = { pending: number; failed: number; lastFailureAt?: number };
type Notice = { id: string; status: NonNullable<TaskCenterItem['notification']>['status']; revision: number };
type Entry = Notice & { attempts: number; nextAt: number; createdAt: number };

/**
 * 有界、仅内存的通知发件箱：每任务只保留最近状态，投递前重新核对版本与状态。
 * 超过两分钟的变化丢弃，失败最多尝试三次并退避；只保存数量健康状态，不持久化任务正文。
 */
export class NotificationOutbox {
  private entries = new Map<string, Entry>();
  private inheritedFailures = 0;
  private lastFailureAt?: number;
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
  enqueue(item: TaskCenterItem, after: number) {
    // 同一任务只保留比已观察版本新的最近一次通知，避免发送过期状态。
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
      // 队列有界；被淘汰的条目计入失败数，避免悄然丢失。
      this.entries.delete(this.entries.keys().next().value!);
      this.inheritedFailures = Math.min(999, this.inheritedFailures + 1);
      this.lastFailureAt = Date.now();
    }
    this.publish();
  }
  remove(id: string) {
    this.entries.delete(id);
    this.publish();
  }
  /** 逐项处理已到重试时间的变化；取消后停止发布或移除，替换为新版本的旧项也不再投递。 */
  async drain(signal: AbortSignal, now = Date.now()) {
    // 投递前复核任务状态；过期或不再有效的通知直接移除。
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
          // 失败最多尝试三次，重试间隔按 2 秒、4 秒递增。
          entry.nextAt = now + 2000 * 2 ** (entry.attempts - 1);
          this.lastFailureAt = Date.now();
        }
      }
    }
    if (!signal.aborted) this.publish();
  }
  dismissFailures() {
    this.inheritedFailures = 0;
    for (const [id, entry] of this.entries) if (entry.attempts >= 3) this.entries.delete(id);
    this.publish();
  }
  /** 生命周期结束只保留已耗尽重试的失败计数，未投递内容不跨生命周期重放。 */
  stop() {
    this.inheritedFailures = Math.min(
      999,
      this.inheritedFailures + [...this.entries.values()].filter((entry) => entry.attempts >= 3).length,
    );
    this.entries.clear();
    this.publish();
  }
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
