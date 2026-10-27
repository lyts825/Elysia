/** 为共享任务历史构建终端配置的兼容描述符。 */
import { ProviderConfig, type AgentTerminalProfile } from '../../../packages/contracts/src/index.js';

/** Compatibility descriptor for shared task history; this is never an API connection. */
export function terminalBinding(profile: AgentTerminalProfile): ProviderConfig {
  return {
    ...ProviderConfig.parse({
      id: `terminal-${profile.id}`,
      label: profile.label,
      kind: 'openai',
      authMode: 'apiKey',
      model: profile.agent,
      baseUrl: 'https://terminal.invalid/v1',
      apiKeyEnv: 'ELYSIA_TERMINAL_UNUSED',
      account: `terminal-${profile.id}`,
      contextLimit: 32000,
      outputLimit: 4096,
      concurrency: 2,
      rpm: 60,
      tpm: 200000,
      cache: { mode: 'unknown', minTokens: null, ttl: null, parameters: {} },
      prices: null,
    }),
    revision: 0,
    checkedRevision: null,
  };
}
