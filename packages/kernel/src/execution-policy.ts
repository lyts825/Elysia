/**
 * 在运行创建时校验并冻结执行策略。
 * 创建时冻结审核连接，执行层仍必须在真实副作用边界重新验证权限和指纹。
 *
 * EN: Validates and freezes execution policy at run creation.
 * Freezes review bindings at creation; execution still revalidates permissions/fingerprints at the side-effect boundary.
 */
import { ToolReviewPolicy, CommandBackendPolicy } from '../../contracts/src/execution-policy.js';
import { invariant, type Contract, type ProviderConfig, type Run } from '../../contracts/src/index.js';
import type { KernelStore } from './ports.js';

/**
 * 验证工具审核和命令后端只作用于原生项目任务，并返回模型审核的冻结连接副本。
 * 关闭/规则模式不需要模型；这里只检查策略与绑定，实际命令隔离及审核在执行层进行。
 *
 * EN: Restricts tool review and command backends to native project tasks and returns a frozen model-review connection. Disabled/rules modes need no model; this layer validates policy/binding while execution implements isolation and review.
 */
export function freezeExecutionPolicy(
  store: KernelStore,
  contract: Contract,
  kind: Run['kind'],
  execution: NonNullable<Run['execution']>,
) {
  const review = ToolReviewPolicy.parse(contract.toolReview ?? { mode: 'off' });
  const backend = CommandBackendPolicy.parse(contract.commandBackend ?? { kind: 'local' });
  invariant(
    (review.mode === 'off' && backend.kind === 'local') || (kind === 'task' && execution.kind === 'native'),
    'EXECUTION_POLICY_SCOPE',
    '工具审核和命令后端仅适用于原生项目任务',
  );
  if (review.mode !== 'model') return undefined;
  /**
   * 仅模型审核需要冻结供应商绑定；规则审核与关闭模式没有模型连接。
   *
   * EN: Only model review freezes a provider binding; rules-only and disabled review have no model connection.
   */
  const binding = store.require<ProviderConfig>('providers', review.providerId);
  invariant(
    !binding.archived && binding.checkedRevision === binding.revision,
    'TOOL_REVIEW_UNCHECKED',
    '审核模型尚未验证或已归档',
  );
  /**
   * 绑定与输出预留完全保留已经核验的供应商配置。
   *
   * EN: Binding and output reservation remain exactly the verified provider configuration.
   */
  return structuredClone(binding);
}
