/**
 * 生成终端代理配置的预设值。
 *
 * EN: Generates terminal agent configuration presets.
 *
 * 本模块生成互不共享可编辑数组的终端代理初始配置，包含命令参数、结果协议、镜像和资源默认值；仅生成配置与身份，启动、镜像核验和凭据注入由后续流程完成。
 * EN: Builds initial agent profiles with independent editable arrays, command arguments, result protocol, image, and resource defaults. It creates configuration/identity only; later flows start agents, verify images, and inject credentials.
 */
import type { AgentTerminalProfile } from '../../../packages/contracts/src/index';
import {
  antigravityTerminalCommand,
  claudeTerminalCommand,
} from '../../../packages/contracts/src/terminal-presets';
/**
 * 生成独立可编辑模板：按代理类型选择非交互命令、结果协议和环境变量名，分配新 ID。
 * 数组复制避免修改预设共享值；镜像与标准资源只是初始值，创建任务时还需冻结并核验。
 * 环境数组保存变量名称，不包含任何凭据原文，函数也不会启动 CLI 或下载镜像。
 *
 * EN: Creates an independently editable template with a noninteractive command, output protocol, env names, and new ID. Copies arrays to protect shared defaults; image/resources are initial values still frozen/validated at creation. Env arrays contain names only; no CLI starts and no image downloads.
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
      command: claudeTerminalCommand(),
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
    antigravity: {
      command: antigravityTerminalCommand(),
      protocol: 'antigravity-stream-json',
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
