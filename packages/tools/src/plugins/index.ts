// 汇总内置工具插件并生成工具集合。
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

/**
 * 组装固定的内置工具插件，并为各插件挑选所需能力。
 * 注册工具不等于授予任务权限；工具网关仍按任务和阶段生成可用清单。
 */
export function builtinTools(context: ToolServices, plan: PlanAlignmentHost) {
  const registry = new PluginRegistry<ToolContribution>([
    collaborationTools({
      store: capabilities(context.store, ['require']),
      kernel: capabilities(context.kernel, ['wait', 'event', 'spawn', 'allocateContext', 'submitPeerReview']),
      submit: context.submit,
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
          definition: () => structuredClone(plan.loaded!.definition),
          parse: (input: unknown) => plan.loaded!.parse(input),
          execute: (
            { task }: ToolInvocation,
            args: ReturnType<NonNullable<PlanAlignmentHost['loaded']>['parse']>,
          ) => plan.loaded!.propose(context.store.require('tasks', task.id), args),
        }),
      },
    },
  ]);
  // 事务工具必须串行，避免异步并发破坏事务边界。
  for (const [name, tool] of registry.entries())
    invariant(
      tool.name === name && (!tool.policy.transaction || tool.policy.serial),
      'PLUGIN_CONTRACT',
      `工具插件声明不一致：${name}`,
    );
  return registry;
}
