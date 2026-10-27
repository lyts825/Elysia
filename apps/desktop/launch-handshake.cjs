/**
 * 协调取得 Electron 单实例锁后的构建握手。请求启动器准备构建；禁用握手时返回空结果，超时、断连或无效构建均失败。
 * EN: Coordinate the build handshake after Electron acquires its single-instance lock. Ask the
 * launcher to prepare a build; return no build when disabled, and reject on timeout, disconnection,
 * or invalid build data.
 */
function waitForLaunchBuild(channel, enabled) {
  if (!enabled) return Promise.resolve(undefined);
  if (!channel.send || !channel.connected)
    return Promise.reject(new Error('启动构建通道不可用，请使用 pnpm start'));
  return new Promise((resolve, reject) => {
    let settled = false;
    /**
     * 只结算第一次握手结果，清理定时器和监听器后返回构建或错误。
     * EN: Settle the first handshake outcome, remove timer/listeners, and return the build or error.
     */
    const finish = (error, value) => {
      // 构建结果、断连和超时可能竞争；只处理第一次完成并移除监听器。
      // EN: Build completion, disconnection, and timeout can race. Settle only once and remove the
      // listeners.
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.off('message', message);
      channel.off('disconnect', disconnected);
      error ? reject(error) : resolve(value);
    };
    /**
     * 分派构建就绪与失败消息，验证必需路径后交给统一结算。
     * EN: Dispatch build-ready/error messages, validating required paths before shared settlement.
     */
    const message = (value) => {
      if (value?.type === 'desktop-build-error') finish(new Error(value.message || '构建失败'));
      if (value?.type === 'desktop-build-ready') {
        if (
          !value.build ||
          typeof value.build.server !== 'string' ||
          typeof value.build.web !== 'string' ||
          typeof value.build.resources !== 'string'
        )
          return finish(new Error('启动构建结果无效'));
        finish(undefined, value);
      }
    };
    /**
     * IPC断开视为启动失败，避免无限等候已经退出的启动器。
     * EN: Treat IPC disconnection as launch failure instead of waiting indefinitely for a departed launcher.
     */
    const disconnected = () => finish(new Error('启动构建进程已断开'));
    const timeout = setTimeout(() => finish(new Error('启动构建超时')), 300000);
    channel.on('message', message);
    channel.once('disconnect', disconnected);
    channel.send({ type: 'desktop-build-request' }, (error) => {
      if (error) finish(error);
    });
  });
}
module.exports = { waitForLaunchBuild };
