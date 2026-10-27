/* 格式化上下文窗口大小和上下文策略的显示文本。 */
import {
  CONTEXT_MAX_WINDOW_TOKENS,
  CONTEXT_TOKEN_UNIT,
  type ContextPolicy,
} from '../../../packages/contracts/src/index';
/** 整千窗口显示为 K，最大窗口显示为 1M，其余保留具体 Token 数量。 */
export const contextWindowSizeLabel = (tokens: number) =>
  tokens === CONTEXT_MAX_WINDOW_TOKENS
    ? '1M'
    : tokens % CONTEXT_TOKEN_UNIT === 0
      ? `${tokens / CONTEXT_TOKEN_UNIT}K`
      : `${tokens.toLocaleString()} Token`;
/** 区分手动窗口、子任务继承分配和根任务托管容量。 */
export const contextPolicyLabel = (policy: ContextPolicy, child = false) =>
  policy.mode === 'manual'
    ? `手动 · ${contextWindowSizeLabel(policy.windowTokens || 0)}`
    : child
      ? '托管 · 上级分配'
      : '托管 · 模型容量（最高 1M）';
