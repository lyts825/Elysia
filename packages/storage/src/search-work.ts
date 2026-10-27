/**
 * 共享搜索读取并协调订阅取消，避免重复工作和单个调用方取消影响其他订阅者。
 * EN: Share search reads and coordinate subscriber cancellation so one caller does not cancel work
 * still needed by others.
 *
 * 同一搜索工作由订阅者共享，取消只释放当前订阅；最后一个订阅退出后才可停止底层工作，避免一个页面干扰其他读取。
 * EN: Share identical search work among subscribers; cancellation releases one subscriber and stops underlying work only after the last one leaves.
 */
import { AppError } from '../../contracts/src/index.js';

/**
 * 将取消信号转换为统一搜索取消错误，附带499状态供调用方区分。
 * EN: Convert an aborted signal into a uniform search-cancelled error with status 499.
 */
export function searchCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new AppError('SEARCH_CANCELLED', '搜索已取消', false, null, 499);
}

/**
 * 共享在途读取，最后一名订阅者离开后才取消底层工作。
 * EN: Share in-flight reads and cancel underlying work only after the last subscriber leaves.
 */
export class SearchWork {
  private jobs = new Map<
    string,
    { controller: AbortController; promise: Promise<unknown>; subscribers: number }
  >();
  /**
   * 相同 key 的调用共享一次读取；调用方的 signal 只取消自己的等待。
   * 最后一个订阅者离开时才中止底层读取，最多同时保留 16 个不同 key。
   * EN: Calls with the same key share one read. A caller signal cancels only that caller wait; abort
   * the underlying read when its final subscriber leaves. Keep at most sixteen different keys in
   * flight.
   */
  run<T>(key: string, read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    searchCancelled(signal);
    let entry = this.jobs.get(key);
    if (!entry) {
      if (this.jobs.size >= 16) throw new AppError('SEARCH_BUSY', '搜索较繁忙，请稍后重试', true, null, 429);
      const controller = new AbortController();
      entry = {
        controller,
        subscribers: 0,
        promise: Promise.resolve().then(() => {
          searchCancelled(controller.signal);
          return read(controller.signal);
        }),
      };
      this.jobs.set(key, entry);
      const current = entry;
      /**
       * 只删除仍指向本次共享请求的缓存项，避免旧请求完成时删掉新请求。
       * EN: Remove the cached entry only if it still refers to this shared job, preserving replacements.
       */
      const clear = () => {
        // 旧请求结束时不能删除后来用同一 key 建立的新请求。
        // EN: An old request completion must not remove a newer request created under the same key.
        if (this.jobs.get(key) === current) this.jobs.delete(key);
      };
      entry.promise.then(clear, clear);
    }
    const current = entry;
    current.subscribers++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      /**
       * 为单个订阅者仅结算一次，减少计数，并在最后订阅离开后取消共享读取。
       * EN: Settle one subscriber once, decrement its count, and abort shared work when the last subscriber leaves.
       */
      const finish = (error: unknown, value?: unknown) => {
        // 完成与取消可能同时到达，只减少一次订阅计数。
        // EN: Completion and cancellation can race; decrement the subscriber count only once.
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        current.subscribers--;
        if (!current.subscribers) {
          current.controller.abort();
          if (this.jobs.get(key) === current) this.jobs.delete(key);
        }
        if (error) reject(error);
        else resolve(value as T);
      };
      /**
       * 只取消当前订阅者等待，由统一结算决定是否需要中止底层读取。
       * EN: Cancel this subscriber wait only; shared settlement decides whether underlying work should stop.
       */
      const abort = () => finish(new AppError('SEARCH_CANCELLED', '搜索已取消', false, null, 499));
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(
        (value) => finish(null, value),
        (error) => finish(error),
      );
      if (signal?.aborted) abort();
    });
  }
  /**
   * 中止所有已登记共享搜索并清空缓存，不等待调用方逐个离开。
   * EN: Abort every registered shared search and clear the cache without awaiting individual subscriber departure.
   */
  close() {
    // 关闭时中止全部共享读取，不等待外部订阅者逐个取消。
    // EN: Closing aborts all shared reads immediately instead of waiting for subscribers to cancel
    // individually.
    for (const entry of this.jobs.values()) entry.controller.abort();
    this.jobs.clear();
  }
}
