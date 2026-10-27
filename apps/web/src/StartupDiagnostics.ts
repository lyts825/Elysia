/**
 * 记录和读取应用启动阶段的诊断状态。
 * 采集启动阶段时间和结果并保留有界历史，区分当前启动与已有记录；诊断展示不代替应用就绪判定。
 * EN: Records and reads application startup diagnostics. Captures startup-stage timings/results with bounded history and separates the current launch from previous records; diagnostics do not replace readiness decisions.
 */
import './desktop';

export const startupStages = [
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
] as const;
export type StartupStage = (typeof startupStages)[number];
export type StartupStageStatus = 'ok' | 'error' | 'skipped';
export type StartupStageMark = {
  stage: StartupStage;
  elapsedMs: number;
  status: StartupStageStatus;
  surface?: 'native' | 'terminal';
};
export type StartupRecord = {
  id: string;
  startedAt: string;
  environment: 'desktop' | 'browser';
  build: 'cached' | 'rebuilt' | 'unknown';
  stages: StartupStageMark[];
};
export type StartupDiagnosticSnapshot = { version: 1; records: StartupRecord[] };
const storageKey = 'elysia:startup:diagnostics:v1';
const startedAt = performance.timeOrigin;
const current: StartupRecord = {
  id: crypto.randomUUID(),
  startedAt: new Date(startedAt).toISOString(),
  environment: 'browser',
  build: 'unknown',
  stages: [{ stage: 'launch-entry', elapsedMs: 0, status: 'ok' }],
};
let prior: StartupRecord[] | undefined;
const recorded = new Set<string>();

/**
 * 从不可信缓存筛选启动诊断记录，限制条数与阶段并验证时间范围，损坏输入返回空集合。
 * EN: Filters startup diagnostic records from untrusted cache, bounding record/stage counts and validating timing ranges; malformed input yields an empty collection.
 */
function cleanRecords(value: unknown): StartupRecord[] {
  /**
   * 限制记录与阶段数量，丢弃格式不合法或耗时越界的缓存项。
   * EN: Bound records/stages and discard malformed or out-of-range timing entries.
   */
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !/^[a-f0-9-]{36}$/i.test(item.id) ||
      typeof item.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(item.startedAt)) ||
      !['desktop', 'browser'].includes(item.environment) ||
      !['cached', 'rebuilt', 'unknown'].includes(item.build) ||
      !Array.isArray(item.stages)
    )
      return [];
    const stages = item.stages.slice(0, 32).flatMap((mark: Record<string, unknown>) =>
      startupStages.includes(mark?.stage as StartupStage) &&
      ['ok', 'error', 'skipped'].includes(mark.status as string) &&
      typeof mark.elapsedMs === 'number' &&
      Number.isFinite(mark.elapsedMs) &&
      mark.elapsedMs >= 0 &&
      mark.elapsedMs <= 1_800_000 &&
      (mark.surface === undefined || mark.surface === 'native' || mark.surface === 'terminal')
        ? [
            {
              stage: mark.stage as StartupStage,
              status: mark.status as StartupStageStatus,
              elapsedMs: Math.round(mark.elapsedMs * 10) / 10,
              ...(mark.surface ? { surface: mark.surface as 'native' | 'terminal' } : {}),
            },
          ]
        : [],
    );
    return [
      {
        id: item.id,
        startedAt: new Date(item.startedAt).toISOString(),
        environment: item.environment,
        build: item.build,
        stages,
      } as StartupRecord,
    ];
  });
}

/**
 * 惰性读取并清理浏览器历史诊断，排除当前记录；合并当前快照供设置页查看，存储失败回退为空历史。
 * EN: Lazily reads and sanitizes browser diagnostics, excluding the current record, then combines current state for settings inspection; storage failures fall back to empty history.
 */
function browserSnapshot(): StartupDiagnosticSnapshot {
  if (!prior) {
    try {
      const raw = localStorage.getItem(storageKey);
      prior =
        raw && raw.length <= 64 * 1024
          ? cleanRecords(JSON.parse(raw).records).filter((record) => record.id !== current.id)
          : [];
    } catch {
      prior = [];
    }
  }
  return { version: 1, records: [current, ...prior].slice(0, 20) };
}

/**
 * 尽力记录启动阶段，不阻塞认证、列表或动画。桌面使用主进程统一时基，浏览器保留本次
 * performance 耗时；同阶段/入口/结果只记一次，存储失败也不使用户动作失败。
 * EN: Best-effort startup timing never blocks auth/lists/animation. Desktop uses main-process timebase; browser uses this performance timeline. Deduplicate stage/surface/result, and do not fail user actions on storage error.
 */
export function markStartupStage(
  stage: StartupStage,
  options: { surface?: 'native' | 'terminal'; status?: StartupStageStatus } = {},
) {
  /**
   * 同一阶段、入口与结果只记一次；桌面桥可用时由主进程保存，否则使用浏览器存储。
   * EN: Record one stage/surface/result; use main-process bridge when available, otherwise browser storage.
   */
  const status = options.status || 'ok',
    key = `${stage}:${options.surface || ''}:${status}`;
  if (
    !startupStages.includes(stage) ||
    !['ok', 'error', 'skipped'].includes(status) ||
    (options.surface !== undefined && options.surface !== 'native' && options.surface !== 'terminal') ||
    recorded.has(key)
  )
    return;
  recorded.add(key);
  if (window.elysia?.markStartupStage) {
    void window.elysia
      .markStartupStage({
        stage,
        status,
        ...(options.surface ? { surface: options.surface } : {}),
        atEpoch: performance.timeOrigin + performance.now(),
      })
      .catch(() => {});
    return;
  }
  if (current.stages.length >= 32) return;
  current.stages.push({
    stage,
    status,
    elapsedMs: Math.round(performance.now() * 10) / 10,
    ...(options.surface ? { surface: options.surface } : {}),
  });
  try {
    const snapshot = browserSnapshot();
    let raw = JSON.stringify(snapshot);
    while (raw.length > 64 * 1024 && snapshot.records.length > 1) {
      snapshot.records.pop();
      raw = JSON.stringify(snapshot);
    }
    localStorage.setItem(storageKey, raw);
  } catch {
    /**
     * 计时写入失败不能使用户操作失败。
     * EN: A timing write must not fail a user action.
     */
  }
}

/**
 * 桌面诊断也经本地校验清洗后返回；浏览器从有界历史中构造同一格式快照。
 * EN: Validate/clean desktop diagnostics locally too; browser constructs the same bounded snapshot format.
 */
export async function readStartupDiagnostics(): Promise<StartupDiagnosticSnapshot> {
  if (window.elysia?.readStartupDiagnostics) {
    const snapshot = await window.elysia.readStartupDiagnostics();
    return { version: 1, records: cleanRecords(snapshot.records) };
  }
  return browserSnapshot();
}
