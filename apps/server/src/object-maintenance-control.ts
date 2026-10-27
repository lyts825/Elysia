/** 定义对象维护工作线程使用的控制状态。 */
// Cancellation and cleanup protection share an atomic gate, so the parent never
// terminates a worker that has started object preflight or deletion.
// 共享 Int32Array 的两个槽分别表示取消请求和清理阶段的原子门状态。
export const OBJECT_CANCEL_FLAG = 0;
export const OBJECT_CLEANUP_GATE = 1;
export const OBJECT_READ_ONLY = 0;
// worker 进入删除预检前抢占保护门；父线程取得 TERMINATING 后 worker 只能观察取消退出。
export const OBJECT_PROTECTED = 1;
export const OBJECT_TERMINATING = 2;
export const OBJECT_CANCEL_GRACE_MS = 50;
