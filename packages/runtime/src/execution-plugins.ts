/** 定义并管理运行时执行插件。 */
import { AppError, type Run, type Task } from '../../contracts/src/index.js';
import type { RuntimeQueueEntry, RuntimeQueueReason } from '../../contracts/src/terminal-runtime.js';
import { PluginRegistry, type PluginContributions } from '../../plugins/src/index.js';

/** 通道准备和资源预约由插件实现，调度顺序与任务领取仍由宿主控制。 */
export interface ExecutionAdmission {
  /** 异步检查执行环境；关闭或取消时应响应 signal。 */
  prepare(signal: AbortSignal): Promise<void>;
  /** 返回运行级不可用原因；undefined 表示该检查未阻止运行。 */
  unavailable(run: Run): RuntimeQueueReason | undefined;
  /** 返回指定任务的排队原因；undefined 表示该检查未阻止派发。 */
  reason(task: Task, run: Run): RuntimeQueueReason | undefined;
  /** 原子尝试预约任务资源；失败时调度器不会启动任务。 */
  acquire(task: Task, run: Run): boolean;
  /** 释放指定任务的资源预约。 */
  release(taskId: string): void;
}

export interface ExecutionDriver {
  /** 只执行宿主已经准入的单步；不得自行绕过内核领取或启动其他任务。 */
  step(task: Task, signal: AbortSignal): Promise<void>;
  /** 中断范围由运行与可选任务标识限定，必须等待可确认的停止动作结束。 */
  interrupt?(runId: string, taskId?: string): Promise<void>;
  dispose?(): Promise<void>;
  admission?: ExecutionAdmission;
  queueMetadata?(run: Run): Pick<RuntimeQueueEntry, 'resourcePreset'>;
}

export type ExecutionPlugin = PluginContributions<ExecutionDriver>;

/** Registration is fixed at executor construction; scheduling and claiming remain host-owned. */
export class ExecutionPlugins {
  private readonly registry: PluginRegistry<ExecutionDriver>;
  private readonly drivers: readonly ExecutionDriver[];
  private closing?: Promise<void>;
  constructor(plugins: readonly ExecutionPlugin[]) {
    this.registry = new PluginRegistry(plugins);
    // 一个实例可能贡献多个通道键；中断和释放必须按实例去重，而不是按贡献键重复执行。
    this.drivers = [...new Set(this.registry.entries().map(([, driver]) => driver))];
  }
  /** 按运行冻结的通道类型选取驱动；旧运行缺省使用 native。 */
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
  describe() {
    return this.registry.describe();
  }
  /** 尝试中断每个不同驱动，全部收束后汇总失败，避免跳过其他驱动。 */
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
  /** 共享关闭 Promise，按逆序启动各驱动的释放并汇总异常。 */
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
