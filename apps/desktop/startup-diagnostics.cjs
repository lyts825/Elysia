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
  const snapshot = () => ({ version: 1, records: [cleanRecord(current), ...prior].slice(0, 20) });
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
    mark(stage, status = 'ok') {
      return record({ stage, status, elapsedMs: performance.timeOrigin + performance.now() - started });
    },
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
    async read() {
      await loaded;
      return snapshot();
    },
    async flush() {
      await writing.catch(() => {});
    },
  };
}
module.exports = { createStartupDiagnostics, cleanStage, cleanRecord, stages };
