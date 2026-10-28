/**
 * 定义终端应用目录和连接兼容性检查。
 * 声明应用、容器预设和协议支持并返回新对象；目录不证明镜像已安装、CLI 已运行或凭据已验证。
 * EN: Defines terminal app presets and connection compatibility checks. Declares app/container/protocol support through fresh objects without proving image installation, running CLI or credential validity.
 */
import { AgentTerminalProfile, invariant } from '../../../packages/contracts/src/index.js';
import { antigravityTerminalCommand, claudeTerminalCommand } from '../../../packages/contracts/src/terminal-presets.js';
import {
  TerminalAppId,
  type TerminalAppCatalogEntry,
  type TerminalConnectionBinding,
} from '../../../packages/contracts/src/terminal-control.js';

export const terminalProtocols: Record<TerminalAppId, TerminalConnectionBinding['protocol'][]> = {
  codex: ['openai-responses'],
  dsh: ['anthropic-messages'],
  claude: ['anthropic-messages'],
  gemini: ['gemini'],
  antigravity: ['gemini'],
  custom: ['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini'],
};
const image = 'elysia-agents:0.13.0';
/**
 * 返回内置 CLI 的显示目录和容器预设；目录仅声明支持形态，不表示镜像已安装或凭据已验证。 每次生成独立配置对象，后续模板编辑不会直接改写下一次读取的内置预设。
 * EN: Returns built-in CLI display entries and container presets; support declarations do not prove image installation or credentials. Fresh objects prevent edited templates from mutating future preset reads.
 */
export function terminalAppCatalog(): TerminalAppCatalogEntry[] {
  return [
    {
      id: 'codex',
      label: 'Codex CLI',
      description: '项目任务、代码修改与交付',
      executable: 'codex',
      protocols: terminalProtocols.codex,
      preset: {
        id: 'fceec6bc-f890-4e9e-ae1c-af63e40e606b',
        label: 'Codex CLI · Docker',
        agent: 'codex',
        image,
        command: [
          'codex',
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          '--ignore-user-config',
          '-',
        ],
        protocol: 'codex-jsonl',
        environment: ['OPENAI_API_KEY'],
      },
    },
    {
      id: 'dsh',
      label: 'DSH',
      description: 'DeepSeek 终端代理',
      executable: 'dsh',
      protocols: terminalProtocols.dsh,
      preset: {
        id: '3a7481a1-b068-4b0d-ae5d-887f5d1f3b65',
        label: 'DSH · Docker',
        agent: 'dsh',
        image,
        command: ['dsh', '--profile', 'headless', '--json', '-'],
        protocol: 'dsh-jsonl',
        environment: ['DEEPSEEK_API_KEY'],
      },
    },
    {
      id: 'claude',
      label: 'Claude Code',
      description: 'Anthropic Messages 兼容连接',
      executable: 'claude',
      protocols: terminalProtocols.claude,
      preset: {
        id: '40b8e1d6-d469-4b56-a1c7-9e098129ec55',
        label: 'Claude Code · Docker',
        agent: 'claude',
        image,
        command: claudeTerminalCommand(),
        protocol: 'claude-stream-json',
        environment: ['ANTHROPIC_API_KEY'],
      },
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      description: 'Gemini API 终端代理',
      executable: 'gemini',
      protocols: terminalProtocols.gemini,
      preset: {
        id: 'c9bf0a51-285d-4cab-bc77-15e8dd274f08',
        label: 'Gemini CLI · Docker',
        agent: 'gemini',
        image,
        command: [
          'gemini',
          '-p',
          'Complete the task supplied through standard input.',
          '--output-format',
          'stream-json',
          '--approval-mode',
          'yolo',
        ],
        protocol: 'gemini-stream-json',
        environment: ['GEMINI_API_KEY'],
      },
    },
    {
      id: 'antigravity',
      label: 'Antigravity CLI',
      description: 'Google Antigravity 任务执行，使用 Gemini API 连接',
      executable: 'agy',
      protocols: terminalProtocols.antigravity,
      preset: {
        id: '9a178702-43db-4f62-8c87-735bd0951c1d',
        label: 'Antigravity CLI · Docker',
        agent: 'antigravity',
        image,
        command: antigravityTerminalCommand(),
        protocol: 'antigravity-stream-json',
        environment: ['GEMINI_API_KEY'],
      },
    },
    {
      id: 'custom',
      label: '自定义 CLI',
      description: '配置命令、镜像与环境变量',
      executable: '',
      protocols: terminalProtocols.custom,
      preset: {
        id: 'd9e34a0a-a941-49d7-a9f2-af747eef0f32',
        label: '自定义 CLI · Docker',
        agent: 'custom',
        image,
        command: ['agent'],
        protocol: 'text',
        environment: [],
      },
    },
  ];
}
/**
 * 从目录生成默认启用的 Codex 和 DSH 终端配置。
 * EN: Builds default enabled Codex and DSH terminal configuration.
 */
export function initialTerminalProfiles(): AgentTerminalProfile[] {
  return terminalAppCatalog()
    .filter((entry) => entry.id === 'dsh' || entry.id === 'codex')
    .map((entry) => AgentTerminalProfile.parse(entry.preset));
}
/**
 * 从经过 schema 校验的模板代理类型确定应用键，不按用户可改的标签或命令名称猜测。
 * EN: Derives the app key from schema-validated adapter type, never editable labels or command names.
 */
export function terminalAppForProfile(profile: AgentTerminalProfile): TerminalAppId {
  return TerminalAppId.parse(profile.agent);
}
/**
 * 校验终端应用支持所选连接协议，避免绑定不兼容的连接。
 * EN: Validates that the terminal app supports the selected connection protocol.
 */
export function assertTerminalConnectionCompatible(
  profile: AgentTerminalProfile,
  connection: TerminalConnectionBinding,
) {
  const appId = terminalAppForProfile(profile);
  invariant(
    terminalProtocols[appId].includes(connection.protocol),
    'TERMINAL_CONNECTION_PROTOCOL',
    `${terminalAppCatalog().find((entry) => entry.id === appId)!.label} 不支持 ${connection.protocol}；请在 API 连接中选择 ${terminalProtocols[appId].join(' / ')} 协议`,
  );
}
