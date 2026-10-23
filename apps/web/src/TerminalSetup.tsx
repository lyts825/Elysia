import { useId, useRef, useState } from 'react';
import {
  AgentTerminalProfile,
  terminalResourcePresets,
  terminalResourceRequirement,
} from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';

import { terminalPreset } from './TerminalPreset';
import './terminal-profile-form.css';
export { terminalPreset } from './TerminalPreset';

export function TerminalSetup({
  value,
  change,
  disabled,
}: {
  value: AgentTerminalProfile;
  change: (profile: AgentTerminalProfile) => void;
  disabled: boolean;
}) {
  const resourceHelpId = useId(),
    commandHelpId = useId(),
    commandIssueId = useId(),
    environmentCountId = useId(),
    environmentHelpId = useId();
  const { api } = useSurfaceClient();
  const [argv, setArgv] = useState(() => JSON.stringify(value.command)),
    [issue, setIssue] = useState(''),
    [checking, setChecking] = useState(false),
    [status, setStatus] = useState('');
  const currentProfile = useRef('');
  const commandField = useRef<HTMLTextAreaElement>(null),
    advancedFields = useRef<HTMLDetailsElement>(null);
  currentProfile.current = JSON.stringify(value);
  function patch(next: Partial<AgentTerminalProfile>) {
    setStatus('');
    const profile = { ...value, ...next };
    currentProfile.current = JSON.stringify(profile);
    change(profile);
  }
  const validProfile = AgentTerminalProfile.safeParse(value).success;
  return (
    <div className="terminal-profile-form">
      <h5>终端配置</h5>
      <p className="field-help">
        Agent 在本项目创建的 Docker 容器里处理独立任务目录。终端自行调度内部代理，Elysia
        管理生命周期、日志、差异和最终验收。
      </p>
      <fieldset className="terminal-profile-section">
        <legend>运行环境</legend>
        <div className="terminal-profile-columns">
          <label>
            Agent 终端
            <select
              value={value.agent}
              disabled={disabled}
              onChange={(e) => {
                const next = terminalPreset(e.target.value as AgentTerminalProfile['agent']);
                const profile = {
                  ...next,
                  id: value.id,
                  image: value.image,
                  resourcePreset: value.resourcePreset,
                };
                currentProfile.current = JSON.stringify(profile);
                change(profile);
                setArgv(JSON.stringify(next.command));
                setIssue('');
                setStatus('');
              }}
            >
              <option value="dsh">DeepSeek Harness（DSH）</option>
              <option value="codex">Codex CLI</option>
              <option value="claude">Claude Code</option>
              <option value="gemini">Gemini CLI</option>
              <option value="custom">自定义 Agent</option>
            </select>
          </label>
          <label>
            Docker 镜像
            <input
              value={value.image}
              disabled={disabled}
              onChange={(e) => patch({ image: e.target.value })}
            />
          </label>
        </div>
        <label>
          终端资源规格
          <select
            aria-label="终端资源规格"
            aria-describedby={resourceHelpId}
            value={value.resourcePreset ?? 'standard'}
            disabled={disabled}
            onChange={(e) =>
              patch({ resourcePreset: e.target.value as AgentTerminalProfile['resourcePreset'] })
            }
          >
            {terminalResourcePresets.map((preset) => {
              const amount = terminalResourceRequirement(preset);
              return (
                <option key={preset} value={preset}>
                  {{ light: '轻量', standard: '标准', large: '大型' }[preset]} · {amount.cpus} CPU /{' '}
                  {amount.memoryMiB} MiB
                </option>
              );
            })}
          </select>
          <small className="field-help" id={resourceHelpId}>
            创建任务时固定。最多同时运行两个终端；容量不足时排队，不会自动降低规格。
          </small>
        </label>
      </fieldset>
      <details className="terminal-profile-summary">
        <summary>查看当前配置值摘要</summary>
        {issue && <p className="field-help">命令输入尚未通过解析，摘要展示当前配置值，请核对原始输入。</p>}
        <dl className="terminal-profile-reading" tabIndex={0} role="region" aria-label="当前终端模板配置摘要">
          <div>
            <dt>名称</dt>
            <dd>{value.label}</dd>
          </div>
          <div>
            <dt>Docker 镜像</dt>
            <dd>
              <code>{value.image}</code>
            </dd>
          </div>
          <div>
            <dt>资源规格</dt>
            <dd>
              {{ light: '轻量', standard: '标准', large: '大型' }[value.resourcePreset ?? 'standard']} ·{' '}
              {terminalResourceRequirement(value.resourcePreset ?? 'standard').cpus} CPU /{' '}
              {terminalResourceRequirement(value.resourcePreset ?? 'standard').memoryMiB} MiB
            </dd>
          </div>
          <div>
            <dt>命令参数（配置值）</dt>
            <dd>
              <code>{JSON.stringify(value.command, null, 2)}</code>
            </dd>
          </div>
          <div>
            <dt>输出协议</dt>
            <dd>
              <code>{value.protocol}</code>
            </dd>
          </div>
          <div>
            <dt>凭据环境变量名称</dt>
            <dd>
              <code>{value.environment.join('\n') || '未配置'}</code>
            </dd>
          </div>
          <div>
            <dt>最长时间与网络</dt>
            <dd>
              {value.timeoutMs / 60000} 分钟 · {value.network === 'none' ? '离线' : '允许 Agent 连接模型服务'}
            </dd>
          </div>
        </dl>
      </details>
      <details className="terminal-profile-advanced" ref={advancedFields}>
        <summary>终端命令与连接配置</summary>
        <div className="terminal-profile-fields">
          <label>
            名称
            <input
              value={value.label}
              disabled={disabled}
              onChange={(e) => patch({ label: e.target.value })}
            />
          </label>
          <label>
            命令参数（JSON 数组）
            <textarea
              ref={commandField}
              aria-describedby={commandHelpId}
              aria-invalid={!!issue}
              aria-errormessage={issue ? commandIssueId : undefined}
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
            <small className="field-help" id={commandHelpId}>
              {issue
                ? '尚未形成有效命令数组。'
                : value.command.length
                  ? `${value.command.length} 项，含可执行程序。`
                  : '尚未配置可执行程序。'}
              仅有效 JSON 数组会用于终端配置。
            </small>
          </label>
          {issue && (
            <p
              id={commandIssueId}
              className="inline-warning terminal-profile-reading terminal-profile-command-issue"
              role="alert"
              tabIndex={0}
              aria-label="终端配置输入问题"
            >
              {issue}
            </p>
          )}
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
              <option value="gemini-stream-json">Gemini Stream JSON</option>
              <option value="text">普通文本</option>
            </select>
          </label>
          <label>
            凭据环境变量名称（逗号或换行分隔）
            <textarea
              aria-describedby={`${environmentHelpId} ${environmentCountId}`}
              rows={2}
              value={value.environment.join(', ')}
              disabled={disabled}
              onChange={(e) => patch({ environment: e.target.value.split(/[,\s]+/).filter(Boolean) })}
            />
            <small className="field-help" id={environmentCountId}>
              {value.environment.length} / 12 个变量名
            </small>
          </label>
          <p className="field-help" id={environmentHelpId}>
            未选择管理中心的 API 连接时，读取这里列出的服务环境变量；选择连接后使用该连接的配置。 不会映射宿主
            Agent 登录目录。CLI 可在终端管理中安装，或使用已有镜像。
          </p>
          <div className="terminal-profile-columns">
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
        </div>
      </details>
      {!issue && !validProfile && (
        <p
          className="inline-warning terminal-profile-reading"
          role="alert"
          tabIndex={0}
          aria-label="终端配置校验问题"
        >
          请检查镜像名称、命令参数和环境变量名称；最长时间应为 1–30 分钟。
        </p>
      )}
      <div className="terminal-profile-check">
        <button
          type="button"
          className="secondary"
          disabled={disabled || checking || !AgentTerminalProfile.safeParse(value).success}
          onClick={async () => {
            const checkedProfile = JSON.stringify(value);
            setChecking(true);
            setStatus('');
            try {
              const result = await api<{ message: string }>('/terminal/check', { profile: value });
              if (currentProfile.current === checkedProfile) setStatus(result.message);
            } catch (error) {
              if (currentProfile.current === checkedProfile)
                setStatus(error instanceof Error ? error.message : '检查失败');
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? '正在检查…' : '检查 Docker 与镜像'}
        </button>
        {issue && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              if (advancedFields.current) advancedFields.current.open = true;
              commandField.current?.focus();
            }}
          >
            定位命令参数
          </button>
        )}
        {status && (
          <div className="terminal-profile-feedback" role="status">
            <strong>环境检查反馈</strong>
            <p
              className="field-help terminal-profile-reading"
              role="region"
              aria-label="终端环境检查完整反馈"
              tabIndex={0}
            >
              {status}
            </p>
          </div>
        )}
      </div>
      <details className="terminal-profile-guide">
        <summary>镜像准备与运行说明</summary>
        <p className="field-help">
          首版终端使用完整任务目录写入与命令权限，计划开关关闭。API 的请求和 Token 上限不覆盖外部
          CLI；此通道按并发、容器资源和最长时间约束，模型用量由 Agent 管理。退出成功后需审阅日志及差异再验收。
        </p>
        <p className="field-help">
          准备镜像：
          <code>docker build -f packages/runtime/docker-agent.Dockerfile -t elysia-agents:0.13.0 .</code>
        </p>
      </details>
    </div>
  );
}
