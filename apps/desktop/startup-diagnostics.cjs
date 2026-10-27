/**
 * 记录和读取桌面启动阶段诊断信息。
 * EN: Record and read diagnostic information for desktop startup stages.
 *
 * 把启动阶段转换为有界诊断记录，保留可供设置页读取的信息；诊断写入不能替代真实启动完成判断。
 * EN: Maintain bounded startup-stage records for the settings view; diagnostic writes do not themselves establish startup completion.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { readBounded } = require('./startup.cjs');
const stages = [
  'launch-entry',
  'dependencies-ready',
  'fingerprint-ready',
  'build-ready',
  'window-visible',
  'backend-ready',
  'web-loaded',
  'preferences-ready',
  'auth-ready',
  'lists-ready',
  'messages-ready',
  'media-ready',
];
const statuses = ['ok', 'skipped', 'error'];
const LIMIT = 64 * 1024;
/**
 * 只保留允许的阶段、状态和有界耗时，忽略无效输入。
 * EN: Keep only recognized stages, statuses, and bounded elapsed times; discard invalid input.
 */
function cleanStage(value) {
  if (
    !value ||
    !stages.includes(value.stage) ||
    !statuses.includes(value.status) ||
    typeof value.elapsedMs !== 'number' ||
    !Number.isFinite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 1800000 ||
    (value.surface !== undefined && !['native', 'terminal'].includes(value.surface))
  )
    return null;
  return {
    stage: value.stage,
    status: value.status,
    elapsedMs: Math.round(value.elapsedMs * 10) / 10,
    ...(value.surface ? { surface: value.surface } : {}),
  };
}
/**
 * 校验历史记录并限制阶段数，不直接信任磁盘上的 JSON。
 * EN: Validate persisted records and limit their stage count instead of trusting on-disk JSON.
 */
function cleanRecord(value) {
  if (
    !value ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !['desktop', 'browser'].includes(value.environment) ||
    !['cached', 'rebuilt', 'unknown'].includes(value.build) ||
    !Array.isArray(value.stages)
  )
    return null;
  return {
    id: value.id,
    startedAt: new Date(value.startedAt).toISOString(),
    environment: value.environment,
    build: value.build,
    stages: value.stages.slice(0, 32).map(cleanStage).filter(Boolean),
  };
}
/**
 * 汇总本次启动阶段与最多 20 条历史记录。写入串行执行并通过临时文件替换，
 * renderer 上报的时间转换为相对启动耗时；异常诊断数据不会阻止应用启动。
 * EN: Combine this startup with at most twenty retained records. Serialize writes through
 * temporary-file replacement and convert renderer timestamps into startup-relative durations.
 * Invalid diagnostic data must not block startup.
 */
function createStartupDiagnostics(directory, options = {}) {
  const now = performance.timeOrigin + performance.now();
  const requested = Number(options.startedAt);
  const started =
    Number.isFinite(requested) && requested <= now && now - requested <= 1800000 ? requested : now;
  const current = {
    id: /^[a-f0-9-]{36}$/.test(options.id) ? options.id : randomUUID(),
    startedAt: new Date(started).toISOString(),
    environment: 'desktop',
    build: ['cached', 'rebuilt'].includes(options.build) ? options.build : 'unknown',
    stages: [],
  };
  const keys = new Set();
  const file = path.join(directory, 'desktop', 'startup-diagnostics.json');
  let prior = [],
    writing = Promise.resolve();
  const loaded = (async () => {
    try {
      const saved = JSON.parse((await readBounded(file, LIMIT)).toString('utf8'));
      if (saved.version === 1 && Array.isArray(saved.records))
        prior = saved.records
          .slice(0, 20)
          .map(cleanRecord)
          .filter(Boolean)
          .filter((record) => record.id !== current.id);
    } catch {}
  })();
  /**
   * 返回本次记录与旧历史的有界快照，不等待写盘。
   * EN: Return a bounded snapshot of current and prior records without waiting for persistence.
   */
  const snapshot = () => ({ version: 1, records: [cleanRecord(current), ...prior].slice(0, 20) });
  /**
   * 将持久化排到前次写入之后，历史加载完成后再取快照；总大小超限时先丢弃最旧记录。
   * 写入错误被观察但不阻塞启动，下一次阶段记录仍可排入队列重试保存。
   * EN: Queue persistence after the previous write and load history before taking a snapshot. Drop the
   * oldest records first when the size limit is exceeded. Observe write failures without blocking
   * startup, and let later stages attempt persistence again.
   */
  function schedule() {
    writing = writing
      .catch(() => {})
      .then(async () => {
        await loaded;
        let value = snapshot(),
          json = JSON.stringify(value);
        while (Buffer.byteLength(json) > LIMIT && value.records.length > 1) {
          value.records.pop();
          json = JSON.stringify(value);
        }
        const parent = path.dirname(file);
        await fs.mkdir(parent, { recursive: true });
        const stat = await fs.lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
          await fs.writeFile(temporary, json, { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, file);
        } finally {
          await fs.unlink(temporary).catch(() => {});
        }
      });
    writing.catch(() => {});
  }
  // 同一阶段、入口和状态组合只记录一次，限制单次启动的记录数量。
  // EN: Record each stage/surface/status combination once and bound the number of stages for one
  // startup.
  function record(value) {
    const normalized = cleanStage(value);
    if (!normalized) return false;
    const key = normalized.stage + ':' + (normalized.surface || '') + ':' + normalized.status;
    if (keys.has(key) || current.stages.length >= 32) return false;
    keys.add(key);
    current.stages.push(normalized);
    schedule();
    return true;
  }
  record({ stage: 'launch-entry', status: 'ok', elapsedMs: 0 });
  if (Array.isArray(options.marks)) for (const mark of options.marks.slice(0, 12)) record(mark);
  return {
    /**
     * 主进程阶段用同一时钟计算相对耗时，返回是否实际加入了新记录。
     * EN: Measure main-process stages with the same clock and return whether a new record was added.
     */
    mark(stage, status = 'ok') {
      return record({ stage, status, elapsedMs: performance.timeOrigin + performance.now() - started });
    },
    /**
     * 接收页面的绝对高精度时间，拒绝明显超前的值，再转换为本次启动相对时间。
     * EN: Accept renderer absolute high-resolution timestamps, reject clearly future values, and convert
     * them to elapsed startup time.
     */
    recordFromRenderer(value) {
      if (
        !value ||
        typeof value.atEpoch !== 'number' ||
        !Number.isFinite(value.atEpoch) ||
        value.atEpoch > performance.timeOrigin + performance.now() + 1000
      )
        return false;
      return record({
        stage: value.stage,
        surface: value.surface,
        status: value.status,
        elapsedMs: value.atEpoch - started,
      });
    },
    /**
     * 等待历史文件加载后返回内存快照，不要求此前每个阶段写入都已落盘。
     * EN: Wait for history loading and return the in-memory snapshot; earlier scheduled writes need not
     * have reached disk yet.
     */
    async read() {
      await loaded;
      return snapshot();
    },
    /**
     * 关闭前尽力等待当前写队列；诊断失败不作为应用无法退出的理由。
     * EN: Attempt to drain the current write queue before closing; diagnostic failure must not prevent
     * application exit.
     */
    async flush() {
      await writing.catch(() => {});
    },
  };
}
module.exports = { createStartupDiagnostics, cleanStage, cleanRecord, stages };
