/* 提供代理显示顺序相关的处理逻辑。 */
import type { Agent } from '../../../packages/contracts/src/index';

/** Keep siblings in their creation order while placing each child after its own parent. */
export function agentOrder(agents: Agent[]): Agent[] {
  const ids = new Set(agents.map((agent) => agent.id));
  const children = new Map<string, Agent[]>();
  for (const agent of agents) {
    if (!agent.parentAgentId) continue;
    const siblings = children.get(agent.parentAgentId) || [];
    siblings.push(agent);
    children.set(agent.parentAgentId, siblings);
  }
  const ordered: Agent[] = [];
  const visited = new Set<Agent>();
  const visit = (agent: Agent) => {
    if (visited.has(agent)) return;
    visited.add(agent);
    ordered.push(agent);
    for (const child of children.get(agent.id) || []) visit(child);
  };
  for (const agent of agents) if (!agent.parentAgentId || !ids.has(agent.parentAgentId)) visit(agent);
  // A damaged parent chain may have no root; retain every record and terminate cycles.
  for (const agent of agents) visit(agent);
  return ordered;
}
