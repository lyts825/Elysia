import type { ExecutionAdmission } from './execution-plugins.js';

type PreparationReason = 'execution-preparing' | 'execution-unavailable';

/** Per-executor preparation state. Resource ownership and all dispatch policy stay with the host. */
export class ExecutionAdmissions {
  private readonly states = new WeakMap<ExecutionAdmission, PreparationReason>();

  reason(admission?: ExecutionAdmission): PreparationReason | undefined {
    return admission ? this.states.get(admission) : undefined;
  }

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
