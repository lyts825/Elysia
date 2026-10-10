import type { ContextPolicy } from '../../../packages/contracts/src/index';
export const contextPolicyLabel = (policy: ContextPolicy, child = false) =>
  policy.mode === 'manual'
    ? `手动 · ${(policy.windowTokens || 0).toLocaleString()} Token`
    : child
      ? '托管 · 上级分配'
      : '托管 · 模型容量';
