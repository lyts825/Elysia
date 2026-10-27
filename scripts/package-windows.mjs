// 收集运行时和应用文件，组装 Windows 发行包。
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  statSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildLaunch } from './launch-build.mjs';

// 离线打包只使用当前 Windows x64 环境、锁定依赖及精确 Node 版本的许可证。
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { sha256File } = require('../apps/desktop/file-hash.cjs');
const json = (filename) => JSON.parse(readFileSync(filename, 'utf8'));
const args = process.argv.slice(2);
let output = path.join(root, '.elysia-runtime/releases'),
  archive = true;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--no-archive') archive = false;
  else if (args[index] === '--output' && args[index + 1]) output = path.resolve(args[++index]);
  else throw new Error('用法：node scripts/package-windows.mjs [--no-archive] [--output 目录]');
}
if (
  process.platform !== 'win32' ||
  process.arch !== 'x64' ||
  !/^v24\.(?:1[5-9]|[2-9]\d)\./.test(process.version)
)
  throw new Error('Windows x64 分发包须使用本机 Node.js 24.15 或更高的 24 LTS x64 构建');
const appPackage = json(path.join(root, 'package.json'));
const electronPackage = json(require.resolve('electron/package.json'));
const electronDirectory = path.dirname(require('electron'));
if (readFileSync(path.join(electronDirectory, 'version'), 'utf8').trim() !== electronPackage.version)
  throw new Error('本地 Electron 二进制版本与依赖清单不一致');
const nodeLicense = path.join(root, `assets/distribution/node-${process.version}-LICENSE.txt`);
if (!existsSync(nodeLicense)) throw new Error('缺少当前 Node 精确版本许可证：' + nodeLicense);
const nodeLicenseSource = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
const runtimeInputs = new Map();
walk(path.join(root, 'apps/desktop'), (filename) =>
  runtimeInputs.set(path.relative(root, filename), readFileSync(filename)),
);
for (const filename of [
  'scripts/launch-cache.cjs',
  'assets/brand/app-icon.ico',
  'assets/brand/app-icon.png',
  'apps/web/src/Startup.css',
  'apps/web/src/design-tokens.css',
])
  runtimeInputs.set(filename, readFileSync(path.join(root, filename)));
if (
  !existsSync(path.join(root, 'node_modules/.pnpm/lock.yaml')) ||
  readFileSync(path.join(root, 'node_modules/.pnpm/lock.yaml'), 'utf8') !==
    readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
)
  throw new Error('本地依赖与锁文件不一致；打包器不下载或安装依赖');

function command(filename, parameters, cwd = root) {
  const result = spawnSync(filename, parameters, { cwd, windowsHide: true, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || new Error('构建命令失败：' + filename);
}
const build = buildLaunch(root, () => {}, {
  pnpm() {
    throw new Error('离线打包禁止安装依赖');
  },
  packageCommand(directory, packageName, binary, parameters) {
    const manifestPath = require.resolve(packageName + '/package.json');
    const manifest = json(manifestPath);
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binary];
    if (!entry) throw new Error('缺少本地构建工具：' + binary);
    command(process.execPath, [path.resolve(path.dirname(manifestPath), entry), ...parameters], directory);
  },
});
const serverDirectory = path.join(build.directory, 'server');
for (const [filename, bytes] of runtimeInputs)
  if (!readFileSync(path.join(root, filename)).equals(bytes))
    throw new Error('构建期间桌面运行文件发生变化，请重试打包：' + filename);
const externals = new Set();
/** 稳定顺序遍历普通文件；链接和特殊文件拒绝进入发行包。 */
function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('打包输入不能含链接：' + filename);
    if (entry.isDirectory()) walk(filename, visit);
    else if (entry.isFile()) visit(filename);
    else throw new Error('打包输入含特殊文件：' + filename);
  }
}
walk(serverDirectory, (filename) => {
  if (!filename.endsWith('.js')) return;
  const source = readFileSync(filename, 'utf8');
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns)
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier === 'vite') continue;
      externals.add(
        specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0],
      );
    }
});
for (const name of externals)
  if (!appPackage.dependencies[name]) throw new Error('未声明的服务端生产依赖：' + name);

// Resolve the installed dependency graph first; do not flatten distinct versions or copy development dependencies.
const graph = new Map(),
  defaults = new Map();
/** 按依赖所属目录的解析顺序定位安装包，可选依赖缺失时返回 null。 */
function resolvePackage(name, from, optional = false) {
  const resolver = createRequire(path.join(from, 'package.json'));
  for (const directory of resolver.resolve.paths(name) || []) {
    const candidate = path.join(directory, name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  if (optional) return null;
  throw new Error('缺少生产依赖：' + name);
}
/** 构建实际生产依赖图，按目录缓存节点以保留同名不同版本。 */
function collect(directory) {
  if (graph.has(directory)) return graph.get(directory);
  const manifest = json(path.join(directory, 'package.json'));
  const entry = { directory, manifest, dependencies: new Map() };
  graph.set(directory, entry);
  if (!defaults.has(manifest.name)) defaults.set(manifest.name, entry);
  const dependencies = {
    ...manifest.peerDependencies,
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  };
  for (const name of Object.keys(dependencies).sort()) {
    const optional =
      Object.hasOwn(manifest.optionalDependencies || {}, name) ||
      manifest.peerDependenciesMeta?.[name]?.optional === true;
    const dependency = resolvePackage(name, directory, optional);
    if (dependency) entry.dependencies.set(name, collect(dependency));
  }
  return entry;
}
const direct = [...externals].sort().map((name) => [name, collect(resolvePackage(name, root))]);
for (const [name, entry] of direct) defaults.set(name, entry);
const name = `Elysia-${appPackage.version}-win-x64`;
mkdirSync(output, { recursive: true });
output = realpathSync(output);
const destination = path.join(output, name),
  zip = destination + '.zip';
if (existsSync(destination) || existsSync(zip)) throw new Error('分发目标已存在，拒绝覆盖：' + destination);
const stage = path.join(output, '.building-' + randomUUID());
mkdirSync(stage);
/** 复制普通目录和文件，遇到链接或特殊文件时中止打包。 */
function copyTree(source, target, include = () => true) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!include(entry.name)) continue;
    const from = path.join(source, entry.name),
      to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error('复制源包含链接：' + from);
    if (entry.isDirectory()) copyTree(from, to, include);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error('复制源含特殊文件：' + from);
  }
}
const relative = (filename) => path.relative(stage, filename).replaceAll('\\', '/');
try {
  copyTree(electronDirectory, stage, (filename) => filename !== 'default_app.asar');
  renameSync(path.join(stage, 'electron.exe'), path.join(stage, 'Elysia.exe'));
  const app = path.join(stage, 'resources/app');
  mkdirSync(app, { recursive: true });
  writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'elysia',
        version: appPackage.version,
        private: true,
        type: 'module',
        main: 'apps/desktop/main.cjs',
      },
      null,
      2,
    ),
  );
  for (const [filename, bytes] of runtimeInputs) {
    const target = path.join(app, filename);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  copyTree(serverDirectory, path.join(app, 'server'), (filename) => !filename.endsWith('.map'));
  copyTree(build.web, path.join(app, 'web'));
  copyTree(build.resources, app);
  mkdirSync(path.join(app, 'runtime'));
  copyFileSync(process.execPath, path.join(app, 'runtime/node.exe'));
  copyFileSync(nodeLicense, path.join(app, 'runtime/LICENSE-Node.txt'));
  const copied = [],
    rootModules = path.join(app, 'node_modules');
  /** 将依赖图物化为可解析的目录树，校验许可证并拒绝无法物化的循环。 */
  function materialize(entry, target, inherited, ancestors = new Set()) {
    if (ancestors.has(entry.directory)) throw new Error('生产依赖存在无法物化的循环：' + entry.manifest.name);
    const nextAncestors = new Set(ancestors).add(entry.directory);
    copyTree(entry.directory, target, (filename) => filename !== 'node_modules' && filename !== '.git');
    let licenses = readdirSync(target).filter(
      (filename) =>
        /^(licen[sc]e|copying|notice|copyright)([._-]|$)/i.test(filename) &&
        lstatSync(path.join(target, filename)).isFile(),
    );
    if (!licenses.length) {
      const supplement = path.join(
        root,
        'assets/distribution',
        `${entry.manifest.name.replaceAll('/', '-')}-${entry.manifest.version}-LICENSE.txt`,
      );
      if (!existsSync(supplement))
        throw new Error('生产依赖缺少许可正文：' + entry.manifest.name + '@' + entry.manifest.version);
      copyFileSync(supplement, path.join(target, 'LICENSE-redistribution.txt'));
      licenses = ['LICENSE-redistribution.txt'];
    }
    copied.push({
      name: entry.manifest.name,
      version: entry.manifest.version,
      license: entry.manifest.license,
      path: relative(target),
      ...(entry.manifest.name === 'abstract-logging' && entry.manifest.version === '2.0.1'
        ? { supplementalLicenseSource: 'https://jsumners.mit-license.org/license.txt' }
        : {}),
      licenses: licenses.map((filename) => ({
        path: relative(path.join(target, filename)),
        sha256: sha256File(path.join(target, filename)),
      })),
    });
    const local = new Map(inherited);
    for (const [depName, dependency] of entry.dependencies)
      if (inherited.get(depName)?.directory !== dependency.directory) local.set(depName, dependency);
    for (const [depName, dependency] of entry.dependencies)
      if (inherited.get(depName)?.directory !== dependency.directory)
        materialize(dependency, path.join(target, 'node_modules', depName), local, nextAncestors);
  }
  for (const [packageName, entry] of defaults)
    materialize(entry, path.join(rootModules, packageName), defaults);
  const notices = {
    node: {
      version: process.version,
      source: nodeLicenseSource,
      license: 'resources/app/runtime/LICENSE-Node.txt',
      sha256: sha256File(nodeLicense),
    },
    electron: {
      version: electronPackage.version,
      license: 'LICENSE',
      chromiumLicense: 'LICENSES.chromium.html',
    },
    dependencies: copied,
  };
  writeFileSync(path.join(stage, 'THIRD_PARTY_NOTICES.json'), JSON.stringify(notices, null, 2));
  writeFileSync(
    path.join(stage, 'Verify-Elysia.cmd'),
    '@echo off\r\n"%~dp0resources\\app\\runtime\\node.exe" "%~dp0resources\\app\\apps\\desktop\\packaged.cjs"\r\nexit /b %errorlevel%\r\n',
  );
  writeFileSync(
    path.join(stage, 'PORTABLE-README.txt'),
    `Elysia ${appPackage.version} Windows x64 portable distribution\r\n\r\nStart Elysia.exe. No Node.js, pnpm, installation or dependency download is required.\r\nThis ZIP is not a signed installer. Windows executable resource details may identify the upstream Electron runtime.\r\nVerify all packaged files with Verify-Elysia.cmd; the release SHA256 file verifies the ZIP. Checksums do not establish publisher identity.\r\n\r\nUser data and logs: %LOCALAPPDATA%\\Elysia (or explicit ELYSIA_DATA_DIR).\r\nUpgrade: safely close Elysia, extract the new version to a separate program directory, verify it, then start its Elysia.exe. Keep the previous program and upgrade backups until verified.\r\nUninstall this portable program by deleting only its extracted program directory after closing it. This does not remove the separate user data directory. Never delete user data to update the program.\r\nA database format upgrade creates a backup before migration. Downgrading may require restoring that backup using a compatible version.\r\nModel requests require your configured provider and network. Docker/agent CLIs are optional external tools and are not bundled.\r\n\r\nLicenses and exact runtime versions: THIRD_PARTY_NOTICES.json. File manifest: resources\\app\\distribution.json.\r\n`,
  );
  const compiledVersion = readFileSync(
    path.join(app, 'server/packages/contracts/src/index.js'),
    'utf8',
  ).match(/export const VERSION = ['"]([^'"]+)['"]/);
  if (compiledVersion?.[1] !== appPackage.version) throw new Error('编译版本与根清单不一致');
  const files = {};
  walk(stage, (filename) => {
    files[relative(filename)] = { bytes: statSync(filename).size, sha256: sha256File(filename) };
  });
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const manifest = {
    format: 1,
    app: 'Elysia',
    version: appPackage.version,
    platform: 'win32',
    arch: 'x64',
    nodeVersion: process.version,
    electronVersion: electronPackage.version,
    applicationSignature: 'not-signed-by-elysia',
    createdAt: new Date().toISOString(),
    sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
    sourceTreeDirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
    lockHash: sha256File(path.join(root, 'pnpm-lock.yaml')),
    buildDigest: path.basename(build.directory),
    dependencies: copied,
    files,
  };
  writeFileSync(path.join(app, 'distribution.json'), JSON.stringify(manifest, null, 2));
  command(process.execPath, [path.join(app, 'apps/desktop/packaged.cjs')], stage);
  renameSync(stage, destination);
  if (archive) {
    command('tar.exe', ['-a', '-cf', zip, '-C', output, name]);
    writeFileSync(zip + '.sha256', `${sha256File(zip)}  ${path.basename(zip)}\n`);
  }
  console.log(
    JSON.stringify({
      directory: destination,
      zip: archive ? zip : null,
      version: appPackage.version,
      files: Object.keys(files).length,
      productionPackages: copied.length,
      uniqueProductionPackages: graph.size,
      nodeVersion: process.version,
      electronVersion: electronPackage.version,
    }),
  );
} finally {
  if (existsSync(stage)) {
    const resolved = realpathSync(stage);
    if (path.dirname(resolved) !== output || !path.basename(resolved).startsWith('.building-'))
      throw new Error('拒绝清理不属于本次打包的暂存目录');
    rmSync(resolved, { recursive: true, force: true });
  }
}
