import { parentPort, workerData } from 'node:worker_threads';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  createObjectCleanupPlan,
  executeObjectCleanup,
  ObjectMaintenanceFailure,
  type ObjectMaintenanceAudit,
  type ObjectMaintenanceProgress,
} from './object-maintenance.js';
import type { Selection } from './maintenance-storage.js';

const input = workerData as {
  directory: string;
  selection: Selection;
  action: 'plan' | 'cleanup';
  plan?: unknown;
  report?: string;
  cancellation: SharedArrayBuffer;
};
const cancellation = new Int32Array(input.cancellation);
let report: number | undefined;
const record = (value: unknown) => {
  if (report === undefined) return;
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(report, bytes, offset);
  fsyncSync(report);
};
let progress: ObjectMaintenanceProgress | undefined;
let response: unknown;
try {
  if (input.report) {
    report = openSync(input.report, 'wx', 0o600);
    record({
      type: 'started',
      format: 1,
      createdAt: new Date().toISOString(),
      planHash: createHash('sha256').update(JSON.stringify(input.plan)).digest('hex'),
    });
  }
  const options = {
    cancelled: () => Atomics.load(cancellation, 0) !== 0,
    onProgress: (value: ObjectMaintenanceProgress) => {
      progress = value;
      parentPort!.postMessage({ type: 'progress', value });
    },
    onAudit: (value: ObjectMaintenanceAudit) => record(value),
  };
  const value =
    input.action === 'plan'
      ? createObjectCleanupPlan(input.directory, input.selection, options)
      : executeObjectCleanup(input.directory, input.plan, input.selection, options);
  response = { status: 'completed', value, progress };
  record({ type: 'finished', status: 'completed', result: input.action === 'cleanup' ? value : undefined });
} catch (error) {
  const result = error instanceof ObjectMaintenanceFailure ? error.result : undefined;
  response = {
    status: result?.status ?? 'failed',
    result,
    errorCode: result?.errorCode ?? 'OBJECT_MAINTENANCE_FAILED',
    ...(result?.status === 'cancelled'
      ? {}
      : {
          failureReason: result?.failureReason ?? (input.report ? 'audit_write_failed' : 'worker_failed'),
        }),
    ...(error instanceof Error && error.message === '对象维护要求当前数据格式，请先执行 db:migrate'
      ? { guidance: error.message }
      : {}),
  };
  // Never persist parser excerpts or record contents in the audit file.
  try {
    record({ type: 'finished', ...(response as object) });
  } catch {}
} finally {
  if (report !== undefined) closeSync(report);
}
parentPort!.postMessage({ type: 'done', value: response });
parentPort!.close();
