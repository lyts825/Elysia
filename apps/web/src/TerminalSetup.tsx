import { useState } from 'react';
import { AgentTerminalProfile } from '../../../packages/contracts/src/index';
import { api } from './api';

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
  };
}

export function TerminalSetup({
  value,
  change,
  disabled,
}: {
  value: AgentTerminalProfile;
  change: (profile: AgentTerminalProfile) => void;
  disabled: boolean;
}) {
  const [argv, setArgv] = useState(() => JSON.stringify(value.command)),
    [issue, setIssue] = useState(''),
    [checking, setChecking] = useState(false),
    [status, setStatus] = useState('');
  function patch(next: Partial<AgentTerminalProfile>) {
    setStatus('');
    change({ ...value, ...next });
  }
  const validProfile = AgentTerminalProfile.safeParse(value).success;
  return (
    <div className="terminal-setup">
      <p className="field-help">
        Agent 在本项目创建的 Docker 容器里处理独立任务目录。终端自行调度内部代理，Elysia
        管理生命周期、日志、差异和最终验收。
      </p>
      <div className="form-columns">
        <label>
          Agent 终端
          <select
            value={value.agent}
            disabled={disabled}
            onChange={(e) => {
              const next = terminalPreset(e.target.value as AgentTerminalProfile['agent']);
              change({ ...next, image: value.image });
              setArgv(JSON.stringify(next.command));
              setIssue('');
              setStatus('');
            }}
          >
            <option value="dsh">DeepSeek Harness（DSH）</option>
            <option value="codex">Codex CLI</option>
            <option value="custom">自定义 Agent</option>
          </select>
        </label>
        <label>
          Docker 镜像
          <input value={value.image} disabled={disabled} onChange={(e) => patch({ image: e.target.value })} />
        </label>
      </div>
      <details>
        <summary>终端命令与连接配置</summary>
        <label>
          名称
          <input value={value.label} disabled={disabled} onChange={(e) => patch({ label: e.target.value })} />
        </label>
        <label>
          命令参数（JSON 数组）
          <textarea
            rows={3}
            value={argv}
            disabled={disabled}
            onChange={(e) => {
              setArgv(e.target.value);
              try {
                const command = AgentTerminalProfile.shape.command.parse(JSON.parse(e.target.value));
                patch({ command });
                setIssue('');
              } catch {
                patch({ command: [] });
                setIssue('请输入包含程序与参数的 JSON 数组，例如 ["agent", "--json"]。');
              }
            }}
          />
        </label>
        <label>
          输出协议
          <select
            value={value.protocol}
            disabled={disabled}
            onChange={(e) => patch({ protocol: e.target.value as AgentTerminalProfile['protocol'] })}
          >
            <option value="dsh-jsonl">DSH JSONL</option>
            <option value="codex-jsonl">Codex JSONL</option>
            <option value="claude-stream-json">Claude Stream JSON</option>
            <option value="text">普通文本</option>
          </select>
        </label>
        <label>
          凭据环境变量名称（逗号或换行分隔）
          <textarea
            rows={2}
            value={value.environment.join(', ')}
            disabled={disabled}
            onChange={(e) => patch({ environment: e.target.value.split(/[,\s]+/).filter(Boolean) })}
          />
        </label>
        <p className="field-help">
          只传入列出的本机服务环境变量。不会复用 API 设置中的加密密钥或宿主 Agent 登录目录。请在启动 Elysia
          前配置对应凭据；镜像需预先安装所选 Agent。
        </p>
        <div className="form-columns">
          <label>
            单次最长时间（分钟）
            <input
              type="number"
              min={1}
              max={30}
              value={value.timeoutMs / 60000}
              disabled={disabled}
              onChange={(e) => patch({ timeoutMs: Number(e.target.value) * 60000 })}
            />
          </label>
          <label>
            网络
            <select
              value={value.network}
              disabled={disabled}
              onChange={(e) => patch({ network: e.target.value as 'none' | 'bridge' })}
            >
              <option value="bridge">允许 Agent 连接模型服务</option>
              <option value="none">离线</option>
            </select>
          </label>
        </div>
      </details>
      {issue && (
        <p className="inline-warning" role="alert">
          {issue}
        </p>
      )}
      {!issue && !validProfile && (
        <p className="inline-warning" role="alert">
          请检查镜像名称、命令参数和环境变量名称；最长时间应为 1–30 分钟。
        </p>
      )}
      <button
        type="button"
        className="secondary"
        disabled={disabled || checking || !AgentTerminalProfile.safeParse(value).success}
        onClick={async () => {
          setChecking(true);
          setStatus('');
          try {
            const result = await api<{ message: string }>('/terminal/check', { profile: value });
            setStatus(result.message);
          } catch (error) {
            setStatus(error instanceof Error ? error.message : '检查失败');
          } finally {
            setChecking(false);
          }
        }}
      >
        {checking ? '正在检查…' : '检查 Docker 与镜像'}
      </button>
      {status && (
        <p className="field-help" role="status">
          {status}
        </p>
      )}
      <p className="field-help">
        首版终端使用完整任务目录写入与命令权限，计划开关关闭。API 的请求和 Token 上限不覆盖外部
        CLI；此通道按并发、容器资源和最长时间约束，模型用量由 Agent 管理。退出成功后需审阅日志及差异再验收。
      </p>
      <p className="field-help">
        准备镜像：
        <code>docker build -f packages/runtime/docker-agent.Dockerfile -t elysia-agents:0.13.0 .</code>
      </p>
    </div>
  );
}
