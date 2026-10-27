/** 提供支持取消的异步延迟。 */
/** 等待指定毫秒；信号中止时清除计时器并以中止原因拒绝。 */
export function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    // 已取消时不创建定时器；正常到期移除监听，取消则清除计时器并保留原 signal.reason。
    signal.throwIfAborted();
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
