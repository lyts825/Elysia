// 在运行创建时校验并冻结执行策略。
import { ToolReviewPolicy, CommandBackendPolicy } from '../../contracts/src/execution-policy.js';
import { invariant, type Contract, type ProviderConfig, type Run } from '../../contracts/src/index.js';
import type { KernelStore } from './ports.js';

/** 验证运行的审核与命令后端范围；模型审核返回经过验证的连接快照。 */
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
  // 仅模型审核需要冻结供应商绑定；规则审核与关闭模式没有模型连接。
  const binding = store.require<ProviderConfig>('providers', review.providerId);
  invariant(
    !binding.archived && binding.checkedRevision === binding.revision,
    'TOOL_REVIEW_UNCHECKED',
    '审核模型尚未验证或已归档',
  );
  // Binding and output reservation remain exactly the verified provider configuration.
  return structuredClone(binding);
}
