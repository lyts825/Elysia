// 管理构建缓存占用、租约及可清理性检查。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function directory(filename, create = false) {
  if (create && !fs.existsSync(filename)) fs.mkdirSync(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('启动缓存目录不能是链接或特殊文件');
}
/**
 * 为指定摘要目录建立租约并记录桌面 PID。backend() 写入服务进程 PID，
 * close() 持久记录正常退出；租约文件使用独占创建并在写入后同步到磁盘。
 */
function createBuildLease(buildDirectory) {
  const build = fs.realpathSync(buildDirectory),
    builds = path.dirname(build);
  if (!/^[a-f0-9]{64}$/.test(path.basename(build)) || path.basename(builds) !== 'builds')
    throw new Error('启动构建路径无效');
  directory(builds);
  const leases = path.join(path.dirname(builds), 'build-leases');
  directory(leases, true);
  const target = path.join(leases, path.basename(build));
  directory(target, true);
  const file = path.join(target, randomUUID() + '.json');
  const fd = fs.openSync(file, 'wx', 0o600);
  let closed = false;
  const state = {
    format: 1,
    build: path.basename(build),
    desktopPid: process.pid,
    backendPid: null,
    state: 'active',
    startedAt: new Date().toISOString(),
  };
  const save = () => {
    const bytes = Buffer.from(JSON.stringify(state));
    fs.ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fs.fsyncSync(fd);
  };
  try {
    save();
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return {
    backend(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('启动服务 PID 无效');
      state.backendPid = pid;
      save();
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        state.state = 'closed';
        state.closedAt = new Date().toISOString();
        save();
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

/** 进程不存在可判为 dead；权限不足等其他错误保持 unknown，避免误判。 */
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}
/** 统计文件数和字节；链接、硬链接或读取失败使结果标记为不确定。 */
function footprint(root) {
  let bytes = 0,
    files = 0,
    unknown = false;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        unknown = true;
        continue;
      }
      if (stat.isDirectory())
        for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
      else if (stat.isFile()) {
        bytes += stat.size;
        files++;
        if (stat.nlink !== 1) unknown = true;
      } else unknown = true;
    } catch {
      unknown = true;
    }
  }
  return { bytes, files, unknown };
}
function readJson(file, limit = 64 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit)
    throw new Error('缓存元数据不可核验');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
/** 只在租约格式可核验、进程已退出且登记正常关闭时返回 closed。 */
function leaseState(leaseRoot, build) {
  try {
    directory(leaseRoot);
    const root = path.join(leaseRoot, build);
    directory(root);
    const files = fs.readdirSync(root);
    if (!files.length || files.length > 10000) return 'unknown';
    let uncertain = false;
    for (const file of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) {
        uncertain = true;
        continue;
      }
      const item = readJson(path.join(root, file), 4096);
      if (item.format !== 1 || item.build !== build || !['active', 'closed'].includes(item.state)) {
        uncertain = true;
        continue;
      }
      const desktop = alive(item.desktopPid),
        backend = item.backendPid === null ? 'dead' : alive(item.backendPid);
      if (desktop === 'alive' || backend === 'alive') return 'active';
      // Dead PIDs alone never authorize cleanup: crashes, PID reuse and legacy launchers are ambiguous.
      if (desktop === 'unknown' || backend === 'unknown' || item.state !== 'closed') uncertain = true;
    }
    return uncertain ? 'unknown' : 'closed';
  } catch {
    return 'unknown';
  }
}
/**
 * 只读检查缓存并保留最近 keep 个构建。占用、格式或租约不确定时保守保留；
 * 即使给出 review-only 建议，也不会删除文件或授予删除权限。
 */
function inspectBuildCache(root, keep = 2) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100) throw new Error('--keep 必须为 1 至 100');
  root = fs.realpathSync(root);
  const runtime = path.join(root, '.elysia-runtime'),
    builds = path.join(runtime, 'builds');
  const entries = [];
  if (fs.existsSync(builds)) {
    directory(runtime);
    directory(builds);
    for (const name of fs.readdirSync(builds).sort()) {
      const target = path.join(builds, name),
        usage = footprint(target);
      const entry = {
        name,
        ...usage,
        createdAt: null,
        lease: 'unknown',
        reasons: [],
        recommendation: 'retain',
      };
      try {
        directory(target);
        const manifest = readJson(path.join(target, 'build.json'));
        if (
          !/^[a-f0-9]{64}$/.test(name) ||
          manifest.digest !== name ||
          manifest.formatVersion !== 2 ||
          manifest.leaseProtocol !== 1 ||
          !Number.isFinite(Date.parse(manifest.createdAt))
        )
          throw new Error('legacy');
        for (const required of ['web/index.html', 'server/apps/server/src/index.js']) {
          const stat = fs.lstatSync(path.join(target, required));
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('incomplete');
        }
        directory(path.join(target, 'resources'));
        if (
          !manifest.resources ||
          typeof manifest.resources !== 'object' ||
          Array.isArray(manifest.resources)
        )
          throw new Error('unknown resources');
        for (const [resource, digest] of Object.entries(manifest.resources)) {
          if (
            !/^(prompts|skills)\/[a-zA-Z0-9_./-]+$/.test(resource) ||
            resource.split('/').includes('..') ||
            !/^[a-f0-9]{64}$/.test(digest)
          )
            throw new Error('unknown resource');
          const stat = fs.lstatSync(path.join(target, 'resources', resource));
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('incomplete resource');
        }
        entry.createdAt = manifest.createdAt;
        entry.lease = leaseState(path.join(runtime, 'build-leases'), name);
      } catch {
        entry.reasons.push('旧格式、未完成或无法核验的构建，保留');
      }
      if (usage.unknown) entry.reasons.push('包含链接、共享文件或读取异常，保留');
      if (entry.lease === 'active') entry.reasons.push('有存活进程登记，保留（PID 复用也保守保留）');
      else if (entry.lease !== 'closed') entry.reasons.push('缺少可核验的正常退出记录，保留');
      entries.push(entry);
    }
  }
  const newest = new Set(
    entries
      .filter((item) => item.createdAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, keep)
      .map((item) => item.name),
  );
  for (const entry of entries) {
    if (newest.has(entry.name)) entry.reasons.push('保留最近 ' + keep + ' 个构建');
    if (!entry.reasons.length) {
      entry.recommendation = 'review-only';
      entry.reasons.push('已登记正常退出的历史构建，仅供人工复核，不构成删除授权');
    }
  }
  return {
    previewOnly: true,
    deletionSupported: false,
    root: builds,
    keep,
    totalBytes: entries.reduce((sum, item) => sum + item.bytes, 0),
    retainedBytes: entries
      .filter((item) => item.recommendation === 'retain')
      .reduce((sum, item) => sum + item.bytes, 0),
    reviewBytes: entries
      .filter((item) => item.recommendation === 'review-only')
      .reduce((sum, item) => sum + item.bytes, 0),
    entries,
  };
}
module.exports = { createBuildLease, inspectBuildCache };
