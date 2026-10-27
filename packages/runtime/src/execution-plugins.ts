/**
 * 定义并管理运行时执行插件。
 * 校验清单和通道贡献并建立冻结注册表，重复/不兼容在装配时失败；注册不隐式启动调度或修改领域状态。
 * EN: Defines and manages runtime execution plugins. Validates manifests/contributions into a frozen registry, rejecting duplicates/incompatibility without implicitly scheduling or mutating domain state.
 */
import { AppError, type Run, type Task } from '../../contracts/src/index.js';
import type { RuntimeQueueEntry, RuntimeQueueReason } from '../../contracts/src/terminal-runtime.js';
import { PluginRegistry, type PluginContributions } from '../../plugins/src/index.js';

/**
 * 通道准备和资源预约由插件实现，调度顺序与任务领取仍由宿主控制。
 * EN: Plugins prepare channels and reserve resources; the host retains scheduling order and task claiming.
 */
export interface ExecutionAdmission {
  /**
   * 异步检查执行环境；关闭或取消时应响应 signal。
   * EN: Checks the execution environment asynchronously and must respond to the abort signal during cancellation or shutdown.
   */
  prepare(signal: AbortSignal): Promise<void>;
  /**
   * 返回运行级不可用原因；undefined 表示该检查未阻止运行。
   * EN: Returns a run-level unavailability reason; undefined means this check does not block the run.
   */
  unavailable(run: Run): RuntimeQueueReason | undefined;
  /**
   * 返回指定任务的排队原因；undefined 表示该检查未阻止派发。
   * EN: Returns a queue reason for the task; undefined means this check does not block dispatch.
   */
  reason(task: Task, run: Run): RuntimeQueueReason | undefined;
  /**
   * 原子尝试预约任务资源；失败时调度器不会启动任务。
   * EN: Attempts an atomic task resource reservation; the scheduler must not start a task when it fails.
   */
  acquire(task: Task, run: Run): boolean;
  /**
   * 释放指定任务的资源预约。
   * EN: Releases the resource reservation associated with the task.
   */
  release(taskId: string): void;
}

export interface ExecutionDriver {
  /**
   * 只执行宿主已经准入的单步；不得自行绕过内核领取或启动其他任务。
   * EN: Executes only a host-admitted step and must not bypass kernel claiming or start other tasks independently.
   */
  step(task: Task, signal: AbortSignal): Promise<void>;
  /**
   * 中断范围由运行与可选任务标识限定，必须等待可确认的停止动作结束。
   * EN: Limits interruption to a run and optional task and waits for the stop actions whose completion can be confirmed.
   */
  interrupt?(runId: string, taskId?: string): Promise<void>;
  dispose?(): Promise<void>;
  admission?: ExecutionAdmission;
  queueMetadata?(run: Run): Pick<RuntimeQueueEntry, 'resourcePreset'>;
}

export type ExecutionPlugin = PluginContributions<ExecutionDriver>;

/**
 * 注册在执行器构造时固定，调度和任务领取仍由宿主控制。
 * EN: Registration is fixed at executor construction; scheduling and claiming remain host-owned.
 */
export class ExecutionPlugins {
  private readonly registry: PluginRegistry<ExecutionDriver>;
  private readonly drivers: readonly ExecutionDriver[];
  private closing?: Promise<void>;
  /**
   * 一次性验证固定插件注册并按驱动实例去重，之后不支持运行时替换执行通道。
   * EN: Validates fixed plugin registrations once and deduplicates driver instances; channels cannot be replaced at runtime.
   */
  constructor(plugins: readonly ExecutionPlugin[]) {
    this.registry = new PluginRegistry(plugins);
    /**
     * 一个实例可能贡献多个通道键；中断和释放必须按实例去重，而不是按贡献键重复执行。
     * EN: One instance may contribute multiple channel keys. Deduplicate interruption and disposal by instance rather than invoking them once per key.
     */
    this.drivers = [...new Set(this.registry.entries().map(([, driver]) => driver))];
  }
  /**
   * 按运行冻结的通道类型选取驱动；旧运行缺省使用 native。
   * EN: Selects the driver from the channel type frozen on the run; legacy runs default to native.
   */
  forRun(run: Run) {
    const kind = run.execution?.kind ?? 'native';
    const driver = this.registry.get(kind);
    if (!driver)
      throw new AppError(
        kind === 'docker-agent' ? 'TERMINAL_UNAVAILABLE' : 'EXECUTION_PLUGIN_MISSING',
        `执行通道未注册：${kind}`,
      );
    return driver;
  }
  /**
   * 返回注册清单的只读描述，用于宿主检查贡献身份和版本，而不是授予运行执行权限。
   * EN: Returns read-only registration descriptions for host identity and version inspection, not execution authorization.
   */
  describe() {
    return this.registry.describe();
  }
  /**
   * 尝试中断每个不同驱动，全部收束后汇总失败，避免跳过其他驱动。
   * EN: Attempts interruption on every distinct driver and aggregates failures after all settle, so one failure does not skip other drivers.
   */
  async interrupt(runId: string, taskId?: string) {
    const results = await Promise.allSettled(
      this.drivers.map((driver) => Promise.resolve().then(() => driver.interrupt?.(runId, taskId))),
    );
    const errors = results.filter((result) => result.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        '执行插件停止失败',
      );
  }
  /**
   * 共享关闭 Promise，按逆序启动各驱动的释放并汇总异常。
   * EN: Shares one close promise, starts driver disposal in reverse order, and aggregates failures.
   */
  dispose() {
    return (this.closing ??= (async () => {
      const results = await Promise.allSettled(
        [...this.drivers].reverse().map((driver) => Promise.resolve().then(() => driver.dispose?.())),
      );
      const errors = results.filter((result) => result.status === 'rejected');
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          '执行插件释放失败',
        );
    })());
  }
}
