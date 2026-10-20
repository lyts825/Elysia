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

/** Fixed composition; a new tool still needs an explicit grant in the gateway's policy. */
export function builtinTools(context: ToolServices, plan: PlanAlignmentHost) {
  const registry = new PluginRegistry<ToolContribution>([
    collaborationTools(context),
    knowledgeTools(context),
    mcpTools(context),
    networkTools(context),
    workspaceTools(context),
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
  for (const [name, tool] of registry.entries())
    invariant(
      tool.name === name && (!tool.policy.transaction || tool.policy.serial),
      'PLUGIN_CONTRACT',
      `工具插件声明不一致：${name}`,
    );
  return registry;
}
