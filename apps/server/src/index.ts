import { Store, acquireLock, dataDirectory } from '../../../packages/storage/src/index.js';
import { createServer } from './server.js';
const directory = dataDirectory();
const release = acquireLock(directory);
let store: Store | undefined;
try {
  store = new Store(directory);
  const port = Number(process.env.ELYSIA_PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('ELYSIA_PORT 必须为 1024–65535');
  const server = createServer(store, { port, dev: process.env.ELYSIA_DEV === '1' });
  server.kernel.recover();
  await server.executor.gateway.recoverOperations();
  await server.app.listen({ host: '127.0.0.1', port });
  server.executor.start();
  const origin = process.env.ELYSIA_DEV === '1' ? 'http://127.0.0.1:5173' : `http://127.0.0.1:${port}`;
  console.log(
    `Elysia v0.1.0 · 本机服务\n数据目录：${directory}\n工作台引导链接（15 分钟内一次有效）：\n${origin}/#bootstrap=${server.bootstrapToken}\n停止：Ctrl+C 或 pnpm stop`,
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.app.close();
    store!.close();
    release();
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
  const interval = setInterval(async () => {
    const { existsSync, rmSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const stop = join(directory, 'stop.request');
    if (existsSync(stop)) {
      const request = JSON.parse(readFileSync(stop, 'utf8'));
      const lock = JSON.parse(readFileSync(join(directory, 'service.lock'), 'utf8'));
      rmSync(stop);
      if (request.token === lock.token) {
        clearInterval(interval);
        await close();
      }
    }
    if (closing) clearInterval(interval);
  }, 500);
} catch (error) {
  store?.close();
  release();
  console.error('启动失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
