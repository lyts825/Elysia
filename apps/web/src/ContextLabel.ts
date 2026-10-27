/**
 * 格式化上下文窗口大小和上下文策略的显示文本。
 * 把token规模和策略枚举转换为一致的中文标签，保持为无副作用的显示工具，不计算实际模型用量。
 * EN: Formats context-window sizes and context-policy labels. Converts token scale and policy enums into consistent Chinese labels as side-effect-free display utilities, without estimating model usage.
 */
import {
  CONTEXT_MAX_WINDOW_TOKENS,
  CONTEXT_TOKEN_UNIT,
  type ContextPolicy,
} from '../../../packages/contracts/src/index';
/**
 * 整千窗口显示为十进制 K（1000 token），应用最大窗口显示为 1M，其余保留具体 token 数量。
 * EN: Show exact thousands using decimal K (1000 tokens), the application maximum as 1M, and other values as explicit token counts.
 */
export const contextWindowSizeLabel = (tokens: number) =>
  tokens === CONTEXT_MAX_WINDOW_TOKENS
    ? '1M'
    : tokens % CONTEXT_TOKEN_UNIT === 0
      ? `${tokens / CONTEXT_TOKEN_UNIT}K`
      : `${tokens.toLocaleString()} Token`;
/**
 * 区分手动窗口、子任务继承分配和根任务托管容量。
 * EN: Distinguish a manual window, an inherited child-task allocation, and managed capacity on the root task.
 */
export const contextPolicyLabel = (policy: ContextPolicy, child = false) =>
  policy.mode === 'manual'
    ? `手动 · ${contextWindowSizeLabel(policy.windowTokens || 0)}`
    : child
      ? '托管 · 上级分配'
      : '托管 · 模型容量（最高 1M）';
