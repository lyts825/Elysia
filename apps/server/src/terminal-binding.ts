/** 为共享任务历史构建终端配置的兼容描述符。 */
import { ProviderConfig, type AgentTerminalProfile } from '../../../packages/contracts/src/index.js';

/** Compatibility descriptor for shared task history; this is never an API connection. */
/**
 * 为共享 Agent/请求历史结构补足 ProviderConfig 形态，终端实际连接在 execution.profile 中冻结。
 * terminal.invalid 与未使用环境名防止此兼容描述被误当成原生 API 连接；此函数不验证外部模型。
 */
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
