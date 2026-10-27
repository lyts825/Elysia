/**
 * 定义对象维护工作线程使用的控制状态。 定义父线程/工作者共同使用的取消位和原子阶段门；只读阶段可强停，进入清理保护后只能协作取消。 取消与清理保护共享原子门，确保父线程不会， 终止已经进入对象预检或删除阶段的worker。 共享 Int32Array 的两个槽分别表示取消请求和清理阶段的原子门状态。
 * EN: Defines control state shared with object-maintenance workers. Defines shared parent/worker cancellation flags and atomic phase gates: read-only work may terminate, protected cleanup exits cooperatively. Cancellation and cleanup protection share an atomic gate, so the parent never terminates a worker that has started object preflight or deletion. Two shared Int32Array slots represent cancellation and the atomic cleanup-stage gate.
 */
export const OBJECT_CANCEL_FLAG = 0;
export const OBJECT_CLEANUP_GATE = 1;
export const OBJECT_READ_ONLY = 0;
/**
 * worker 进入删除预检前抢占保护门；父线程取得 TERMINATING 后 worker 只能观察取消退出。
 * EN: The worker claims protection before deletion preflight; once the parent obtains TERMINATING, the worker may only observe cancellation and exit.
 */
export const OBJECT_PROTECTED = 1;
export const OBJECT_TERMINATING = 2;
export const OBJECT_CANCEL_GRACE_MS = 50;
