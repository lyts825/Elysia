import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function pnpm(root, command) {
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
function packageCommand(root, packageName, binary, args) {
  const require = createRequire(path.join(root, 'package.json'));
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

export function buildLaunch(root, mark = () => {}, commands = { pnpm, packageCommand }) {
  if (
    !existsSync(path.join(root, 'node_modules/.pnpm/lock.yaml')) ||
    readFileSync(path.join(root, 'node_modules/.pnpm/lock.yaml'), 'utf8') !==
      readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
  )
    commands.pnpm(root, 'install --frozen-lockfile');
  mark('dependencies-ready');
  const fingerprint = createHash('sha256');
  function add(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (['dist', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) add(child);
      else fingerprint.update(child).update(readFileSync(path.join(root, child)));
    }
  }
  for (const directory of [
    'apps/server/src',
    'apps/web',
    'apps/desktop',
    'packages',
    'prompts',
    'skills',
    'assets/brand',
    'scripts',
  ])
    add(directory);
  for (const name of ['package.json', 'pnpm-lock.yaml', 'tsconfig.server.json'])
    fingerprint.update(readFileSync(path.join(root, name)));
  const digest = fingerprint.digest('hex');
  mark('fingerprint-ready');
  const builds = path.join(root, '.elysia-runtime', 'builds'),
    destination = path.join(builds, digest);
  const complete = () =>
    existsSync(path.join(destination, 'build.json')) &&
    existsSync(path.join(destination, 'web/index.html')) &&
    existsSync(path.join(destination, 'server/apps/server/src/index.js'));
  let mode = 'cached';
  if (!complete()) {
    if (existsSync(destination)) throw new Error('启动构建缓存不完整，请保留日志并核验：' + destination);
    mode = 'rebuilt';
    mkdirSync(builds, { recursive: true });
    const stage = path.join(builds, '.building-' + randomUUID());
    mkdirSync(stage);
    try {
      commands.packageCommand(root, 'typescript', 'tsc', [
        '-p',
        'tsconfig.server.json',
        '--outDir',
        path.join(stage, 'server'),
      ]);
      commands.packageCommand(root, 'vite', 'vite', [
        'build',
        '--config',
        'apps/web/vite.config.ts',
        '--outDir',
        path.join(stage, 'web'),
      ]);
      if (
        !existsSync(path.join(stage, 'web/index.html')) ||
        !existsSync(path.join(stage, 'server/apps/server/src/index.js'))
      )
        throw new Error('启动构建缺少服务或页面入口');
      writeFileSync(
        path.join(stage, 'build.json'),
        JSON.stringify({ digest, createdAt: new Date().toISOString() }),
      );
      try {
        renameSync(stage, destination);
      } catch (error) {
        if (!complete()) throw error;
      }
    } finally {
      // Only this invocation's unpublished stage is disposable; published builds may serve live windows.
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    }
  }
  mark('build-ready');
  return {
    mode,
    directory: destination,
    server: path.join(destination, 'server/apps/server/src/index.js'),
    web: path.join(destination, 'web'),
  };
}
