/**
 * 管理计划对齐模块的加载与生命周期。
 * EN: Manage lazy loading and lifecycle of the built-in plan-alignment module.
 *
 * 首次使用时加载计划对齐实现，并共享加载结果；释放后阻止新调用，让可选能力具有明确的加载与销毁边界。
 * EN: Load plan-alignment implementation on first use and share the result, then block new calls after disposal to define its lifecycle boundary.
 */
import { AppError, invariant, type Task } from '../../contracts/src/index.js';
import type { ToolDefinition } from '../../context/src/index.js';
import type { Kernel } from '../../kernel/src/index.js';
import { LazyPlugin } from '../../plugins/src/index.js';

export const PLAN_ALIGNMENT_MODULE = { id: 'plan-alignment', version: '1' } as const;

/**
 * 仅向内置信任模块暴露内核的计划提出与接受入口。
 * EN: Expose only the existing kernel plan-proposal and acceptance entries to this trusted built-in
 * module.
 */
export interface PlanAlignmentContext {
  propose: Kernel['propose'];
  accept: Kernel['accept'];
}
export interface PlanAlignmentModule {
  id: typeof PLAN_ALIGNMENT_MODULE.id;
  version: typeof PLAN_ALIGNMENT_MODULE.version;
  definition: ToolDefinition;
  /**
   * 只做输入结构校验；合同权限与计划语义仍由内核验证。
   * EN: Validate input structure only; the kernel still enforces contract permissions and plan
   * semantics.
   */
  parse(input: unknown): { contract: unknown; plan: unknown };
  /**
   * 提出候选合同与计划，结果仍需要用户接受。
   * EN: Propose a candidate contract and plan that still require user acceptance.
   */
  propose(task: Task, input: { contract: unknown; plan: unknown }): ReturnType<Kernel['propose']>;
  /**
   * 通过注入的原内核入口接受计划，不能绕过版本和状态约束。
   * EN: Accept through the injected original kernel entry, retaining revision and state gates.
   */
  accept(...args: Parameters<Kernel['accept']>): ReturnType<Kernel['accept']>;
  /**
   * 停止实例并释放资源；关闭后任何公开动作应拒绝调用。
   * EN: Stop the instance and release resources; public actions must reject after disposal.
   */
  dispose(): void | Promise<void>;
}
export interface PlanAlignmentFactory {
  id: typeof PLAN_ALIGNMENT_MODULE.id;
  version: typeof PLAN_ALIGNMENT_MODULE.version;
  apply(context: PlanAlignmentContext): PlanAlignmentModule;
}
export type PlanAlignmentLoader = () => Promise<PlanAlignmentFactory>;

/**
 * 固定注册内置模块；每个网关按需加载一个实例，不从外部加载代码。
 * EN: Use fixed built-in registration and one lazily activated instance per gateway, without
 * external code loading.
 */
export class PlanAlignmentHost {
  private readonly plugin: LazyPlugin<PlanAlignmentContext, PlanAlignmentModule>;
  /**
   * 包装固定身份的惰性工厂；激活时交叉核对实例身份、版本和 propose_plan 贡献名。
   * context 只包含计划操作，loader 可由宿主注入而不是从用户配置加载任意外部代码。
   * EN: Wrap a fixed-identity lazy factory and validate instance identity, version, and the
   * propose_plan contribution during activation. context exposes plan operations only; loader is
   * host-injected rather than arbitrary user-configured code.
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
          /**
           * 用已加载工厂与最小上下文创建计划模块，实例契约随后由惰性宿主核验。
           * EN: Create the plan module from the loaded factory and minimal context; the lazy host then validates its contract.
           */
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
  /**
   * 只观察当前已激活实例，不在读取属性时触发模块加载。
   * EN: Observe the currently activated instance without triggering loading from this getter.
   */
  get loaded() {
    return this.plugin.loaded;
  }
  /**
   * 并发加载复用底层插件生命周期；关闭错误与可重试的加载失败分别报告。
   * EN: Share concurrent loads through the underlying plugin lifecycle and distinguish disposal from
   * retryable load failure.
   */
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
  /**
   * 释放已激活的模块，后续加载由插件生命周期拒绝。
   * EN: Dispose the active module; the plugin lifecycle rejects later loading.
   */
  dispose(): Promise<void> {
    return this.plugin.dispose();
  }
}
