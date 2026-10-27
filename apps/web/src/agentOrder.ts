/**
 * 提供代理显示顺序相关的处理逻辑。
 * 把父子代理关系转换为稳定的父先子后显示顺序，保留孤立记录并防止环；不修改代理关系或推断缺失父级。
 * EN: Determines stable agent display order. Converts parent-child relations to stable parent-before-child display order, retaining orphan records and terminating cycles without modifying relations or inventing parents.
 */
import type { Agent } from '../../../packages/contracts/src/index';

/**
 * 保持兄弟节点输入顺序并深度优先放在父代理之后，不修改原数组。
 * 父项缺失的记录作为根显示；最后再遍历未访问项，使损坏的无根环也完整保留且不会无限递归。
 * EN: Keep input sibling order and place children depth-first after parents without mutating input. Orphans are roots; finally visit unvisited entries so rootless damaged cycles retain every record without infinite recursion.
 */
export function agentOrder(agents: Agent[]): Agent[] {
  /**
   * 按输入顺序收集兄弟节点，再深度优先放置子代理；孤儿和环也必须保留。
   * EN: Collect siblings in input order, then depth-first children; retain orphans/cycles too.
   */
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
  /**
   * 按父先子后的深度优先顺序加入代理；visited按对象防止损坏父链产生重复或递归环。
   * EN: Appends agents in parent-before-child depth-first order, using object visitation to prevent duplicates or cycles in damaged parent chains.
   */
  const visit = (agent: Agent) => {
    if (visited.has(agent)) return;
    visited.add(agent);
    ordered.push(agent);
    for (const child of children.get(agent.id) || []) visit(child);
  };
  for (const agent of agents) if (!agent.parentAgentId || !ids.has(agent.parentAgentId)) visit(agent);
  /**
   * 损坏父链可无根，仍需保留所有记录并终止环。
   * EN: A damaged parent chain may have no root; retain every record and terminate cycles.
   */
  for (const agent of agents) visit(agent);
  return ordered;
}
