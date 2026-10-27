/**
 * 启动并协调对象维护工作线程。
 * 隔离工作者执行扫描/清理，等待真实退出后结算；宽限后仅在原子只读门获胜时强停，不能从最后进度推测副作用。
 * EN: Starts and coordinates object-maintenance workers. Runs isolated scans/cleanup and settles after actual exit; forced termination requires winning the read-only gate, never inferring effects from last progress.
 */
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

/**
 * 调用者持有两个服务锁直到Promise收束，包括worker失败路径。 在 worker 中执行有界对象维护，调用方必须持有双方入口锁直到本 Promise 收束。 取消先通过共享内存协作；宽限期后只有仍处于只读阶段才能原子取得终止门并强制结束， 一旦进入删除预检就只允许协作取消，避免在文件删除与审计登记之间强杀。 最终结果在 worker exit 后返回，而非收到 done 消息即释放锁。
 * EN: The caller holds both service locks until this promise settles, including worker failure. Runs bounded object maintenance in a worker while callers hold both locks until settlement. Cancellation is cooperative first; after grace, forced termination requires atomically winning the read-only gate. Once preflight begins only cooperative cancellation is allowed, avoiding a kill between deletion and audit persistence. Results wait for worker exit, not merely done.
 */
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
    /**
     * 先设置共享协作取消标记，宽限期后仅在原子赢得只读门时强停工作者；已进入受保护清理时继续等待协作退出，避免删除中途被杀。
     * EN: Sets cooperative cancellation first. After grace, forcibly terminates only if it atomically wins the read-only gate; protected cleanup must exit cooperatively to avoid interruption during deletion.
     */
    const abort = () => {
      Atomics.store(flag, OBJECT_CANCEL_FLAG, 1);
      if (settled || response || timer) return;
      timer = setTimeout(() => {
        if (settled || response) return;
        /**
         * 赢得此门会阻止清理进入预检；若失败， 之后只能协作取消。
         * EN: Winning this gate prevents cleanup from entering preflight. Losing it means only cooperative cancellation is permitted from now on.
         */
        if (
          Atomics.compareExchange(flag, OBJECT_CLEANUP_GATE, OBJECT_READ_ONLY, OBJECT_TERMINATING) !==
          OBJECT_READ_ONLY
        )
          return;
        terminationRequested = true;
        /**
         * 仍在exit事件结算，确保worker及其句柄已停止。
         * EN: Settlement still happens in 'exit', after the worker and its handles stop.
         */
        void worker.terminate().catch(() => {});
      }, OBJECT_CANCEL_GRACE_MS);
    };
    /**
     * 只结算一次工作者结果，并清理取消监听和强停定时器。
     * EN: Settles the worker result once and removes cancellation listeners/termination timer.
     */
    const finish = (value: ObjectWorkerResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    /**
     * 在原子门证明尚未预检/删除时构造取消结果，将删除量置零但保留最后进度及不完整审计；不把观察到的进度当无副作用证明。
     * EN: Builds cancellation only when the atomic gate proves preflight/deletion never began, reporting zero deletions but retaining last progress/incomplete audit rather than inferring safety from progress.
     */
    const stoppedBeforePreflight = (): ObjectWorkerResult => {
      /**
       * 只有赢得只读阶段原子门才可证明删除数为零；不能从最后一条进度猜测未发生副作用。
       * EN: Only winning the read-only gate proves zero deletions; the last progress event cannot establish absence of side effects.
       */
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
      /**
       * 原子门证明尚未开始候选预检或删除。 进度只是最后观察到的检查点，中断审计仍不完整。
       * EN: The atomic gate proves that no candidate preflight or deletion began. Progress is the last observed checkpoint; an interrupted audit stays incomplete.
       */
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
