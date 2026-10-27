// 跟踪搜索读取工作量并响应取消请求。
import { AppError } from '../../contracts/src/index.js';

export function searchCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new AppError('SEARCH_CANCELLED', '搜索已取消', false, null, 499);
}

/** Share in-flight reads, while cancelling work only after its last subscriber leaves. */
export class SearchWork {
  private jobs = new Map<
    string,
    { controller: AbortController; promise: Promise<unknown>; subscribers: number }
  >();
  /**
   * 相同 key 的调用共享一次读取；调用方的 signal 只取消自己的等待。
   * 最后一个订阅者离开时才中止底层读取，最多同时保留 16 个不同 key。
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
      const clear = () => {
        // 旧请求结束时不能删除后来用同一 key 建立的新请求。
        if (this.jobs.get(key) === current) this.jobs.delete(key);
      };
      entry.promise.then(clear, clear);
    }
    const current = entry;
    current.subscribers++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (error: unknown, value?: unknown) => {
        // 完成与取消可能同时到达，只减少一次订阅计数。
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
      const abort = () => finish(new AppError('SEARCH_CANCELLED', '搜索已取消', false, null, 499));
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(
        (value) => finish(null, value),
        (error) => finish(error),
      );
      if (signal?.aborted) abort();
    });
  }
  close() {
    // 关闭时中止全部共享读取，不等待外部订阅者逐个取消。
    for (const entry of this.jobs.values()) entry.controller.abort();
    this.jobs.clear();
  }
}
