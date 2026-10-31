/**
 * 检查启动构建输入并执行所需的构建命令。
 * EN: Fingerprint launch-build inputs and run the required local build commands.
 *
 * 基于源码与配置指纹判断构建是否可复用，构建过程集中管理输出和失败；启动器只接受完成核验的构建结果。
 * EN: Use source/configuration fingerprints to determine build reuse and manage build output and failures; launch accepts only validated build results.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * 优先使用当前 Node 自带的 Corepack；失败时向启动流程传递明确错误。
 * EN: Prefer Corepack bundled with the current Node runtime; propagate failed commands as explicit
 * launcher errors.
 */
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
/**
 * 从项目本地依赖的 package.json 解析可执行入口，避免依赖全局命令版本。
 * EN: Resolve a binary from the project local package.json instead of depending on a global command
 * version.
 */
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

/**
 * 按稳定目录顺序计算构建输入摘要，并保存将随构建发布的提示词和技能原文。
 * EN: Fingerprint inputs in stable directory order and capture exact prompt/skill bytes to publish
 * with this build.
 */
export function captureBuildInputs(root) {
  const fingerprint = createHash('sha256');
  const resources = new Map();
  /**
   * 按稳定顺序递归收集构建输入，拒绝内置资源链接并跳过依赖与构建输出目录。
   * EN: Collect build inputs recursively in stable order, rejecting links for built-in resources and skipping dependencies/build outputs.
   */
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

/**
 * 校验锁定依赖后按输入摘要复用或构建缓存。新构建先写入独立临时目录，
 * 核对源文件未变化和资源哈希后再原子发布；不完整的既有缓存不会被覆盖。
 * mark 接收启动阶段，commands 可由调用方注入构建命令。
 * EN: After checking locked dependencies, reuse or build a digest-keyed cache. Build into a unique
 * stage, verify unchanged inputs and resource hashes, then publish atomically. Never overwrite an
 * incomplete existing cache. mark receives startup stages; commands allows host injection of build
 * runners.
 */
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
  /**
   * 逐条核对已捕获资源的实际摘要，防止缓存清单与发布字节不一致。
   * EN: Verify captured-resource digests against actual bytes so cache metadata and published resources agree.
   */
  const resourcesMatch = (directory) =>
    Object.entries(resourceHashes).every(
      ([name, hash]) =>
        createHash('sha256')
          .update(readFileSync(path.join(directory, 'resources', name)))
          .digest('hex') === hash,
    );
  /**
   * 同时核对构建协议、输入摘要、入口和资源完整性，异常视为缓存不完整。
   * EN: Check build protocol, input digest, entry points, and resource integrity; treat exceptions as an incomplete cache.
   */
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
      // 发布与本次指纹完全相同的资源字节，即使之后工作区内容发生变化。
      // EN: Publish the exact resource bytes included in this fingerprint, even if the checkout changes
      // afterwards.
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
          // Windows扫描程序可能短暂占用新文件，因此有限重试重命名，但绝不替换已有构建。
          // EN: Windows scanners may briefly hold new files, so retry rename within bounds without ever
          // replacing an existing build.
          if (existsSync(destination) || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5)
            throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * 2 ** attempt);
        }
      }
    } finally {
      // 只清理本次尚未发布的临时stage，已发布构建可能仍被窗口使用。
      // EN: Only this invocation unpublished stage is disposable; published builds may still serve live
      // windows.
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
