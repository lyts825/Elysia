/** 定义终端应用目录和连接兼容性检查。 */
import { AgentTerminalProfile, invariant } from '../../../packages/contracts/src/index.js';
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
  custom: ['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini'],
};
const image = 'elysia-agents:0.13.0';
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
        command: [
          'claude',
          '-p',
          '--verbose',
          '--output-format',
          'stream-json',
          '--dangerously-skip-permissions',
        ],
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
export function initialTerminalProfiles(): AgentTerminalProfile[] {
  return terminalAppCatalog()
    .filter((entry) => entry.id === 'dsh' || entry.id === 'codex')
    .map((entry) => AgentTerminalProfile.parse(entry.preset));
}
export function terminalAppForProfile(profile: AgentTerminalProfile): TerminalAppId {
  return TerminalAppId.parse(profile.agent);
}
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
