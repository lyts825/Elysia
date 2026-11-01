/**
 * 汇总内置工具插件并生成工具集合。
 * EN: Compose the fixed set of built-in tool plugins.
 *
 * 集中组合内置插件，保持注册顺序和能力来源明确；新增工具应通过插件契约加入，而非绕过统一执行入口。
 * EN: Compose built-in plugins with explicit order and capability origin; additions use plugin contracts and the shared execution entry.
 */
import { capabilities } from '../plugin-services.js';
import { PluginRegistry } from '../../../plugins/src/index.js';
import { invariant } from '../../../contracts/src/index.js';
import type { PlanAlignmentHost } from '../module-host.js';
import { PLAN_ALIGNMENT_MODULE } from '../module-host.js';
import type { ToolContribution, ToolServices, ToolInvocation } from '../tool-plugin.js';
import { collaborationTools } from './collaboration.js';
import { knowledgeTools } from './knowledge.js';
import { mcpTools } from './mcp.js';
import { networkTools } from './network.js';
import { workspaceTools } from './workspace.js';
import { backgroundJobTools } from './background-jobs.js';

/**
 * 组装固定的内置工具插件，并为各插件挑选所需能力。
 * 注册工具不等于授予任务权限；工具网关仍按任务和阶段生成可用清单。
 * EN: Build trusted tool plugins with selected capabilities. Registration alone does not grant
 * access; the gateway still derives availability from task and phase.
 */
export function builtinTools(context: ToolServices, plan: PlanAlignmentHost) {
  const registry = new PluginRegistry<ToolContribution>([
    backgroundJobTools(context.backgroundJobs),
    collaborationTools({
      store: capabilities(context.store, ['require']),
      kernel: capabilities(context.kernel, [
        'wait',
        'event',
        'spawn',
        'allocateContext',
        'submitPeerReview',
        'listChildren',
      ]),
      submit: context.submit,
      listArtifacts: context.listArtifacts,
    }),
    knowledgeTools({
      store: capabilities(context.store, ['require']),
      library: capabilities(context.library, [
        'listSkills',
        'loadSkill',
        'listLocalMemories',
        'loadSkillFile',
        'readLocalMemory',
        'listProjectMemories',
        'readProjectMemory',
        'recallContext',
      ]),
      catalogueBudget: context.catalogueBudget,
    }),
    mcpTools({
      store: capabilities(context.store, ['require']),
      kernel: capabilities(context.kernel, ['permissions']),
      library: capabilities(context.library, ['scopedLocalItems', 'readLocalMcpConfig']),
      catalogueBudget: context.catalogueBudget,
      mcp: context.mcp,
    }),
    networkTools(capabilities(context, ['fetch'])),
    workspaceTools({
      ...capabilities(context, [
        'store',
        'path',
        'snapshot',
        'artifact',
        'diff',
        'definitions',
        'processes',
        'runCommand',
      ]),
      kernel: capabilities(context.kernel, ['permissions', 'ancestors']),
    }),
    {
      manifest: { ...PLAN_ALIGNMENT_MODULE, apiVersion: 1 },
      contributions: {
        propose_plan: Object.freeze({
          name: 'propose_plan',
          policy: Object.freeze({ transaction: true, serial: true, mutating: false, progress: false }),
          /**
           * 复制已激活计划模块的工具定义，避免调用方修改模块共享定义。
           * EN: Clone the active plan module definition so callers cannot mutate its shared catalogue.
           */
          definition: () => structuredClone(plan.loaded!.definition),
          /**
           * 使用已加载模块解析参数，宿主调用前必须完成prepareDefinitions。
           * EN: Parse through the loaded module; callers must prepare definitions before invoking this contribution.
           */
          parse: (input: unknown) => plan.loaded!.parse(input),
          /**
           * 重读任务后提交计划提案，使执行使用当前持久状态。
           * EN: Reread the task before proposing a plan so execution uses current persisted state.
           */
          execute: (
            { task }: ToolInvocation,
            args: ReturnType<NonNullable<PlanAlignmentHost['loaded']>['parse']>,
          ) => plan.loaded!.propose(context.store.require('tasks', task.id), args),
        }),
      },
    },
  ]);
  // 事务工具必须串行，避免异步并发破坏事务边界。
  // EN: Transactional tools must execute serially to preserve transaction boundaries.
  for (const [name, tool] of registry.entries())
    invariant(
      tool.name === name && (!tool.policy.transaction || tool.policy.serial),
      'PLUGIN_CONTRACT',
      `工具插件声明不一致：${name}`,
    );
  return registry;
}
