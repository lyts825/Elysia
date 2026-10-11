import { Worker } from 'node:worker_threads';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
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

/** Bounded, conservative receipt recovery. An intent without completion is never called a rollback. */
export function inspectObjectAudit(filename: string) {
  try {
    if (!existsSync(filename)) return { available: false as const };
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      return { available: false as const };
    const pending = new Map<string, { surface: string; ref: string; bytes: number }>();
    let deleted = 0,
      freedBytes = 0,
      alreadyMissing = 0,
      incomplete = false;
    const lines = readFileSync(filename, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        incomplete = true;
        break;
      }
      if (entry.type === 'finished')
        return {
          available: true as const,
          deleted,
          freedBytes,
          alreadyMissing,
          unknownInFlight: [...pending.values()],
          incomplete,
          finished: true,
          status: ['completed', 'cancelled', 'failed'].includes(entry.status) ? entry.status : 'unknown',
        };
      if (!['delete-started', 'delete-completed', 'already-missing'].includes(entry.type)) continue;
      if (
        !['native', 'terminal'].includes(entry.surface) ||
        !/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(entry.ref) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0
      ) {
        incomplete = true;
        break;
      }
      const key = entry.surface + '/' + entry.ref;
      if (entry.type === 'delete-started')
        pending.set(key, { surface: entry.surface, ref: entry.ref, bytes: entry.bytes });
      else if (entry.type === 'delete-completed') {
        const started = pending.get(key);
        if (!started || started.bytes !== entry.bytes) {
          incomplete = true;
          break;
        }
        pending.delete(key);
        deleted++;
        freedBytes += entry.bytes;
      } else alreadyMissing++;
    }
    return {
      available: true as const,
      deleted,
      freedBytes,
      alreadyMissing,
      unknownInFlight: [...pending.values()],
      incomplete,
      finished: false,
    };
  } catch {
    return { available: false as const };
  }
}

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
        ...(input.report ? { audit: inspectObjectAudit(input.report) } : {}),
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
