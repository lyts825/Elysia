/** 记录执行通道准备状态并协调并发准备。 */
import type { ExecutionAdmission } from './execution-plugins.js';

type PreparationReason = 'execution-preparing' | 'execution-unavailable';

/** Per-executor preparation state. Resource ownership and all dispatch policy stay with the host. */
export class ExecutionAdmissions {
  private readonly states = new WeakMap<ExecutionAdmission, PreparationReason>();

  /** 返回本执行器记录的准备状态；没有状态时返回 undefined。 */
  reason(admission?: ExecutionAdmission): PreparationReason | undefined {
    return admission ? this.states.get(admission) : undefined;
  }

  /**
   * 并发准备本轮涉及的资源域。ready 在某个资源域成功后调用，
   * failed 接收非取消错误；等待所有准备结束后才向调用者报告回调异常。
   */
  async prepare(
    admissions: ReadonlySet<ExecutionAdmission>,
    signal: AbortSignal,
    ready: () => void,
    failed: (error: unknown) => void,
  ): Promise<void> {
    // Mark the entire round before invoking a plugin or allowing any dispatch.
    for (const admission of admissions) this.states.set(admission, 'execution-preparing');
    const results = await Promise.allSettled(
      [...admissions].map(async (admission) => {
        if (signal.aborted) return;
        try {
          await admission.prepare(signal);
        } catch (error) {
          if (!signal.aborted) {
            this.states.set(admission, 'execution-unavailable');
            failed(error);
          }
          return;
        }
        if (signal.aborted) return;
        this.states.delete(admission);
        ready();
      }),
    );
    // A host callback failure must not let shutdown overtake other in-flight preparations.
    const errors = results.filter((result) => result.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        '执行通道准备回调失败',
      );
  }
}
