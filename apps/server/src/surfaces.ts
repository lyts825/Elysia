/**
 * 创建不同工作界面的服务和访问认证。
 * 同监听器/认证会话下保留独立目录、物理数据库和执行器，仅共享认证集合；调用方恢复后显式启动执行。
 * EN: Creates services and authentication for distinct application surfaces. Shares one listener/auth session while isolating directories, physical databases and executors; callers explicitly start execution after recovery.
 */
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
/**
 * 为指定本地端口生成一次性启动令牌及允许的来源和主机集合。
 * EN: Generates a one-time bootstrap token and allowed origins/hosts for a local port.
 */
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
/**
 * 创建终端独立数据目录，并拒绝符号链接及越过数据根目录的路径。
 * EN: Creates the terminal data directory while rejecting symlinks and paths outside the data root.
 */
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

/**
 * 路径不同仍可能是硬链接；以设备与 inode 拒绝两入口共用实际数据库。
 * EN: Distinct paths may still be hard links; compares device and inode to reject shared physical databases.
 */
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
/**
 * 在同一本地会话中注册独立服务；恢复完成后才显式启动执行。 在同一个监听器和引导会话下注册两个独立 Store/执行器，终端 API 挂载 /terminal。 两入口仅共享鉴权集合，不共享模型凭据或业务数据库；ready 失败时关闭已创建的服务。 调用方必须先完成存储恢复，再显式启动执行器。
 * EN: Registers independent services under one local session. Execution starts explicitly after recovery. Registers independent stores/executors under one listener and bootstrap session, with terminal APIs under /terminal. Only authentication sets are shared, never credentials or business databases. Readiness failure closes created services; callers recover storage before explicitly starting execution.
 */
export async function createSurfaceServer(
  nativeStore: Store,
  terminalStore: Store,
  options: { port: number; dev?: boolean; native?: SurfaceOptions; terminal?: SurfaceOptions },
) {
  /**
   * 解析真实数据目录并在 Windows 规范大小写，供两入口存储隔离比较。
   * EN: Resolves real data directories and normalizes Windows case for cross-surface storage isolation.
   */
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
