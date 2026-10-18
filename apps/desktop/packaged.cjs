const fs = require('node:fs');
const path = require('node:path');
const { sha256File } = require('./file-hash.cjs');
const relativeFile = (directory, relative) => {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\\') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))
  )
    throw new Error('分发包文件路径无效');
  const filename = path.join(directory, ...relative.split('/'));
  const resolved = fs.realpathSync(filename);
  const within = path.relative(fs.realpathSync(directory), resolved);
  if (!within || within.startsWith('..' + path.sep) || path.isAbsolute(within))
    throw new Error('分发包文件超出程序目录');
  if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink())
    throw new Error('分发包条目不是普通文件');
  return filename;
};
function verifyDistribution(appRoot, full = false) {
  const directory = path.resolve(appRoot, '../..');
  const file = path.join(appRoot, 'distribution.json');
  if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('分发包清单过大');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    manifest.format !== 1 ||
    manifest.app !== 'Elysia' ||
    manifest.platform !== 'win32' ||
    manifest.arch !== 'x64' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version) ||
    !/^v24\.\d+\.\d+$/.test(manifest.nodeVersion) ||
    !/^\d+\.\d+\.\d+$/.test(manifest.electronVersion) ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files) ||
    Object.keys(manifest.files).length > 30000
  )
    throw new Error('分发包清单无效');
  const critical = [
    'Elysia.exe',
    'resources/app/package.json',
    'resources/app/runtime/node.exe',
    'resources/app/apps/desktop/main.cjs',
    'resources/app/apps/desktop/preload.cjs',
    'resources/app/apps/desktop/packaged.cjs',
    'resources/app/apps/desktop/file-hash.cjs',
    'resources/app/server/apps/server/src/index.js',
    'resources/app/server/packages/contracts/src/index.js',
    'resources/app/web/index.html',
  ];
  for (const relative of critical)
    if (!Object.hasOwn(manifest.files, relative)) throw new Error('分发包清单缺少必要文件：' + relative);
  if (full) {
    const pending = [directory];
    while (pending.length) {
      for (const entry of fs.readdirSync(pending.pop(), { withFileTypes: true })) {
        const filename = path.join(entry.parentPath, entry.name);
        if (entry.isSymbolicLink()) throw new Error('分发包包含链接');
        if (entry.isDirectory()) pending.push(filename);
        else {
          const relative = path.relative(directory, filename).replaceAll('\\', '/');
          if (
            !entry.isFile() ||
            (relative !== 'resources/app/distribution.json' && !Object.hasOwn(manifest.files, relative))
          )
            throw new Error('分发包包含清单外文件：' + relative);
        }
      }
    }
  }
  for (const relative of full ? Object.keys(manifest.files) : critical) {
    const entry = manifest.files[relative];
    if (
      !entry ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error('分发包缺少可核验条目：' + relative);
    const filename = relativeFile(directory, relative);
    if (fs.statSync(filename).size !== entry.bytes || sha256File(filename) !== entry.sha256)
      throw new Error('分发包文件校验失败：' + relative);
  }
  const appPackage = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  if (appPackage.version !== manifest.version) throw new Error('分发包应用版本不一致');
  return manifest;
}
function packagedBuild(appRoot) {
  const manifest = verifyDistribution(appRoot);
  if (process.versions.electron && process.versions.electron !== manifest.electronVersion)
    throw new Error('分发包 Electron 版本不一致');
  return {
    manifest,
    build: {
      mode: 'cached',
      directory: appRoot,
      server: path.join(appRoot, 'server/apps/server/src/index.js'),
      web: path.join(appRoot, 'web'),
      resources: appRoot,
      node: path.join(appRoot, 'runtime/node.exe'),
    },
  };
}
module.exports = { packagedBuild, verifyDistribution };
if (require.main === module) {
  try {
    const manifest = verifyDistribution(path.resolve(__dirname, '../..'), true);
    if (process.version !== manifest.nodeVersion) throw new Error('核验进程与包内 Node 版本不一致');
    console.log(
      JSON.stringify({
        verified: true,
        version: manifest.version,
        files: Object.keys(manifest.files).length,
        nodeVersion: manifest.nodeVersion,
        electronVersion: manifest.electronVersion,
        unsigned: true,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
