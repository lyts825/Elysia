import { Worker } from 'node:worker_threads';
import { inspectObjectAudit } from './object-maintenance-audit.js';
export { inspectObjectAudit } from './object-maintenance-audit.js';
import type { Selection } from './maintenance-storage.js';
import type { ObjectMaintenanceProgress, ObjectMaintenanceResult } from './object-maintenance.js';

export type ObjectWorkerResult = {
  status: 'completed' | 'cancelled' | 'failed';
  value?: unknown;
  progress?: ObjectMaintenanceProgress;
  result?: ObjectMaintenanceResult;
  errorCode?: string;
  guidance?: string;
  failureReason?: string;
  audit?: ReturnType<typeof inspectObjectAudit>;
};

// The caller holds both service locks until this promise settles, including worker failure.
export function runObjectMaintenance(
  input: {
    directory: string;
    selection: Selection;
    action: 'plan' | 'cleanup';
    plan?: unknown;
    report?: string;
  },
  options: { signal?: AbortSignal; onProgress?: (value: ObjectMaintenanceProgress) => void } = {},
): Promise<ObjectWorkerResult> {
  const cancellation = new SharedArrayBuffer(4),
    flag = new Int32Array(cancellation);
  const abort = () => Atomics.store(flag, 0, 1);
  if (options.signal?.aborted) abort();
  const worker = new Worker(
    new URL(
      import.meta.url.endsWith('.ts') ? './object-maintenance-worker.ts' : './object-maintenance-worker.js',
      import.meta.url,
    ),
    {
      workerData: { ...input, cancellation },
    },
  );
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ObjectWorkerResult) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const failed = () =>
      finish({
        status: 'failed',
        errorCode: 'OBJECT_WORKER_EXITED',
        ...(input.report ? { audit: inspectObjectAudit(input.report, input.plan) } : {}),
      });
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', (message) => {
      if (message?.type === 'progress') {
        try {
          options.onProgress?.(message.value);
        } catch {
          abort();
        }
      }
      if (message?.type === 'done') finish(message.value);
    });
    worker.once('error', failed);
    worker.once('exit', () => {
      if (!settled) failed();
    });
  });
}
