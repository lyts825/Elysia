/* 协调重复读取、取消过期请求并限制读取时间。 */
/**
 * 一次只管理一个选择的读取：同 key 共享 Promise，换 key 取消旧信号。
 * trailing 只保留最后一次刷新函数，在当前读取成功后执行；读取抛错时不继续尾随循环。
 * 取消本身不保证回调停止，读取函数仍需在发布结果前检查 signal。
 */
export class ReadCoordinator {
  private pending?: {
    key: string;
    controller: AbortController;
    promise: Promise<unknown>;
    again?: (signal: AbortSignal) => Promise<unknown>;
  };
  /** 同 key 共享在途读取；trailing 在当前读取成功后执行最后一次尾随刷新。 */
  run<T>(key: string, read: (signal: AbortSignal) => Promise<T>, trailing = false): Promise<T> {
    if (this.pending?.key === key) {
      // 同一对象的读取共享当前请求；需要尾随刷新时只保留最后一次操作。
      if (trailing) this.pending.again = read;
      return this.pending.promise as Promise<T>;
    }
    this.stop();
    const controller = new AbortController();
    const entry = {
      key,
      controller,
      promise: undefined as unknown as Promise<T>,
      again: undefined as ((signal: AbortSignal) => Promise<unknown>) | undefined,
    };
    // Deferring lets the entry be published before a synchronous reader can finish.
    entry.promise = Promise.resolve()
      .then(async () => {
        let operation: typeof read | undefined = read;
        let result: T = undefined as T;
        while (operation && !controller.signal.aborted) {
          entry.again = undefined;
          result = await operation(controller.signal);
          operation = entry.again as typeof read | undefined;
        }
        return result;
      })
      .finally(() => {
        if (this.pending === entry) this.pending = undefined;
      });
    this.pending = entry;
    return entry.promise;
  }
  stop() {
    // 新选择或组件卸载时取消旧读取，旧结果不再占用当前协调器。
    this.pending?.controller.abort();
    this.pending = undefined;
  }
}

/** 将调用方取消与内部读取期限合并；clear 由调用方在读取成功或失败后释放计时器。 */
export class ReadDeadline {
  // 同时响应调用方取消和内部计时；expired 仅标识内部超时。
  readonly signal: AbortSignal;
  expired = false;
  private timer: ReturnType<typeof setTimeout>;
  constructor(signal?: AbortSignal, milliseconds = 15000) {
    const controller = new AbortController();
    this.signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.timer = setTimeout(() => {
      this.expired = true;
      controller.abort(new DOMException('读取超时', 'TimeoutError'));
    }, milliseconds);
  }
  clear() {
    clearTimeout(this.timer);
  }
}
