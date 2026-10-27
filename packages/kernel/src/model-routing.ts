// 解析并冻结项目角色的模型路由选择。
import { AppError, invariant, type ProviderConfig, type Run } from '../../contracts/src/index.js';
import {
  ROLE_ROUTING_PROVIDER,
  RoleRoutingPolicy,
  type RoleRoutingDecision,
  type RoleRoutingSnapshot,
} from '../../contracts/src/model-routing.js';
import { stable } from '../../contracts/src/identity.js';
import type { KernelStore as Store } from './ports.js';

export interface RoleRoutingRecord {
  projectId: string;
  revision: number;
  policy: RoleRoutingPolicy;
}
export const routingKey = (projectId: string) => 'project-model-routing:v1:' + projectId;
/** 读取持久化策略；无记录时使用关闭状态，损坏记录则明确拒绝。 */
export function readRoleRouting(store: Store, projectId: string): RoleRoutingRecord {
  const value = store.metadata(routingKey(projectId));
  if (value === undefined)
    return { projectId, revision: 0, policy: { enabled: false, worker: null, reviewer: null } };
  try {
    const record = JSON.parse(value) as RoleRoutingRecord;
    invariant(
      record.projectId === projectId && Number.isSafeInteger(record.revision) && record.revision > 0,
      'ROUTING_INVALID',
      '角色路由记录损坏',
    );
    return { ...record, policy: RoleRoutingPolicy.parse(record.policy) };
  } catch {
    throw new AppError('ROUTING_INVALID', '角色路由记录损坏，请恢复备份', false, null, 409);
  }
}
export function routingProvider(store: Store, providerId: string) {
  // 只接受当前修订已验证、且尚未归档的连接。
  const binding = store.require<ProviderConfig>('providers', providerId);
  invariant(
    !binding.archived && binding.checkedRevision === binding.revision,
    'ROUTING_PROVIDER',
    '角色路由连接已失效，请重新验证或选择模型',
  );
  return binding;
}
/** 按创建任务时的策略冻结角色连接；不可用角色记录原因，不自动换用其他连接。 */
export function freezeRoleRouting(store: Store, projectId: string): RoleRoutingSnapshot {
  const record = readRoleRouting(store, projectId);
  const bindings: RoleRoutingSnapshot['bindings'] = {};
  const unavailable: NonNullable<RoleRoutingSnapshot['unavailable']> = {};
  if (record.policy.enabled)
    for (const role of ['worker', 'reviewer'] as const) {
      const providerId = record.policy[role];
      if (providerId) {
        const current = store.get<ProviderConfig>('providers', providerId);
        if (current && !current.archived && current.checkedRevision === current.revision)
          bindings[role] = structuredClone(current);
        else unavailable[role] = '任务创建时角色连接不存在、已归档或尚未验证，请显式选择模型';
      }
    }
  return { ...record, bindings, unavailable };
}
/** 仅处理角色路由标记；显式模型选择保持原样。 */
export function routeTask(store: Store, run: Run, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { raw };
  const spec = raw as Record<string, unknown>;
  if (spec.providerId !== ROLE_ROUTING_PROVIDER) return { raw };
  const policy = run.modelRouting;
  const role = spec.role ?? 'worker';
  invariant(role === 'worker' || role === 'reviewer', 'ROUTING_ROLE', '项目角色路由仅用于执行和复核子任务');
  invariant(policy?.policy.enabled, 'ROUTING_DISABLED', '当前任务创建时未启用项目角色路由，请显式选择模型');
  const binding = policy.bindings[role];
  invariant(
    binding,
    'ROUTING_UNASSIGNED',
    policy.unavailable?.[role] ?? '当前任务未冻结此角色的模型，请显式选择模型',
  );
  const current = routingProvider(store, binding.id);
  // 连接在冻结之后变化时不能悄悄改用新配置。
  invariant(
    current.revision === binding.revision,
    'ROUTING_CHANGED',
    '路由连接在任务创建后已改变，请显式选择并核对新模型',
  );
  invariant(
    spec.model === undefined && spec.reasoningEffort === undefined,
    'ROUTING_OVERRIDE',
    '按项目角色选择时不要另外指定型号或思考强度',
  );
  const decision: RoleRoutingDecision = {
    policyRevision: policy.revision,
    role,
    providerId: binding.id,
    model: binding.model,
    reason: `使用任务创建时冻结的项目${role === 'worker' ? '执行' : '复核'}模型；显式模型选择优先，累计预算保持`,
  };
  return {
    raw: { ...spec, providerId: binding.id, model: binding.model, reasoningEffort: binding.reasoningEffort },
    binding,
    decision,
  };
}
/** 按期望修订保存；冲突时由调用方重新读取并核对输入。 */
export function saveRoleRouting(store: Store, projectId: string, expectedRevision: number, raw: unknown) {
  const policy = RoleRoutingPolicy.parse(raw);
  const current = readRoleRouting(store, projectId);
  if (current.revision !== expectedRevision)
    throw new AppError('REVISION_CONFLICT', '角色路由已更新，请重新读取后核对当前输入', false, null, 409);
  if (policy.enabled) {
    invariant(policy.worker || policy.reviewer, 'ROUTING_EMPTY', '启用路由至少需要选择一个角色模型');
    for (const providerId of [policy.worker, policy.reviewer])
      if (providerId) routingProvider(store, providerId);
  }
  const next = { projectId, revision: current.revision + 1, policy };
  store.setMetadata(routingKey(projectId), stable(next));
  return next;
}
