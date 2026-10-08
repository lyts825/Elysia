import { AppError, invariant, type Task } from '../../contracts/src/index.js';
import type { ToolDefinition } from '../../context/src/index.js';
import type { Kernel } from '../../kernel/src/index.js';

export const PLAN_ALIGNMENT_MODULE = { id: 'plan-alignment', version: '1' } as const;

/** Only the existing kernel entry points are exposed to this trusted built-in module. */
export interface PlanAlignmentContext {
  propose: Kernel['propose'];
  accept: Kernel['accept'];
}
export interface PlanAlignmentModule {
  id: typeof PLAN_ALIGNMENT_MODULE.id;
  version: typeof PLAN_ALIGNMENT_MODULE.version;
  definition: ToolDefinition;
  parse(input: unknown): { contract: unknown; plan: unknown };
  propose(task: Task, input: { contract: unknown; plan: unknown }): ReturnType<Kernel['propose']>;
  accept(...args: Parameters<Kernel['accept']>): ReturnType<Kernel['accept']>;
  dispose(): void | Promise<void>;
}
export interface PlanAlignmentFactory {
  id: typeof PLAN_ALIGNMENT_MODULE.id;
  version: typeof PLAN_ALIGNMENT_MODULE.version;
  apply(context: PlanAlignmentContext): PlanAlignmentModule;
}
export type PlanAlignmentLoader = () => Promise<PlanAlignmentFactory>;

/** Fixed registration, lazy activation and one instance per gateway; no external code loading. */
export class PlanAlignmentHost {
  private instance?: PlanAlignmentModule;
  private pending?: Promise<PlanAlignmentModule>;
  private closing?: Promise<void>;
  private closed = false;
  constructor(
    private context: PlanAlignmentContext,
    private loader: PlanAlignmentLoader = async () => (await import('./modules/plan-alignment.js')).default,
  ) {}
  get loaded() {
    return this.instance;
  }
  load(): Promise<PlanAlignmentModule> {
    if (this.closed) return Promise.reject(new AppError('MODULE_DISPOSED', '计划对齐模块已释放'));
    if (this.instance) return Promise.resolve(this.instance);
    if (this.pending) return this.pending;
    const pending = (async () => {
      try {
        const factory = await this.loader();
        invariant(!this.closed, 'MODULE_DISPOSED', '计划对齐模块已释放');
        invariant(
          factory.id === PLAN_ALIGNMENT_MODULE.id && factory.version === PLAN_ALIGNMENT_MODULE.version,
          'MODULE_CONTRACT',
          '计划对齐模块契约版本不匹配',
        );
        const instance = factory.apply(this.context);
        if (
          instance.id !== factory.id ||
          instance.version !== factory.version ||
          instance.definition.name !== 'propose_plan'
        ) {
          await instance.dispose();
          throw new AppError('MODULE_CONTRACT', '计划对齐模块贡献点无效');
        }
        if (this.closed) {
          await instance.dispose();
          throw new AppError('MODULE_DISPOSED', '计划对齐模块已释放');
        }
        this.instance = instance;
        return instance;
      } catch (error) {
        if (error instanceof AppError && error.code === 'MODULE_DISPOSED') throw error;
        throw new AppError(
          'PLAN_MODULE_LOAD',
          '计划对齐模块加载失败，请重试：' + (error instanceof Error ? error.message : String(error)),
          true,
        );
      }
    })();
    this.pending = pending;
    const settled = () => {
      if (this.pending === pending) this.pending = undefined;
    };
    void pending.then(settled, settled);
    return pending;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      try {
        await this.pending;
      } catch {
        // A load cancelled by shutdown must not leave an activated contribution.
      }
      const instance = this.instance;
      this.instance = undefined;
      await instance?.dispose();
    })();
    return this.closing;
  }
}
