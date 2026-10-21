import { AppError, type Run, type Task } from '../../contracts/src/index.js';
import type { RuntimeQueueEntry, RuntimeQueueReason } from '../../contracts/src/terminal-runtime.js';
import { PluginRegistry, type PluginContributions } from '../../plugins/src/index.js';

export interface ExecutionDriver {
  step(task: Task, signal: AbortSignal): Promise<void>;
  interrupt?(runId: string, taskId?: string): Promise<void>;
  dispose?(): Promise<void>;
  admission?: {
    prepare(signal: AbortSignal): Promise<void>;
    unavailable(run: Run): RuntimeQueueReason | undefined;
    reason(task: Task, run: Run): RuntimeQueueReason | undefined;
    acquire(task: Task, run: Run): boolean;
    release(taskId: string): void;
  };
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
    this.drivers = [...new Set(this.registry.entries().map(([, driver]) => driver))];
  }
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
