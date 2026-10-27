/**
 * 提供支持取消的异步延迟。 只管理一次计时器和取消监听的生命周期，供轮询/退避使用；不定义重试策略，不吞掉取消原因。 等待指定毫秒；信号中止时清除计时器并以中止原因拒绝。
 * EN: Provides an abortable asynchronous delay. Owns one timer/cancellation listener for polling/backoff without defining retry policy or swallowing cancellation reasons. Waits for the requested milliseconds; abort clears the timer and rejects with the signal reason.
 */
export function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    /**
     * 已取消时不创建定时器；正常到期移除监听，取消则清除计时器并保留原 signal.reason。
     * EN: Do not create a timer after cancellation. Normal expiry removes the listener; abort clears the timer and preserves signal.reason.
     */
    signal.throwIfAborted();
    /**
     * 取消时清除延迟计时器并以原中止原因拒绝，不把取消伪装成正常到期。
     * EN: Clears the delay timer and rejects with the original abort reason rather than treating cancellation as normal expiry.
     */
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
