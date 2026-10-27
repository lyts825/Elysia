// 检查启动构建输入并执行所需的构建命令。
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

function captureBuildInputs(root) {
  const fingerprint = createHash('sha256');
  const resources = new Map();
  function add(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const builtin = /^(prompts|skills)(?:[\\/]|$)/.test(relative);
      if (entry.isSymbolicLink()) {
        if (builtin) throw new Error('内置运行资源不能使用链接：' + path.join(relative, entry.name));
        continue;
      }
      if (['dist', 'node_modules'].includes(entry.name)) continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) add(child);
      else {
        const bytes = readFileSync(path.join(root, child));
        fingerprint.update(child).update(bytes);
        if (builtin) resources.set(child.replaceAll('\\', '/'), bytes);
      }
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
  return { digest: fingerprint.digest('hex'), resources };
}

export function buildLaunch(root, mark = () => {}, commands = { pnpm, packageCommand }) {
  if (
    !existsSync(path.join(root, 'node_modules/.pnpm/lock.yaml')) ||
    readFileSync(path.join(root, 'node_modules/.pnpm/lock.yaml'), 'utf8') !==
      readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
  )
    commands.pnpm(root, 'install --frozen-lockfile');
  mark('dependencies-ready');
  const { digest, resources } = captureBuildInputs(root);
  mark('fingerprint-ready');
  const builds = path.join(root, '.elysia-runtime', 'builds'),
    destination = path.join(builds, digest);
  const resourceHashes = Object.fromEntries(
    [...resources].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]),
  );
  const resourcesMatch = (directory) =>
    Object.entries(resourceHashes).every(
      ([name, hash]) =>
        createHash('sha256')
          .update(readFileSync(path.join(directory, 'resources', name)))
          .digest('hex') === hash,
    );
  const complete = () => {
    try {
      const manifest = JSON.parse(readFileSync(path.join(destination, 'build.json'), 'utf8'));
      return (
        manifest.formatVersion === 2 &&
        manifest.leaseProtocol === 1 &&
        manifest.digest === digest &&
        JSON.stringify(manifest.resources) === JSON.stringify(resourceHashes) &&
        existsSync(path.join(destination, 'web/index.html')) &&
        existsSync(path.join(destination, 'server/apps/server/src/index.js')) &&
        resourcesMatch(destination)
      );
    } catch {
      return false;
    }
  };
  let mode = 'cached';
  if (!complete()) {
    if (existsSync(destination)) throw new Error('启动构建缓存不完整，请保留日志并核验：' + destination);
    mode = 'rebuilt';
    mkdirSync(builds, { recursive: true });
    const stage = path.join(builds, '.building-' + randomUUID());
    mkdirSync(stage);
    try {
      // Publish the exact bytes included in this build's fingerprint, even if the checkout changes later.
      for (const [name, bytes] of resources) {
        const target = path.join(stage, 'resources', name);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
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
      if (captureBuildInputs(root).digest !== digest)
        throw new Error('构建期间源文件已变化，未发布此次构建，请重试启动');
      if (!resourcesMatch(stage)) throw new Error('构建资源校验失败，未发布此次构建，请重试启动');
      writeFileSync(
        path.join(stage, 'build.json'),
        JSON.stringify({
          formatVersion: 2,
          leaseProtocol: 1,
          digest,
          createdAt: new Date().toISOString(),
          resources: resourceHashes,
        }),
      );
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(stage, destination);
          break;
        } catch (error) {
          if (complete()) break;
          // Windows scanners can briefly hold freshly written files. Never replace an existing build.
          if (existsSync(destination) || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5)
            throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * 2 ** attempt);
        }
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
    resources: path.join(destination, 'resources'),
  };
}
