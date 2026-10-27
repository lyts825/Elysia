/**
 * 计算上下文窗口与运行时预留的共享预算。
 * 供编译器与界面复用同一预算口径；估算值与供应商真实计费保持区分。
 *
 * EN: Calculates the shared context-window budget and the reserve for runtime content.
 * Keeps compiler/UI budgeting consistent while separating estimates from provider billing.
 */
import { CONTEXT_SAFETY_TOKENS, effectiveContextWindowTokens, type Agent } from './index.js';

/**
 * 编译与界面共用的窗口预算：总窗口先减输出和安全预留，运行时预留另行计入输入估算。
 * factor 按 UTF-8 字节估算 token，Codex 采用更保守倍率；不能作为供应商实测用量。
 *
 * EN: Shared by compilation and the UI: output and safety reserves are deducted from the total window, while the runtime reserve is accounted for separately in input estimates. The UTF-8 byte factor estimates tokens conservatively, especially for Codex; it is not provider-measured usage.
 */
export function contextWindowBudget(agent: Agent) {
  const provider = agent.providerBinding;
  const windowTokens = effectiveContextWindowTokens(agent);
  return {
    windowTokens,
    /**
     * Codex 的估算使用更保守的倍率，并为运行时消息留出独立空间。
     *
     * EN: Uses a more conservative estimate for Codex and reserves separate room for runtime messages.
     */
    factor: provider.authMode === 'codex' ? 2 : 1,
    runtimeReserveTokens: provider.authMode === 'codex' ? 16384 : 0,
    /**
     * 输出配额和安全余量不计入可用于输入的预算。
     *
     * EN: The output allowance and safety margin are excluded from the available input budget.
     */
    inputBudgetTokens: Math.max(0, windowTokens - provider.outputLimit - CONTEXT_SAFETY_TOKENS),
  };
}
