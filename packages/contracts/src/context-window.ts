import { CONTEXT_SAFETY_TOKENS, effectiveContextWindowTokens, type Agent } from './index.js';

/** Shared by compilation and bounded UI projections. Values are estimates, not tokenizer counts. */
export function contextWindowBudget(agent: Agent) {
  const provider = agent.providerBinding;
  const windowTokens = effectiveContextWindowTokens(agent);
  return {
    windowTokens,
    factor: provider.authMode === 'codex' ? 2 : 1,
    runtimeReserveTokens: provider.authMode === 'codex' ? 16384 : 0,
    inputBudgetTokens: Math.max(0, windowTokens - provider.outputLimit - CONTEXT_SAFETY_TOKENS),
  };
}
