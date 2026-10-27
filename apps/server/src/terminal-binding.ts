/**
 * 为共享任务历史构建终端配置的兼容描述符。
 * 只为共享历史补兼容形状，真实连接保存在冻结 execution.profile；虚拟端点和未用环境名防误用，不提供实际 API 或在线验证。
 * EN: Builds terminal compatibility descriptors for shared task history. Supplies history compatibility only while actual bindings remain frozen in execution.profile; sentinel endpoint/environment grants no API or online validation.
 */
import { ProviderConfig, type AgentTerminalProfile } from '../../../packages/contracts/src/index.js';

/**
 * 这是共享任务历史的兼容描述，绝非 API 连接。 为共享 Agent/请求历史结构补足 ProviderConfig 形态，终端实际连接在 execution.profile 中冻结。 terminal.invalid 与未使用环境名防止此兼容描述被误当成原生 API 连接；此函数不验证外部模型。
 * EN: Compatibility descriptor for shared task history; this is never an API connection. Supplies ProviderConfig shape for shared agent/request history while the actual terminal connection is frozen in execution.profile. An invalid host and unused environment name prevent accidental native-API use; no external model verification occurs.
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
