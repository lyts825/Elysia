/**
 * 协调重复读取、取消过期请求并限制读取时间。
 * 把同键并发读取合并、在选择变化时取消旧请求，并组合调用方取消和超时信号；写入重试不属于此读取工具。
 * EN: Coordinates shared reads, stale-request cancellation, and deadlines. Coalesces same-key reads, aborts obsolete selections, and combines caller cancellation with deadlines; write retries are outside this read utility.
 */
/**
 * 一次只管理一个选择的读取：同 key 共享 Promise，换 key 取消旧信号。
 * trailing 只保留最后一次刷新函数，在当前读取成功后执行；读取抛错时不继续尾随循环。
 * 取消本身不保证回调停止，读取函数仍需在发布结果前检查 signal。
 * EN: Manage one selected read. Same key shares Promise; new key aborts old signal. trailing retains only latest refresh and runs after success, not after error. Cancellation cannot guarantee callbacks stop; readers must check signal before publishing.
 */
export class ReadCoordinator {
  private pending?: {
    key: string;
    controller: AbortController;
    promise: Promise<unknown>;
    again?: (signal: AbortSignal) => Promise<unknown>;
  };
  /**
   * 同 key 共享在途读取；trailing 在当前读取成功后执行最后一次尾随刷新。
   * EN: Share in-flight reads for one key; trailing executes the last refresh after current success.
   */
  run<T>(key: string, read: (signal: AbortSignal) => Promise<T>, trailing = false): Promise<T> {
    if (this.pending?.key === key) {
      /**
       * 同一对象的读取共享当前请求；需要尾随刷新时只保留最后一次操作。
       * EN: Share current request for the same object and retain only the last trailing operation.
       */
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
    /**
     * 延迟执行让同步读取结束前先发布 entry。
     * EN: Deferring lets the entry be published before a synchronous reader can finish.
     */
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
  /**
   * 取消当前协调读取并解除待处理引用，供选择变化或卸载时阻止旧结果继续占用协调器。
   * EN: Aborts the coordinated read and clears its pending reference so selection changes or teardown release obsolete work.
   */
  stop() {
    /**
     * 新选择或组件卸载时取消旧读取，旧结果不再占用当前协调器。
     * EN: Cancel old read on selection/unmount so it no longer occupies this coordinator.
     */
    this.pending?.controller.abort();
    this.pending = undefined;
  }
}

/**
 * 将调用方取消与内部读取期限合并；clear 由调用方在读取成功或失败后释放计时器。
 * EN: Combine caller cancellation with an internal deadline; caller clears timer after success or failure.
 */
export class ReadDeadline {
  /**
   * 同时响应调用方取消和内部计时；expired 仅标识内部超时。
   * EN: Observe caller abort and timer; expired records internal timeout only.
   */
  readonly signal: AbortSignal;
  expired = false;
  private timer: ReturnType<typeof setTimeout>;
  /**
   * 为读取创建独立超时控制器，并与调用方信号组合；超时记录expired并以TimeoutError中断。
   * EN: Creates a dedicated timeout controller and combines it with the caller signal; expiry records expired and aborts with TimeoutError.
   */
  constructor(signal?: AbortSignal, milliseconds = 15000) {
    const controller = new AbortController();
    this.signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.timer = setTimeout(() => {
      this.expired = true;
      controller.abort(new DOMException('读取超时', 'TimeoutError'));
    }, milliseconds);
  }
  /**
   * 移除超时计时器，供读取提前完成或失败时释放资源；不会主动中断已经完成的请求。
   * EN: Clears the timeout timer when reading finishes or fails, without actively aborting an already completed request.
   */
  clear() {
    clearTimeout(this.timer);
  }
}
