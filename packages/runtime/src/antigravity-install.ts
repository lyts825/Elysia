/**
 * 生成固定版本 Antigravity CLI 的容器安装步骤，不运行滚动更新的远端安装脚本。
 * EN: Builds pinned Antigravity CLI installation steps without executing a mutable remote installer.
 */
export const ANTIGRAVITY_VERSION = '1.4.7';

/**
 * 按容器架构下载官方发布包并核对 SHA-256；其他版本必须有官方资产摘要。
 * 只安装归档内唯一的 agy 文件，不展开其他成员，构建后仍需离线版本检测。
 * EN: Downloads an official architecture-specific release and verifies SHA-256. Other versions require
 * an official asset digest. Extracts only the unique agy member; offline version probing still follows.
 */
export function antigravityInstallStep(version: string): string {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/.test(version) || version.length > 80)
    throw new Error('Antigravity version must be an explicit semantic version');
  const script = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const version = ${JSON.stringify(version)};
const hashes = {
  x64: '67fd4e70be739b1f8b18f90b511da8cd2a7aef24e888e5837402e025bf7fdbfc',
  arm64: 'b273c791b7647f680598fa1dbdf9c8086bdc42374b2276fa70e900bf8120e1d5'
};
async function download(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000), headers: { 'User-Agent': 'Elysia' } });
  if (!response.ok) throw Error('Release download failed: HTTP ' + response.status);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Error('Release download exceeded limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
(async () => {
  if (!Object.hasOwn(hashes, process.arch)) throw Error('Unsupported Antigravity architecture');
  const asset = 'agy_cli_linux_' + process.arch + '.tar.gz';
  let expected = version === '${ANTIGRAVITY_VERSION}' ? hashes[process.arch] : undefined;
  if (!expected) {
    const release = JSON.parse(await download('https://api.github.com/repos/google-antigravity/antigravity-cli/releases/tags/' + encodeURIComponent(version), 2097152));
    const digest = release.assets?.find(item => item.name === asset)?.digest;
    if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw Error('Release checksum unavailable');
    expected = digest.slice(7);
  }
  const archive = await download('https://github.com/google-antigravity/antigravity-cli/releases/download/' + encodeURIComponent(version) + '/' + asset, 268435456);
  if (crypto.createHash('sha256').update(archive).digest('hex') !== expected) throw Error('Release checksum mismatch');
  const directory = fs.mkdtempSync('/tmp/elysia-agy-');
  const file = directory + '/release.tar.gz';
  try {
    fs.writeFileSync(file, archive, { mode: 0o600 });
    const members = cp.execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 1048576 }).trim().split('\\n');
    const binaries = members.filter(name => /^(?:\\.\\/)?(?:bin\\/)?agy$/.test(name));
    if (binaries.length !== 1) throw Error('Release executable is ambiguous');
    cp.execFileSync('tar', ['-xzf', file, '-C', directory, '--no-same-owner', '--', binaries[0]]);
    const binary = directory + '/' + binaries[0];
    if (!fs.lstatSync(binary).isFile() || fs.lstatSync(binary).isSymbolicLink()) throw Error('Release executable is not a regular file');
    fs.copyFileSync(binary, '/usr/local/bin/agy');
    fs.chmodSync('/usr/local/bin/agy', 0o755);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(() => { console.error('Antigravity release installation failed; verify version, network and checksum.'); process.exitCode = 1; });
`;
  return `RUN node -e '${script.replace(/'/g, `'\\''`).replace(/\r?\n/g, ' ')}'\n`;
}
