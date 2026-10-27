// 协调桌面进程与启动构建过程的握手。
// This handshake is entered only after Electron has acquired its native single-instance lock.
/** 请求启动器准备构建；禁用握手时返回空结果，超时、断连或无效构建均失败。 */
function waitForLaunchBuild(channel, enabled) {
  if (!enabled) return Promise.resolve(undefined);
  if (!channel.send || !channel.connected)
    return Promise.reject(new Error('启动构建通道不可用，请使用 pnpm start'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      // 构建结果、断连和超时可能竞争；只处理第一次完成并移除监听器。
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.off('message', message);
      channel.off('disconnect', disconnected);
      error ? reject(error) : resolve(value);
    };
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
