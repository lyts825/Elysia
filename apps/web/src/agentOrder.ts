/* 提供代理显示顺序相关的处理逻辑。 */
import type { Agent } from '../../../packages/contracts/src/index';

/**
 * 保持兄弟节点输入顺序并深度优先放在父代理之后，不修改原数组。
 * 父项缺失的记录作为根显示；最后再遍历未访问项，使损坏的无根环也完整保留且不会无限递归。
 */
export function agentOrder(agents: Agent[]): Agent[] {
  // 按输入顺序收集兄弟节点，再深度优先放置子代理；孤儿和环也必须保留。
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
