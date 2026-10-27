/**
 * 记录执行通道准备状态并协调并发准备。
 * 合并同通道并发准备并维护可用/失败状态，准备和单次执行分开；不自行领取任务或改变权限。
 * EN: Tracks channel preparation state and coordinates concurrent preparation. Coalesces channel preparation and tracks readiness/failure separately from execution, without claiming tasks or granting permissions.
 */
import type { ExecutionAdmission } from './execution-plugins.js';

type PreparationReason = 'execution-preparing' | 'execution-unavailable';

/**
 * 每个执行器独立保存准备状态，资源归属和全部派发策略仍由宿主管理。
 * EN: Per-executor preparation state. Resource ownership and all dispatch policy stay with the host.
 */
export class ExecutionAdmissions {
  private readonly states = new WeakMap<ExecutionAdmission, PreparationReason>();

  /**
   * 返回本执行器记录的准备状态；没有状态时返回 undefined。
   * EN: Returns preparation state recorded by this executor, or undefined when none exists.
   */
  reason(admission?: ExecutionAdmission): PreparationReason | undefined {
    return admission ? this.states.get(admission) : undefined;
  }

  /**
   * 并发准备本轮涉及的资源域。ready 在某个资源域成功后调用， failed 接收非取消错误；等待所有准备结束后才向调用者报告回调异常。
   * EN: Prepares the resource domains used by this round concurrently. ready runs when one domain succeeds; failed receives non-abort errors. Callback failures are reported only after every preparation settles.
   */
  async prepare(
    admissions: ReadonlySet<ExecutionAdmission>,
    signal: AbortSignal,
    ready: () => void,
    failed: (error: unknown) => void,
  ): Promise<void> {
    /**
     * 先标记全部资源域再开始异步准备，否则某个快速回调可能在其他域尚未标记时提前派发。
     * EN: Mark every resource domain before starting asynchronous work, otherwise a fast callback could dispatch before other domains are marked.
     */
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
    /**
     * 就绪/失败回调也可能抛错，必须等待全部资源域收束后再向宿主报告，避免关闭越过在途准备。
     * EN: Ready and failure callbacks may also throw. Drain every resource domain before reporting errors so shutdown cannot overtake preparation.
     */
    const errors = results.filter((result) => result.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        '执行通道准备回调失败',
      );
  }
}
