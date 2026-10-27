// 项目角色到模型配置的路由策略和决策契约。
import { z } from 'zod';
import type { ProviderConfig } from './index.js';

// @ cannot occur in a concrete ProviderConfig.id.
export const ROLE_ROUTING_PROVIDER = '@project-default';
export const RoutingRoles = ['worker', 'reviewer'] as const;
// 路由可独立指定执行和评审连接；null 表示对应角色尚未配置。
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
/** 内核实际解析路由后写入的来源记录，不能由模型输入冒充。 */
export interface RoleRoutingDecision {
  policyRevision: number;
  role: 'worker' | 'reviewer';
  providerId: string;
  model: string;
  reason: string;
}
/** 创建运行时冻结角色选择与连接；unavailable 保留当时不可用原因，不能自动换成新连接。 */
export interface RoleRoutingSnapshot {
  projectId: string;
  revision: number;
  policy: RoleRoutingPolicy;
  bindings: Partial<Record<'worker' | 'reviewer', ProviderConfig>>;
  unavailable?: Partial<Record<'worker' | 'reviewer', string>>;
}
