// 项目角色到模型配置的路由策略和决策契约。
import { z } from 'zod';
import type { ProviderConfig } from './index.js';

// @ cannot occur in a concrete ProviderConfig.id.
export const ROLE_ROUTING_PROVIDER = '@project-default';
export const RoutingRoles = ['worker', 'reviewer'] as const;
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
export interface RoleRoutingDecision {
  policyRevision: number;
  role: 'worker' | 'reviewer';
  providerId: string;
  model: string;
  reason: string;
}
export interface RoleRoutingSnapshot {
  projectId: string;
  revision: number;
  policy: RoleRoutingPolicy;
  bindings: Partial<Record<'worker' | 'reviewer', ProviderConfig>>;
  unavailable?: Partial<Record<'worker' | 'reviewer', string>>;
}
