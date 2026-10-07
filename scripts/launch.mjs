import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
process.chdir(root);
const runtime = path.join(root, '.elysia-runtime');
mkdirSync(runtime, { recursive: true });
function pnpm(command) {
  const corepack = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'corepack.js',
  );
  const result = existsSync(corepack)
    ? spawnSync(process.execPath, [corepack, 'pnpm', ...command.split(' ')], {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
      })
    : process.platform === 'win32'
      ? spawnSync(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `pnpm ${command}`], {
          cwd: root,
          stdio: 'inherit',
          windowsHide: true,
        })
      : spawnSync('pnpm', command.split(' '), { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0)
    throw result.error || new Error(`pnpm ${command} 失败，请查看启动日志`);
}
function packageCommand(packageName, binary, args) {
  const manifestPath = require.resolve(packageName + '/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binary];
  if (!entry) throw new Error(`本地依赖缺少 ${binary} 入口，请重新安装锁定依赖`);
  const result = spawnSync(process.execPath, [path.resolve(path.dirname(manifestPath), entry), ...args], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw result.error || new Error(`${binary} 构建失败，请查看启动日志`);
}
try {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor !== 24 || nodeMinor < 15) throw new Error('请先安装 Node.js 24.15 或更高版本的 24 LTS');
  if (
    !existsSync('node_modules/electron') ||
    !existsSync('node_modules/.pnpm/lock.yaml') ||
    readFileSync('node_modules/.pnpm/lock.yaml', 'utf8') !== readFileSync('pnpm-lock.yaml', 'utf8')
  )
    pnpm('install --frozen-lockfile');
  const fingerprint = createHash('sha256');
  function add(filename) {
    const stat = readdirSync(filename, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of stat) {
      if (['dist', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const child = path.join(filename, entry.name);
      if (entry.isDirectory()) add(child);
      else fingerprint.update(child).update(readFileSync(child));
    }
  }
  for (const directory of ['apps/server/src', 'apps/web', 'packages', 'prompts', 'skills', 'assets/brand'])
    add(directory);
  for (const name of ['package.json', 'pnpm-lock.yaml', 'tsconfig.server.json'])
    fingerprint.update(readFileSync(name));
  const digest = fingerprint.digest('hex'),
    marker = path.join(runtime, 'build.sha256');
  if (
    !existsSync(marker) ||
    readFileSync(marker, 'utf8') !== digest ||
    !existsSync('apps/web/dist/index.html') ||
    !existsSync('apps/server/dist/apps/server/src/index.js')
  ) {
    console.log('正在构建 Elysia…');
    packageCommand('typescript', 'tsc', ['-p', 'tsconfig.server.json']);
    packageCommand('vite', 'vite', ['build', '--config', 'apps/web/vite.config.ts']);
    writeFileSync(marker, digest);
  }
  const electron = require('electron');
  const environment = {
    ...process.env,
    ELYSIA_NODE_BINARY: process.execPath,
    ELYSIA_DEV: process.argv.includes('--dev') ? '1' : '0',
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const output = openSync(path.join(runtime, 'desktop-launch.log'), 'a');
  const child = spawn(electron, ['apps/desktop/main.cjs'], {
    cwd: root,
    detached: true,
    windowsHide: false,
    stdio: ['ignore', output, output, 'ipc'],
    env: environment,
  });
  closeSync(output);
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('桌面窗口启动超时，请查看 desktop-launch.log')),
        45000,
      );
      const finish = (error) => {
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      child.on('message', (message) => {
        if (['desktop-ready', 'desktop-focused'].includes(message.type)) finish();
        if (message.type === 'desktop-error') finish(new Error(message.message));
      });
      child.once('error', finish);
      child.once('exit', (code) => finish(new Error('桌面进程在就绪前退出：' + code)));
    });
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
  console.log('已启动 Elysia 独立桌面窗口。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
