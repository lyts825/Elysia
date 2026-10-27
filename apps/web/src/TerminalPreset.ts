/* 生成终端代理配置的预设值。 */
import type { AgentTerminalProfile } from '../../../packages/contracts/src/index';
/**
 * 生成独立可编辑模板：按代理类型选择非交互命令、结果协议和环境变量名，分配新 ID。
 * 数组复制避免修改预设共享值；镜像与标准资源只是初始值，创建任务时还需冻结并核验。
 * 环境数组保存变量名称，不包含任何凭据原文，函数也不会启动 CLI 或下载镜像。
 */
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
