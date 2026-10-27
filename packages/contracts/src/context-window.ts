// 计算上下文窗口与运行时预留的共享预算。
import { CONTEXT_SAFETY_TOKENS, effectiveContextWindowTokens, type Agent } from './index.js';

/** Shared by compilation and bounded UI projections. Values are estimates, not tokenizer counts. */
export function contextWindowBudget(agent: Agent) {
  const provider = agent.providerBinding;
  const windowTokens = effectiveContextWindowTokens(agent);
  return {
    windowTokens,
    // Codex 的估算使用更保守的倍率，并为运行时消息留出独立空间。
    factor: provider.authMode === 'codex' ? 2 : 1,
    runtimeReserveTokens: provider.authMode === 'codex' ? 16384 : 0,
    // 输出配额和安全余量不计入可用于输入的预算。
    inputBudgetTokens: Math.max(0, windowTokens - provider.outputLimit - CONTEXT_SAFETY_TOKENS),
  };
}
