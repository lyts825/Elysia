/** 创建不同工作界面的服务和访问认证。 */
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { invariant } from '../../../packages/contracts/src/index.js';
import type { Store } from '../../../packages/storage/src/index.js';
import { createServer } from './server.js';

export type WorkbenchSurface = 'native' | 'terminal';
export interface SurfaceAuth {
  bootstrapToken: string;
  bootstrapUsed: boolean;
  bootstrapExpires: number;
  sessions: Map<string, string>;
  origins: Set<string>;
  hosts: Set<string>;
}
export function createSurfaceAuth(port: number, dev = false): SurfaceAuth {
  return {
    bootstrapToken: randomBytes(32).toString('hex'),
    bootstrapUsed: false,
    bootstrapExpires: Date.now() + 15 * 60000,
    sessions: new Map(),
    origins: new Set([`http://127.0.0.1:${port}`, ...(dev ? ['http://127.0.0.1:5173'] : [])]),
    hosts: new Set([`127.0.0.1:${port}`, ...(dev ? ['127.0.0.1:5173'] : [])]),
  };
}
export function terminalDataDirectory(directory: string) {
  const root = realpathSync(directory);
  const target = path.join(root, 'surfaces', 'terminal');
  for (const candidate of [path.join(root, 'surfaces'), target, path.join(target, 'state.db')])
    if (existsSync(candidate))
      invariant(
        !lstatSync(candidate).isSymbolicLink(),
        'SURFACE_DIRECTORY',
        'Agent 终端数据目录和数据库不能使用链接',
      );
  mkdirSync(target, { recursive: true });
  const resolved = realpathSync(target);
  const relative = path.relative(root, resolved);
  invariant(
    relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep),
    'SURFACE_DIRECTORY',
    'Agent 终端数据目录必须位于本项目的数据目录内',
  );
  assertDifferentDatabase(path.join(root, 'state.db'), path.join(resolved, 'state.db'));
  return resolved;
}

function assertDifferentDatabase(nativeFile: string, terminalFile: string) {
  if (!existsSync(nativeFile) || !existsSync(terminalFile)) return;
  const native = statSync(nativeFile, { bigint: true }),
    terminal = statSync(terminalFile, { bigint: true });
  invariant(
    !(native.dev === terminal.dev && native.ino === terminal.ino),
    'SURFACE_DIRECTORY',
    '两个入口不能共用同一个数据库文件',
  );
}

type ServerOptions = Parameters<typeof createServer>[1];
type SurfaceOptions = Omit<ServerOptions, 'port' | 'app' | 'prefix' | 'surface' | 'auth'>;
/** Registers independent services under one local session. Execution starts explicitly after recovery. */
export async function createSurfaceServer(
  nativeStore: Store,
  terminalStore: Store,
  options: { port: number; dev?: boolean; native?: SurfaceOptions; terminal?: SurfaceOptions },
) {
  const normalize = (directory: string) =>
    process.platform === 'win32' ? realpathSync(directory).toLowerCase() : realpathSync(directory);
  invariant(
    normalize(nativeStore.directory) !== normalize(terminalStore.directory),
    'SURFACE_DIRECTORY',
    '两个入口需要独立的数据目录',
  );
  assertDifferentDatabase(
    path.join(nativeStore.directory, 'state.db'),
    path.join(terminalStore.directory, 'state.db'),
  );
  const native = createServer(nativeStore, {
    port: options.port,
    dev: options.dev,
    ...options.native,
    surface: 'native',
  });
  let terminal: ReturnType<typeof createServer> | undefined;
  native.app.register(
    async (app) => {
      terminal = createServer(terminalStore, {
        port: options.port,
        dev: options.dev,
        ...options.terminal,
        app,
        prefix: '/terminal',
        surface: 'terminal',
        auth: native.auth,
        serveWeb: false,
      });
    },
    { prefix: '/terminal' },
  );
  try {
    await native.app.ready();
  } catch (error) {
    await native.app.close().catch(() => {});
    throw error;
  }
  invariant(terminal, 'SURFACE_UNAVAILABLE', 'Agent 终端入口未完成初始化');
  return { app: native.app, native, terminal, bootstrapToken: native.bootstrapToken, auth: native.auth };
}
