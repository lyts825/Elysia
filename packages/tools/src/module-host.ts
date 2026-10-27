// 管理计划对齐模块的加载与生命周期。
import { AppError, invariant, type Task } from '../../contracts/src/index.js';
import type { ToolDefinition } from '../../context/src/index.js';
import type { Kernel } from '../../kernel/src/index.js';
import { LazyPlugin } from '../../plugins/src/index.js';

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
  private readonly plugin: LazyPlugin<PlanAlignmentContext, PlanAlignmentModule>;
  constructor(
    context: PlanAlignmentContext,
    loader: PlanAlignmentLoader = async () => (await import('./modules/plan-alignment.js')).default,
  ) {
    this.plugin = new LazyPlugin(
      { ...PLAN_ALIGNMENT_MODULE, apiVersion: 1 },
      context,
      async () => {
        const factory = await loader();
        return {
          manifest: { id: factory.id, version: factory.version, apiVersion: 1 },
          create: (context) => factory.apply(context),
        };
      },
      (instance) =>
        invariant(
          instance.id === PLAN_ALIGNMENT_MODULE.id &&
            instance.version === PLAN_ALIGNMENT_MODULE.version &&
            instance.definition.name === 'propose_plan',
          'MODULE_CONTRACT',
          '计划对齐模块贡献点无效',
        ),
    );
  }
  get loaded() {
    return this.plugin.loaded;
  }
  load(): Promise<PlanAlignmentModule> {
    return this.plugin.load().catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'PLUGIN_DISPOSED')
        throw new AppError('MODULE_DISPOSED', '计划对齐模块已释放');
      throw new AppError(
        'PLAN_MODULE_LOAD',
        '计划对齐模块加载失败，请重试：' + (error instanceof Error ? error.message : String(error)),
        true,
      );
    });
  }
  dispose(): Promise<void> {
    return this.plugin.dispose();
  }
}
