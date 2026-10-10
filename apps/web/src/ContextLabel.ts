import {
  CONTEXT_MAX_WINDOW_TOKENS,
  CONTEXT_TOKEN_UNIT,
  type ContextPolicy,
} from '../../../packages/contracts/src/index';
export const contextWindowSizeLabel = (tokens: number) =>
  tokens === CONTEXT_MAX_WINDOW_TOKENS
    ? '1M'
    : tokens % CONTEXT_TOKEN_UNIT === 0
      ? `${tokens / CONTEXT_TOKEN_UNIT}K`
      : `${tokens.toLocaleString()} Token`;
export const contextPolicyLabel = (policy: ContextPolicy, child = false) =>
  policy.mode === 'manual'
    ? `手动 · ${contextWindowSizeLabel(policy.windowTokens || 0)}`
    : child
      ? '托管 · 上级分配'
      : '托管 · 模型容量（最高 1M）';
