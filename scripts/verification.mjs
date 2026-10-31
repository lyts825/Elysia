/**
 * 打包、核验和运行独立验收材料，绑定应用源码、依赖和运行环境。
 * EN: Package, verify, and run external acceptance materials against exact source and dependencies.
 * 测试正文仅存于本地验收包；本模块是交付工具，不内置测试用例。
 * EN: Test bodies stay in local verification bundles; this delivery tool contains no test cases.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { captureBuildInputs } from './launch-build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const MAX_BYTES = 64 * 1024 * 1024;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/**
 * 只接受测试目录下的普通文件，逐级拒绝链接，避免包路径越界或覆盖用户源码。
 * EN: Accept ordinary files under the test directory and reject links at every path component.
 */
function relativeFile(value) {
  assert(
    typeof value === 'string' &&
      /^\.local-tests\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|mjs|cjs|json)$/.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.endsWith('.')),
    '验收包文件路径无效',
  );
  return value;
}
function plainFile(base, relative, allowMissing = false) {
  let current = fs.realpathSync(base);
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    if (!fs.existsSync(current)) {
      if (allowMissing) continue;
      throw new Error('验收文件缺失：' + relative);
    }
    const stat = fs.lstatSync(current);
    assert(!stat.isSymbolicLink(), '验收文件路径不能含链接：' + relative);
    assert(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(), '验收文件类型无效');
  }
  return current;
}
function suites(value, files) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 32, '验收包需要 1 至 32 个验收入口');
  const ids = new Set(['server-types', 'web-types', 'server-build', 'web-build']);
  return value.map((suite) => {
    assert(suite && /^[a-z][a-z0-9-]{0,63}$/.test(suite.id) && !ids.has(suite.id), '验收入口标识无效或重复');
    ids.add(suite.id);
    const entry = relativeFile(suite.entry);
    assert(files.has(entry) && !entry.endsWith('.json'), '验收入口必须包含在文件清单中');
    assert(
      Number.isInteger(suite.timeoutMs) && suite.timeoutMs >= 1000 && suite.timeoutMs <= 600000,
      '验收超时必须为 1 秒至 10 分钟',
    );
    assert(
      suite.args === undefined ||
        (Array.isArray(suite.args) &&
          suite.args.length <= 16 &&
          suite.args.every((v) => typeof v === 'string' && v.length <= 1000)),
      '验收参数无效',
    );
    return { id: suite.id, entry, args: suite.args ?? [], timeoutMs: suite.timeoutMs };
  });
}
function identity(directory) {
  return {
    version: json(path.join(directory, 'package.json')).version,
    sourceDigest: captureBuildInputs(directory).digest,
    lockHash: digest(fs.readFileSync(path.join(directory, 'pnpm-lock.yaml'))),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}
function sameIdentity(expected, actual) {
  for (const field of ['version', 'sourceDigest', 'lockHash', 'nodeVersion', 'platform', 'arch'])
    assert(expected[field] === actual[field], '验收输入不匹配：' + field);
}

/**
 * 核对完整清单和文件摘要后才允许安装或执行，校验和不代表发布者身份。
 * EN: Verify the complete manifest and file digests before installation or execution; hashes do not
 * authenticate a publisher.
 */
export function inspectBundle(bundle, directory = root) {
  const manifestFile = plainFile(bundle, 'manifest.json');
  assert(fs.statSync(manifestFile).size <= 1024 * 1024, '验收清单过大');
  const bytes = fs.readFileSync(manifestFile),
    manifest = JSON.parse(bytes);
  assert(
    manifest.format === 1 &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= 512,
    '验收包格式无效',
  );
  sameIdentity(manifest, identity(directory));
  const names = new Set(),
    entries = new Set();
  let total = 0;
  for (const file of manifest.files) {
    const relative = relativeFile(file.path),
      key = relative.toLowerCase();
    assert(!names.has(key), '验收包包含重复文件');
    names.add(key);
    entries.add(relative);
    assert(
      Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256),
      '验收文件清单无效',
    );
    total += file.bytes;
    assert(total <= MAX_BYTES, '验收包超过 64 MiB 上限');
    const filename = plainFile(bundle, relative);
    assert(
      fs.statSync(filename).size === file.bytes && digest(fs.readFileSync(filename)) === file.sha256,
      '验收文件校验失败：' + relative,
    );
  }
  manifest.suites = suites(manifest.suites, entries);
  return { manifest, manifestHash: digest(bytes), bundle: fs.realpathSync(bundle) };
}

export function createBundle(specFile, output, directory = root) {
  const spec = json(specFile);
  assert(Array.isArray(spec.files) && spec.files.length > 0 && spec.files.length <= 512, '验收文件清单无效');
  const names = new Set(),
    files = [];
  let total = 0;
  for (const value of spec.files) {
    const relative = relativeFile(value);
    assert(!names.has(relative.toLowerCase()), '验收包包含重复文件');
    names.add(relative.toLowerCase());
    const source = plainFile(directory, relative),
      size = fs.statSync(source).size;
    total += size;
    assert(total <= MAX_BYTES, '验收包超过 64 MiB 上限');
    const bytes = fs.readFileSync(source);
    files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
  }
  const manifest = {
    format: 1,
    ...identity(directory),
    files,
    suites: suites(spec.suites, new Set(files.map((f) => f.path))),
  };
  assert(!fs.existsSync(output), '验收包目标已存在，拒绝覆盖');
  fs.mkdirSync(output, { recursive: true });
  for (const file of files) {
    const destination = plainFile(output, file.path, true);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(plainFile(directory, file.path), destination, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  return inspectBundle(output, directory);
}

/**
 * 非零退出、启动失败和超时均记录为失败；Windows 超时结束本次子进程树。
 * EN: Record nonzero exits, startup failures, and timeouts as failures; terminate the owned Windows
 * process tree on timeout.
 */
async function execute(directory, args, timeoutMs, log) {
  const started = performance.now();
  const output = fs.openSync(log, 'wx', 0o600);
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: directory,
      windowsHide: true,
      stdio: ['ignore', output, output],
      env: { ...process.env, ELYSIA_VERIFICATION_OFFLINE: '1' },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        const kill = spawn(
          path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'],
          { windowsHide: true, stdio: 'ignore' },
        );
        kill.on('error', () => child.kill('SIGKILL'));
        kill.on('exit', (code) => {
          if (code) child.kill('SIGKILL');
        });
      } else child.kill('SIGKILL');
    }, timeoutMs);
    try {
      const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      return {
        status: exitCode === 0 && !timedOut ? 'passed' : 'failed',
        exitCode,
        timedOut,
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { status: 'failed', error: error.message, durationMs: Math.round(performance.now() - started) };
  } finally {
    fs.closeSync(output);
  }
}
function binary(directory, packageName, key) {
  const require = createRequire(path.join(directory, 'package.json'));
  const filename = require.resolve(packageName + '/package.json'),
    manifest = json(filename);
  return path.resolve(
    path.dirname(filename),
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[key],
  );
}
function atomicReport(filename, report) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filename);
}

export async function runBundle(bundle, output, directory = root) {
  const { manifest, manifestHash } = inspectBundle(bundle, directory);
  assert(
    fs.readFileSync(path.join(directory, 'node_modules/.pnpm/lock.yaml'), 'utf8') ===
      fs.readFileSync(path.join(directory, 'pnpm-lock.yaml'), 'utf8'),
    '已安装依赖与锁文件不一致',
  );
  // 先核对所有现有文件，再复制缺失文件；已有不同内容绝不覆盖。
  // EN: Validate all existing targets before copying missing files; never overwrite differing data.
  for (const file of manifest.files) {
    const target = plainFile(directory, file.path, true);
    if (fs.existsSync(target))
      assert(digest(fs.readFileSync(target)) === file.sha256, '本地验收材料与包不一致：' + file.path);
  }
  for (const file of manifest.files) {
    const target = plainFile(directory, file.path, true);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(plainFile(bundle, file.path), target, fs.constants.COPYFILE_EXCL);
    }
  }
  assert(!fs.existsSync(output), '验收报告目录已存在，拒绝覆盖');
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(path.join(directory, '.local-qa'), { recursive: true });
  const report = {
    format: 1,
    ...identity(directory),
    manifestHash,
    status: 'running',
    startedAt: new Date().toISOString(),
    checks: [],
  };
  const filename = path.join(output, 'verification.json');
  const commands = [
    {
      id: 'server-types',
      args: [binary(directory, 'typescript', 'tsc'), '-p', 'tsconfig.server.json', '--noEmit'],
      timeoutMs: 120000,
    },
    {
      id: 'web-types',
      args: [binary(directory, 'typescript', 'tsc'), '-p', 'apps/web/tsconfig.json', '--noEmit'],
      timeoutMs: 120000,
    },
    {
      id: 'server-build',
      args: [binary(directory, 'typescript', 'tsc'), '-p', 'tsconfig.server.json'],
      timeoutMs: 120000,
    },
    {
      id: 'web-build',
      args: [binary(directory, 'vite', 'vite'), 'build', '--config', 'apps/web/vite.config.ts'],
      timeoutMs: 120000,
    },
    ...manifest.suites.map((suite) => ({
      ...suite,
      args: [...(/\.tsx?$/.test(suite.entry) ? ['--import', 'tsx'] : []), suite.entry, ...suite.args],
    })),
  ];
  atomicReport(filename, report);
  try {
    for (const command of commands) {
      const result = await execute(
        directory,
        command.args,
        command.timeoutMs,
        path.join(output, command.id + '.log'),
      );
      report.checks.push({ id: command.id, ...result });
      console.log(`${command.id}: ${result.status}`);
      atomicReport(filename, report);
      assert(result.status === 'passed', '验收失败：' + command.id);
    }
    inspectBundle(bundle, directory);
    for (const file of manifest.files)
      assert(
        digest(fs.readFileSync(plainFile(directory, file.path))) === file.sha256,
        '验收期间测试材料发生变化',
      );
    sameIdentity(report, identity(directory));
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
  }
  report.finishedAt = new Date().toISOString();
  atomicReport(filename, report);
  return report;
}

/** 核验当前输入与完整成功报告，不能用旧版本或部分通过的结果放行交付。
 * EN: Require a complete passing report for current inputs, never a stale or partial result.
 */
export function checkVerification(bundle, reportFile, directory = root) {
  const { manifest, manifestHash } = inspectBundle(bundle, directory),
    report = json(reportFile);
  sameIdentity(report, identity(directory));
  assert(
    report.format === 1 &&
      report.status === 'passed' &&
      report.manifestHash === manifestHash &&
      typeof report.finishedAt === 'string' &&
      Number.isFinite(Date.parse(report.finishedAt)),
    '缺少匹配当前验收包的通过报告',
  );
  const expected = [
    'server-types',
    'web-types',
    'server-build',
    'web-build',
    ...manifest.suites.map((suite) => suite.id),
  ];
  assert(
    Array.isArray(report.checks) &&
      report.checks.length === expected.length &&
      report.checks.every(
        (check, index) =>
          check.id === expected[index] &&
          check.status === 'passed' &&
          check.exitCode === 0 &&
          !check.timedOut,
      ),
    '验收报告项目不完整或存在失败',
  );
  return {
    version: manifest.version,
    sourceDigest: manifest.sourceDigest,
    manifestHash,
    verifiedAt: report.finishedAt,
    status: 'passed',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2),
      options = {};
    for (let index = 0; index < args.length; index += 2) {
      assert(
        ['--spec', '--output', '--bundle', '--report', '--root'].includes(args[index]) &&
          args[index + 1] &&
          !options[args[index]],
        '无效或重复参数',
      );
      options[args[index]] = path.resolve(args[index + 1]);
    }
    const directory = options['--root'] ?? root;
    let result;
    if (action === 'bundle' && options['--spec'] && options['--output'])
      result = createBundle(options['--spec'], options['--output'], directory).manifest;
    else if (action === 'inspect' && options['--bundle'])
      result = inspectBundle(options['--bundle'], directory).manifest;
    else if (action === 'run' && options['--bundle'] && options['--output'])
      result = await runBundle(options['--bundle'], options['--output'], directory);
    else if (action === 'check' && options['--bundle'] && options['--report'])
      result = checkVerification(options['--bundle'], options['--report'], directory);
    else
      throw new Error(
        '用法：verification.mjs bundle --spec 文件 --output 目录 | inspect --bundle 目录 | run --bundle 目录 --output 报告目录 | check --bundle 目录 --report verification.json；可加 --root 源码目录',
      );
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'failed') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
