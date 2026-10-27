/** 启动并协调对象维护工作线程。 */
import { Worker } from 'node:worker_threads';
import { inspectObjectAudit } from './object-maintenance-audit.js';
export { inspectObjectAudit } from './object-maintenance-audit.js';
import type { Selection } from './maintenance-storage.js';
import {
  ObjectCleanupPlan,
  type ObjectMaintenanceProgress,
  type ObjectMaintenanceResult,
} from './object-maintenance.js';
import {
  OBJECT_CANCEL_FLAG,
  OBJECT_CLEANUP_GATE,
  OBJECT_READ_ONLY,
  OBJECT_TERMINATING,
  OBJECT_CANCEL_GRACE_MS,
} from './object-maintenance-control.js';

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
/** 在工作线程中执行对象清理计划或清理操作，支持取消及进度回调。 */
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
  const started = performance.now();
  const cancellation = new SharedArrayBuffer(8),
    flag = new Int32Array(cancellation);
  if (options.signal?.aborted) Atomics.store(flag, OBJECT_CANCEL_FLAG, 1);
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
    let response: ObjectWorkerResult | undefined;
    let workerErrored = false;
    let terminationRequested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let progress: ObjectMaintenanceProgress | undefined;
    const surfaces = new Set<NonNullable<ObjectMaintenanceProgress['surface']>>();
    const abort = () => {
      Atomics.store(flag, OBJECT_CANCEL_FLAG, 1);
      if (settled || response || timer) return;
      timer = setTimeout(() => {
        if (settled || response) return;
        // Winning this gate prevents cleanup from entering preflight. Losing it
        // means only cooperative cancellation is permitted from now on.
        if (
          Atomics.compareExchange(flag, OBJECT_CLEANUP_GATE, OBJECT_READ_ONLY, OBJECT_TERMINATING) !==
          OBJECT_READ_ONLY
        )
          return;
        terminationRequested = true;
        // Settlement still happens in 'exit', after the worker and its handles stop.
        void worker.terminate().catch(() => {});
      }, OBJECT_CANCEL_GRACE_MS);
    };
    const finish = (value: ObjectWorkerResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const stoppedBeforePreflight = (): ObjectWorkerResult => {
      const plan = input.action === 'cleanup' ? ObjectCleanupPlan.safeParse(input.plan) : undefined;
      const state: ObjectMaintenanceProgress = progress ?? {
        phase: 'integrity',
        recordsScanned: 0,
        filesChecked: 0,
        bytesHashed: 0,
        deleted: 0,
        freedBytes: 0,
        alreadyMissing: 0,
        totalCandidates: plan?.success
          ? plan.data.surfaces.reduce((sum, entry) => sum + entry.candidates.length, 0)
          : 0,
        elapsedMs: 0,
      };
      // The atomic gate proves that no candidate preflight or deletion began.
      // Progress is the last observed checkpoint; an interrupted audit stays incomplete.
      return {
        status: 'cancelled',
        errorCode: 'OBJECT_MAINTENANCE_CANCELLED',
        result: {
          ...state,
          elapsedMs: performance.now() - started,
          status: 'cancelled',
          errorCode: 'OBJECT_MAINTENANCE_CANCELLED',
          deleted: 0,
          freedBytes: 0,
          alreadyMissing: 0,
          remaining: state.totalCandidates,
          surfaces: [...surfaces],
        },
        ...(input.report ? { audit: inspectObjectAudit(input.report, input.plan) } : {}),
      };
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.on('message', (message) => {
      if (message?.type === 'progress') {
        progress = message.value;
        if (progress?.surface) surfaces.add(progress.surface);
        try {
          options.onProgress?.(message.value);
        } catch {
          abort();
        }
      }
      if (message?.type === 'done') {
        response = message.value;
        if (timer) clearTimeout(timer);
      }
    });
    worker.once('error', () => {
      workerErrored = true;
      response ??= { status: 'failed', errorCode: 'OBJECT_WORKER_EXITED' };
    });
    worker.once('exit', () => {
      finish(
        (response && workerErrored && input.report
          ? { ...response, audit: inspectObjectAudit(input.report, input.plan) }
          : response) ??
          (terminationRequested
            ? stoppedBeforePreflight()
            : {
                status: 'failed',
                errorCode: 'OBJECT_WORKER_EXITED',
                ...(input.report ? { audit: inspectObjectAudit(input.report, input.plan) } : {}),
              }),
      );
    });
  });
}
