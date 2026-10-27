/**
 * 在工作线程中执行对象维护任务。
 * 连接共享取消协议、服务和父线程消息，审计逐条完整写入并 fsync；预检前原子进入保护门，避免删除与强停竞争。
 * EN: Executes object maintenance inside a worker thread. Connects cancellation/services/parent messaging with complete fsynced audit records and atomically protected preflight to avoid deletion/termination races.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { objectAuditHeader } from './object-maintenance-audit.js';
import {
  createObjectCleanupPlan,
  executeObjectCleanup,
  ObjectMaintenanceFailure,
  type ObjectMaintenanceAudit,
  type ObjectMaintenanceProgress,
} from './object-maintenance.js';
import type { Selection } from './maintenance-storage.js';
import {
  OBJECT_CANCEL_FLAG,
  OBJECT_CLEANUP_GATE,
  OBJECT_READ_ONLY,
  OBJECT_PROTECTED,
  OBJECT_TERMINATING,
} from './object-maintenance-control.js';

const input = workerData as {
  directory: string;
  selection: Selection;
  action: 'plan' | 'cleanup';
  plan?: unknown;
  report?: string;
  cancellation: SharedArrayBuffer;
};
/**
 * 父线程和工作线程通过共享内存协调取消，保护预检及删除期间的临界阶段。
 * EN: Parent and worker coordinate cancellation through shared memory, protecting preflight and deletion critical sections.
 */
const cancellation = new Int32Array(input.cancellation);
let report: number | undefined;
/**
 * 将一条审计 JSONL 全量写入并 fsync；未配置报告时跳过，写入失败必须阻止继续删除而非吞掉证据。
 * EN: Writes and fsyncs one complete audit JSONL record, skipping absent reports; write failure must stop deletion instead of losing evidence.
 */
const record = (value: unknown) => {
  /**
   * 每条 JSONL 都完整写入并 fsync，父进程异常退出后仍能区分删除开始、完成及未配对尾部。
   * EN: Writes and fsyncs complete JSONL records so a parent crash still leaves distinguishable deletion starts, completions, and unmatched tails.
   */
  if (report === undefined) return;
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(report, bytes, offset);
  fsyncSync(report);
};
let progress: ObjectMaintenanceProgress | undefined;
let response: unknown;
let preparingPlan = false;
try {
  if (input.report) {
    preparingPlan = true;
    const header = objectAuditHeader(input.plan);
    preparingPlan = false;
    report = openSync(input.report, 'wx', 0o600);
    record(header);
  }
  const options = {
    /**
     * 读取共享原子取消位，供扫描和删除检查点协作停止。
     * EN: Reads the shared atomic cancellation flag for scan/delete checkpoints.
     */
    cancelled: () => Atomics.load(cancellation, OBJECT_CANCEL_FLAG) !== 0,
    /**
     * 原子争取受保护清理门；若宿主已赢得强停门则设置取消，避免强停与删除同时开始。
     * EN: Atomically enters protected cleanup; if host termination already won, sets cancellation so forced stop and deletion cannot start together.
     */
    beforePreflight: () => {
      /**
       * 进入清理保护阶段前与取消操作原子竞争，避免清理途中被强制终止。
       * EN: Atomically competes with cancellation before entering protected cleanup, preventing forced termination during deletion.
       */
      if (
        Atomics.compareExchange(cancellation, OBJECT_CLEANUP_GATE, OBJECT_READ_ONLY, OBJECT_PROTECTED) ===
        OBJECT_TERMINATING
      )
        Atomics.store(cancellation, OBJECT_CANCEL_FLAG, 1);
    },
    /**
     * 保存最新进度并发送给父进程，仅传递结构化计数，不发送扫描正文。
     * EN: Retains latest progress and posts structured counters to the parent without scanned bodies.
     */
    onProgress: (value: ObjectMaintenanceProgress) => {
      progress = value;
      parentPort!.postMessage({ type: 'progress', value });
    },
    /**
     * 把清理审计事件委托给持久 JSONL 写入，写入错误继续上抛。
     * EN: Delegates cleanup audit events to durable JSONL recording and propagates write errors.
     */
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
          failureReason:
            result?.failureReason ??
            (preparingPlan ? 'plan_invalid' : input.report ? 'audit_write_failed' : 'worker_failed'),
        }),
    ...(error instanceof Error && error.message === '对象维护要求当前数据格式，请先执行 db:migrate'
      ? { guidance: error.message }
      : {}),
  };
  /**
   * 审计文件不持久化解析器摘录或记录正文。
   * EN: Never persist parser excerpts or record contents in the audit file.
   */
  try {
    record({ type: 'finished', ...(response as object) });
  } catch {}
} finally {
  if (report !== undefined) closeSync(report);
}
/**
 * done 先传安全结果，再关闭端口；父线程仍等 exit 后释放维护锁，避免文件句柄尚未收束。
 * EN: Sends a safe result before closing the port; the parent still waits for exit before releasing locks so open handles cannot outlive maintenance.
 */
parentPort!.postMessage({ type: 'done', value: response });
parentPort!.close();
