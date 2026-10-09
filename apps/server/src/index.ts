import { existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Store, acquireLock, dataDirectory } from '../../../packages/storage/src/index.js';
import { VERSION } from '../../../packages/contracts/src/index.js';
import { createServer } from './server.js';
import { listenLocal } from './listen.js';
import { createSurfaceServer, terminalDataDirectory } from './surfaces.js';

const directory = dataDirectory();
let release: (() => void) | undefined;
let releaseTerminal: (() => void) | undefined;
let store: Store | undefined;
let terminalStore: Store | undefined;
let server: ReturnType<typeof createServer> | undefined;
let terminalServer: ReturnType<typeof createServer> | undefined;
let frontend: { close(): Promise<void> } | undefined;
let interval: NodeJS.Timeout | undefined;
let closing: Promise<void> | undefined;
function close() {
  return (closing ??= (async () => {
    if (interval) clearInterval(interval);
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => frontend?.close()),
      Promise.resolve().then(() => server?.app.close()),
    ]);
    const released = await Promise.allSettled([
      Promise.resolve().then(() => store?.close()),
      Promise.resolve().then(() => terminalStore?.close()),
      Promise.resolve().then(() => releaseTerminal?.()),
      Promise.resolve().then(() => release?.()),
    ]);
    if (process.connected) process.disconnect();
    const failure = [...stopped, ...released].find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  })());
}
try {
  release = acquireLock(directory);
  store = new Store(directory);
  const terminalDirectory = terminalDataDirectory(store.directory);
  releaseTerminal = acquireLock(terminalDirectory);
  terminalStore = new Store(terminalDirectory);
  const preferredPort = Number(process.env.ELYSIA_PORT ?? 4317);
  const dev = process.env.ELYSIA_DEV === '1';
  const surfaces = await createSurfaceServer(store, terminalStore, { port: preferredPort });
  server = surfaces.native;
  terminalServer = surfaces.terminal;
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
  terminalServer.executor.start();
  const bootstrapUrl = `${origin}/#bootstrap=${server.bootstrapToken}`;
  if (process.send)
    process.send({ type: 'ready', origin, port, preferredPort, bootstrapUrl, version: VERSION });
  else
    console.log(
      `Elysia v${VERSION} · 本机服务\n数据目录：${directory}\n${preferredPort && port !== preferredPort ? `首选端口 ${preferredPort} 被占用，已切换到 ${port}\n` : ''}工作台引导链接（15 分钟内一次有效）：\n${bootstrapUrl}\n停止：Ctrl+C 或 pnpm stop`,
    );
  const requestClose = () =>
    void close().catch((error: Error) => {
      console.error('停止服务失败：' + error.message);
      process.exitCode = 1;
    });
  process.on('SIGINT', requestClose);
  process.on('SIGTERM', requestClose);
  process.on('message', (message: any) => {
    if (message?.type === 'shutdown') requestClose();
  });
  process.on('disconnect', requestClose);
  interval = setInterval(() => {
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
