// 管理计划对齐模块的加载与生命周期。
import { AppError, invariant, type Task } from '../../contracts/src/index.js';
import type { ToolDefinition } from '../../context/src/index.js';
import type { Kernel } from '../../kernel/src/index.js';
import { LazyPlugin } from '../../plugins/src/index.js';

export const PLAN_ALIGNMENT_MODULE = { id: 'plan-alignment', version: '1' } as const;

/** 仅向内置信任模块暴露内核的计划提出与接受入口。 */
export interface PlanAlignmentContext {
  propose: Kernel['propose'];
  accept: Kernel['accept'];
}
export interface PlanAlignmentModule {
  id: typeof PLAN_ALIGNMENT_MODULE.id;
  version: typeof PLAN_ALIGNMENT_MODULE.version;
  definition: ToolDefinition;
  /** 只做输入结构校验；合同权限与计划语义仍由内核验证。 */
  parse(input: unknown): { contract: unknown; plan: unknown };
  /** 提出候选合同与计划，结果仍需要用户接受。 */
  propose(task: Task, input: { contract: unknown; plan: unknown }): ReturnType<Kernel['propose']>;
  /** 通过注入的原内核入口接受计划，不能绕过版本和状态约束。 */
  accept(...args: Parameters<Kernel['accept']>): ReturnType<Kernel['accept']>;
  /** 停止实例并释放资源；关闭后任何公开动作应拒绝调用。 */
  dispose(): void | Promise<void>;
}
export interface PlanAlignmentFactory {
  id: typeof PLAN_ALIGNMENT_MODULE.id;
  version: typeof PLAN_ALIGNMENT_MODULE.version;
  apply(context: PlanAlignmentContext): PlanAlignmentModule;
}
export type PlanAlignmentLoader = () => Promise<PlanAlignmentFactory>;

/** 固定注册内置模块；每个网关按需加载一个实例，不从外部加载代码。 */
export class PlanAlignmentHost {
  private readonly plugin: LazyPlugin<PlanAlignmentContext, PlanAlignmentModule>;
  /**
   * 包装固定身份的惰性工厂；激活时交叉核对实例身份、版本和 propose_plan 贡献名。
   * context 只包含计划操作，loader 可由宿主注入而不是从用户配置加载任意外部代码。
   */
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
  /** 并发加载复用底层插件生命周期；关闭错误与可重试的加载失败分别报告。 */
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
  /** 释放已激活的模块，后续加载由插件生命周期拒绝。 */
  dispose(): Promise<void> {
    return this.plugin.dispose();
  }
}
