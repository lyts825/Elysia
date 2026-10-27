/* 记录和读取应用启动阶段的诊断状态。 */
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

function cleanRecords(value: unknown): StartupRecord[] {
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

// Timing is best effort and never blocks authentication, lists, or animation playback.
export function markStartupStage(
  stage: StartupStage,
  options: { surface?: 'native' | 'terminal'; status?: StartupStageStatus } = {},
) {
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
    /* A timing write must not fail a user action. */
  }
}

export async function readStartupDiagnostics(): Promise<StartupDiagnosticSnapshot> {
  if (window.elysia?.readStartupDiagnostics) {
    const snapshot = await window.elysia.readStartupDiagnostics();
    return { version: 1, records: cleanRecords(snapshot.records) };
  }
  return browserSnapshot();
}
