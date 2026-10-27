/**
 * 项目角色到模型配置的路由策略和决策契约。
 * 策略标记、冻结绑定与内核来源记录分别保存，显式选择不能被角色路由覆盖。
 *
 * EN: Defines routing policies and decisions from project roles to model configurations.
 * Separates policy markers, frozen bindings, and kernel provenance; role routing cannot override explicit choices.
 */
import { z } from 'zod';
import type { ProviderConfig } from './index.js';

/**
 * 具体 ProviderConfig.id 中不可能出现 @。
 *
 * EN: @ cannot occur in a concrete ProviderConfig.id.
 */
export const ROLE_ROUTING_PROVIDER = '@project-default';
export const RoutingRoles = ['worker', 'reviewer'] as const;
/**
 * 路由可独立指定执行和评审连接；null 表示对应角色尚未配置。
 *
 * EN: Execution and review connections can be configured independently; null means the role is unconfigured.
 */
export const RoleRoutingPolicy = z
  .object({
    enabled: z.boolean(),
    worker: z.string().min(1).max(160).nullable(),
    reviewer: z.string().min(1).max(160).nullable(),
  })
  .strict();
export type RoleRoutingPolicy = z.infer<typeof RoleRoutingPolicy>;
export interface RoleRoutingView {
  projectId: string;
  revision: number;
  policy: RoleRoutingPolicy;
  providers: {
    id: string;
    label: string;
    model: string;
    contextLimit: number;
    verified: boolean;
    priceKnown: boolean;
    currency: string | null;
  }[];
}
/**
 * 内核实际解析路由后写入的来源记录，不能由模型输入冒充。
 *
 * EN: Provenance written after the kernel actually resolves a route; model input cannot impersonate it.
 */
export interface RoleRoutingDecision {
  policyRevision: number;
  role: 'worker' | 'reviewer';
  providerId: string;
  model: string;
  reason: string;
}
/**
 * 创建运行时冻结角色选择与连接；unavailable 保留当时不可用原因，不能自动换成新连接。
 *
 * EN: Role choices and connections are frozen at run creation; unavailable preserves the original failure reason and never silently selects a new connection.
 */
export interface RoleRoutingSnapshot {
  projectId: string;
  revision: number;
  policy: RoleRoutingPolicy;
  bindings: Partial<Record<'worker' | 'reviewer', ProviderConfig>>;
  unavailable?: Partial<Record<'worker' | 'reviewer', string>>;
}
