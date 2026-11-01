/**
 * 启动服务进程并连接运行所需的组件。
 * 协调环境、存储恢复、双界面注册和实际监听，恢复后才显式启动执行器；进程信号触发幂等收尾。
 * EN: Starts the service process and connects runtime components. Coordinates environment, recovery, dual-surface registration and listening; execution starts explicitly after recovery and signals trigger idempotent shutdown.
 */
import { existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Store, dataDirectory } from '../../../packages/storage/src/index.js';
import { VERSION } from '../../../packages/contracts/src/index.js';
import { createServer } from './server.js';
import { listenLocal } from './listen.js';
import { createSurfaceServer } from './surfaces.js';
import { openStartupStores } from './startup-storage.js';

const directory = dataDirectory();
let release: (() => void) | undefined;
let store: Store | undefined;
let terminalStore: Store | undefined;
let server: ReturnType<typeof createServer> | undefined;
let terminalServer: ReturnType<typeof createServer> | undefined;
let frontend: { close(): Promise<void> } | undefined;
let interval: NodeJS.Timeout | undefined;
let closing: Promise<void> | undefined;
/**
 * 合并重复关闭请求，等待服务和存储逐步释放，再报告首个关闭失败。
 * EN: Coalesces shutdown requests, releases server and storage in order, then reports the first shutdown failure.
 */
function close() {
  return (closing ??= (async () => {
    // 先报告主动停止，关闭失败产生非零退出时也不能被桌面当作崩溃重新启动。
    // EN: Announce intentional shutdown before cleanup, even if cleanup later exits unsuccessfully.
    if (process.send && process.connected) {
      try {
        process.send({ type: 'backend-stopping' }, undefined, undefined, () => {});
      } catch {}
    }
    if (interval) clearInterval(interval);
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => frontend?.close()),
      Promise.resolve().then(() => server?.app.close()),
    ]);
    const released = await Promise.allSettled([
      Promise.resolve().then(() => store?.close()),
      Promise.resolve().then(() => terminalStore?.close()),
      Promise.resolve().then(() => release?.()),
    ]);
    if (process.connected) process.disconnect();
    const failure = [...stopped, ...released].find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  })());
}
try {
  /**
   * 先打开并升级两个入口的存储，恢复未完成操作后再对外监听。
   * EN: Opens and migrates both surface stores and recovers unfinished operations before listening publicly.
   */
  const opened = await openStartupStores(directory);
  release = opened.release;
  store = opened.native;
  terminalStore = opened.terminal;
  if (opened.backup) console.log('升级前备份：' + opened.backup);
  const preferredPort = Number(process.env.ELYSIA_PORT ?? 4317);
  const dev = process.env.ELYSIA_DEV === '1';
  const surfaces = await createSurfaceServer(store, terminalStore, { port: preferredPort });
  server = surfaces.native;
  terminalServer = surfaces.terminal;
  /**
   * 恢复先核验领域记录，再处理网关和容器副作用；这期间执行器尚未启动，不能抢跑新任务。
   * EN: Recovery validates domain records before gateway/container side effects. Executors have not started yet and cannot race new tasks ahead.
   */
  server.kernel.recover();
  await server.executor.gateway.recoverOperations();
  await server.terminal.recover();
  terminalServer.kernel.recover();
  await terminalServer.executor.gateway.recoverOperations();
  await terminalServer.terminal.recover();
  const port = await listenLocal(server.app, preferredPort);
  let origin = `http://127.0.0.1:${port}`;
  if (dev) {
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({
      configFile: path.resolve('apps/web/vite.config.ts'),
      server: {
        host: '127.0.0.1',
        port: Number(process.env.ELYSIA_WEB_PORT ?? 5173),
        strictPort: false,
        proxy: { '/api': origin, '/preview': origin, '/terminal': origin },
      },
    });
    frontend = vite;
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('无法读取开发端口');
    origin = `http://127.0.0.1:${address.port}`;
    server.allowFrontendOrigin(origin);
  }
  server.executor.start();
  /**
   * 两入口共享 HTTP 监听，但各自启动自己的执行器与数据恢复结果。
   * EN: Both surfaces share HTTP listening but start their own executors after their own recovery results.
   */
  terminalServer.executor.start();
  server.scheduler?.start();
  const bootstrapUrl = `${origin}/#bootstrap=${server.bootstrapToken}`;
  if (process.send)
    process.send({ type: 'ready', origin, port, preferredPort, bootstrapUrl, version: VERSION });
  else
    console.log(
      `Elysia v${VERSION} · 本机服务\n数据目录：${directory}\n${preferredPort && port !== preferredPort ? `首选端口 ${preferredPort} 被占用，已切换到 ${port}\n` : ''}工作台引导链接（15 分钟内一次有效）：\n${bootstrapUrl}\n停止：Ctrl+C 或 pnpm stop`,
    );
  /**
   * 把进程关闭信号转为异步服务关闭；失败记录错误并设置退出码，不产生未处理的承诺拒绝。
   * EN: Converts process shutdown signals into async close; failures are logged and set exitCode without unhandled promise rejection.
   */
  const requestClose = () =>
    void close().catch((error: Error) => {
      console.error('停止服务失败：' + error.message);
      process.exitCode = 1;
    });
  process.on('SIGINT', requestClose);
  process.on('SIGTERM', requestClose);
  process.on('message', (message: any) => {
    if (message?.type === 'shutdown') requestClose();
    // 心跳只证明服务事件循环能回应，不证明模型或任务有进展，也不触发任务恢复。
    // EN: A heartbeat proves event-loop responsiveness only; it neither asserts task progress nor resumes work.
    if (
      !closing &&
      message?.type === 'health-ping' &&
      typeof message.id === 'string' &&
      message.id.length <= 64 &&
      /^\d+:\d+$/.test(message.id) &&
      process.send &&
      process.connected
    ) {
      try {
        process.send({ type: 'health-pong', id: message.id }, undefined, undefined, () => {});
      } catch {}
    }
  });
  process.on('disconnect', requestClose);
  interval = setInterval(() => {
    /**
     * 停止文件需匹配当前服务锁随机 token，过期锁或其他实例留下的文件不能停止本次服务。
     * EN: Stop files must match this service lock's random token; stale locks or another instance's files cannot stop this service.
     */
    const stop = path.join(directory, 'stop.request');
    if (!existsSync(stop)) return;
    try {
      const request = JSON.parse(readFileSync(stop, 'utf8'));
      const lock = JSON.parse(readFileSync(path.join(directory, 'service.lock'), 'utf8'));
      rmSync(stop);
      if (request.token === lock.token) requestClose();
    } catch (error) {
      console.error('停止请求无效：', (error as Error).message);
    }
  }, 500);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.send) process.send({ type: 'startup-error', message });
  console.error('启动失败：' + message);
  await close();
  process.exitCode = 1;
}
