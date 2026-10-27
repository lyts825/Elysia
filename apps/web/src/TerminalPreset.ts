/* 生成终端代理配置的预设值。 */
import type { AgentTerminalProfile } from '../../../packages/contracts/src/index';
/** 按代理类型选择命令、协议和所需环境变量名，并为新配置分配独立 ID。 */
export function terminalPreset(agent: AgentTerminalProfile['agent'] = 'dsh'): AgentTerminalProfile {
  const choices = {
    dsh: {
      command: ['dsh', '--profile', 'headless', '--json', '-'],
      protocol: 'dsh-jsonl',
      environment: ['DEEPSEEK_API_KEY'],
    },
    codex: {
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
    claude: {
      command: [
        'claude',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ],
      protocol: 'claude-stream-json',
      environment: ['ANTHROPIC_API_KEY'],
    },
    gemini: {
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
    custom: { command: ['agent'], protocol: 'text', environment: [] },
  } as const;
  return {
    id: crypto.randomUUID(),
    label: `${agent === 'custom' ? '自定义' : agent.toUpperCase()} · Docker`,
    agent,
    image: 'elysia-agents:0.13.0',
    command: [...choices[agent].command],
    protocol: choices[agent].protocol,
    environment: [...choices[agent].environment],
    timeoutMs: 1800000,
    outputLimit: 100000,
    network: 'bridge',
    resourcePreset: 'standard',
  };
}
