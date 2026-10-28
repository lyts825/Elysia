/**
 * 解析终端执行所需的连接配置。
 * 按适配器/协议把冻结绑定转为 CLI 环境/参数，密钥由宿主解析，预览用占位；不从当前可变设置重绑定旧任务。
 * EN: Resolves connection configuration required by terminal execution. Converts frozen bindings to adapter/protocol CLI environment/arguments with host secret resolution/placeholders, never rebinding old runs from mutable settings.
 */
import {
  AgentTerminalProfile,
  AppError,
  invariant,
  type TerminalConnectionBinding,
} from '../../contracts/src/index.js';
import { TerminalConnectionBinding as Binding } from '../../contracts/src/terminal-control.js';

export interface TerminalConnectionConfiguration {
  command: string[];
  environment: Record<string, string>;
  /**
   * 这些路径相对容器私有 HOME，文件本身不包含凭据。
   * EN: Relative to the container's private HOME. These files contain no credentials.
   */
  files: { path: string; content: string }[];
  secrets: string[];
}

const supported = {
  codex: ['openai-responses'],
  dsh: ['anthropic-messages'],
  claude: ['anthropic-messages'],
  gemini: ['gemini'],
  antigravity: ['gemini'],
  custom: ['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini'],
};

/**
 * API Key 模式需显式选择 Gemini 提供商；文件只含设置，不复制宿主登录状态。
 * EN: API-key mode explicitly selects the Gemini provider without copying host authentication state.
 */
export function terminalEnvironmentFiles(
  profile: AgentTerminalProfile,
): TerminalConnectionConfiguration['files'] {
  return profile.agent === 'antigravity'
    ? [
        {
          path: '.gemini/antigravity-cli/settings.json',
          content: JSON.stringify({ modelProvider: 'gemini', artifactReviewPolicy: 'always-proceed' }),
        },
      ]
    : [];
}

/**
 * 从冻结绑定及其精确凭据引用构建配置，绝不改读实时供应商记录。 从冻结连接生成容器命令、环境和私有 HOME 配置。实际 credential 只进入环境及脱敏列表， 不写入生成的普通配置文件；拒绝命令中已有的模型/端点覆盖参数，避免两份配置争夺优先级。
 * EN: Build from the frozen binding and its exact credential reference, never a live provider record. Builds container commands, environment, and private-HOME configuration from the frozen connection. Credentials enter only the environment and redaction list, not ordinary generated files. Existing model or endpoint overrides are rejected to avoid competing configuration precedence.
 */
export function terminalConnectionConfiguration(
  rawProfile: AgentTerminalProfile,
  rawBinding: TerminalConnectionBinding,
  credential: string,
): TerminalConnectionConfiguration {
  const profile = AgentTerminalProfile.parse(rawProfile);
  const binding = Binding.parse(rawBinding);
  invariant(
    supported[profile.agent].includes(binding.protocol),
    'TERMINAL_CONNECTION_PROTOCOL',
    '所选 API 协议与当前 CLI 不兼容，请选择该 CLI 支持的连接',
  );
  invariant(
    credential.length > 0 && credential.length <= 8192 && !/[\r\n\0]/.test(credential),
    'TERMINAL_CREDENTIAL_MISSING',
    '所选 API 连接的凭据不可用，请在终端管理中检查凭据',
  );
  const command = [...profile.command];
  const result: TerminalConnectionConfiguration = {
    command,
    environment: {},
    files: terminalEnvironmentFiles(profile),
    secrets: [credential],
  };
  /**
   * 在冻结CLI参数中拒绝会覆盖管理连接的端点、模型和配置选项，避免配置优先级冲突。
   * EN: Rejects frozen CLI flags that would override managed endpoints, models, or configuration, avoiding conflicting precedence.
   */
  const refuseFlags = (flags: string[]) => {
    /**
     * 必须先移除冲突参数再使用管理器连接，不能把用户自带配置静默覆盖成另一组授权。
     * EN: Conflicting arguments must be removed before using a managed connection; a user-supplied configuration cannot silently become a different authorization.
     */
    if (command.slice(1).some((part) => flags.some((flag) => part === flag || part.startsWith(flag + '='))))
      throw new AppError(
        'TERMINAL_CONNECTION_COMMAND',
        '命令参数已指定模型或 API 配置；请移除冲突参数后使用管理器中的 API 连接',
      );
  };
  if (profile.agent === 'codex') {
    refuseFlags(['-c', '--config', '-m', '--model', '-p', '--profile', '--oss']);
    invariant(command[0] === 'codex', 'TERMINAL_CONNECTION_COMMAND', 'Codex API 连接需要 codex 命令');
    result.environment.ELYSIA_TERMINAL_API_KEY = credential;
    const config = {
      model: binding.model,
      model_provider: 'elysia',
      'model_providers.elysia.name': binding.name,
      'model_providers.elysia.base_url': binding.baseUrl,
      'model_providers.elysia.env_key': 'ELYSIA_TERMINAL_API_KEY',
      'model_providers.elysia.wire_api': 'responses',
      'model_providers.elysia.requires_openai_auth': false,
      'model_providers.elysia.supports_websockets': false,
    };
    result.command = [
      command[0],
      ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
      ...command.slice(1),
    ];
  } else if (profile.agent === 'dsh') {
    refuseFlags(['--patch']);
    invariant(command[0] === 'dsh', 'TERMINAL_CONNECTION_COMMAND', 'DSH API 连接需要 dsh 命令');
    const searchBase = binding.baseUrl.replace(/\/+$/, '').replace(/(?:\/v1)?$/, '/v1');
    result.environment = {
      ELYSIA_TERMINAL_API_KEY: credential,
      DEEPSEEK_BASE_URL: binding.baseUrl,
      DEEPSEEK_SEARCH_BASE_URL: searchBase,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
    };
    /**
     * JSON 是 YAML 的子集；显式补丁行避免读取项目 .env 或隐式模型默认值。
     * EN: JSON is a YAML subset. Explicit patch rows avoid project .env and implicit model defaults.
     */
    result.files.push({
      path: 'elysia.dsh.patch.yml',
      content: JSON.stringify([
        { id: 'agent-default-model', config: { provider: 'deepseek-official', model: binding.model } },
        { id: 'llm-deepseek', config: { baseURL: binding.baseUrl, apiKeyEnv: 'ELYSIA_TERMINAL_API_KEY' } },
        { id: 'llm-deepseek-account', disabled: true },
        {
          id: 'web-search-deepseek',
          config: { baseURL: searchBase, apiKeyEnv: 'ELYSIA_TERMINAL_API_KEY', model: binding.model },
        },
        { id: 'session-log-deepseek', config: { enabled: false } },
      ]),
    });
    result.command = [command[0], '--patch', '/home/agent/elysia.dsh.patch.yml', ...command.slice(1)];
  } else if (profile.agent === 'claude') {
    refuseFlags(['--model', '--settings']);
    invariant(command[0] === 'claude', 'TERMINAL_CONNECTION_COMMAND', 'Claude API 连接需要 claude 命令');
    result.environment = {
      ANTHROPIC_API_KEY: credential,
      ANTHROPIC_BASE_URL: binding.baseUrl,
      ANTHROPIC_MODEL: binding.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    result.command.push('--model', binding.model);
  } else if (profile.agent === 'antigravity') {
    refuseFlags(['--model', '--agent', '--project', '--new-project', '--conversation', '--continue', '-c']);
    invariant(command[0] === 'agy', 'TERMINAL_CONNECTION_COMMAND', 'Antigravity API 连接需要 agy 命令');
    result.environment = {
      GEMINI_API_KEY: credential,
      GOOGLE_GEMINI_BASE_URL: binding.baseUrl,
    };
    result.command.push('--model', binding.model);
  } else if (profile.agent === 'gemini') {
    refuseFlags(['-m', '--model']);
    invariant(command[0] === 'gemini', 'TERMINAL_CONNECTION_COMMAND', 'Gemini API 连接需要 gemini 命令');
    result.environment = {
      GEMINI_API_KEY: credential,
      GOOGLE_GEMINI_BASE_URL: binding.baseUrl,
      GEMINI_TELEMETRY_ENABLED: 'false',
    };
    result.command.push('--model', binding.model);
  } else {
    /**
     * 自定义命令须显式采用此处约定的中立环境变量协议。
     * EN: Custom commands opt in to this documented neutral environment contract.
     */
    result.environment = {
      ELYSIA_API_KEY: credential,
      ELYSIA_API_BASE_URL: binding.baseUrl,
      ELYSIA_API_MODEL: binding.model,
      ELYSIA_API_PROTOCOL: binding.protocol,
    };
  }
  return result;
}
