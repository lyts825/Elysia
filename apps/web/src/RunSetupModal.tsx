import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AgentTerminalProfile,
  Budget,
  Permissions,
  minimumContextWindowTokens,
  type ContextPolicy,
  type TerminalConnectionView,
} from '../../../packages/contracts/src/index';
import { ModelPicker, type ModelChoice, type SelectableProvider } from './ModelPicker';
import { ContextPolicyEditor, validContextPolicy } from './ContextPolicyEditor';
import { useSurfaceClient } from './SurfaceClientContext';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { deferredPanel } from './DeferredPanel';
import { terminalPreset } from './TerminalPreset';
import { manageUsage } from './desktop';
import { NativeProjectDefaultsPanel } from './NativeProjectDefaults';
import type { NativeProjectDefaults } from '../../../packages/contracts/src/workflow';
import { RunConfirmation } from './RunConfirmation';
import { TaskRequirements, requirementLines, validRequirements } from './TaskRequirements';
import './workflow.css';
import type { RunSetupDraft } from './RunSetupDraft';
export type { RunSetupDraft } from './RunSetupDraft';
const TerminalSetup = deferredPanel(() => import('./TerminalSetup').then((m) => m.TerminalSetup), '终端设置');

export function RunModal({
  providers,
  objective,
  kind,
  projectName,
  projectId,
  close,
  busy,
  submit,
  settings,
  initial,
  modelChoice,
  contextPolicy,
  terminalTemplate,
  terminalConnections = [],
  beforeForm,
  changed,
  submitDisabled = false,
}: {
  providers: SelectableProvider[];
  objective: string;
  kind: 'task' | 'chat';
  projectName?: string;
  projectId?: string;
  close: () => void;
  busy: boolean;
  submit: (body: any, draft: RunSetupDraft) => void;
  settings: (draft: RunSetupDraft) => void;
  initial?: RunSetupDraft;
  modelChoice: ModelChoice;
  contextPolicy: ContextPolicy;
  terminalTemplate?: AgentTerminalProfile;
  terminalConnections?: TerminalConnectionView[];
  beforeForm?: ReactNode;
  changed?: (draft: RunSetupDraft) => void;
  submitDisabled?: boolean;
}) {
  const { surface: localSurface } = useSurfaceClient();
  const executionKind = localSurface === 'terminal' ? 'docker-agent' : 'native';
  const edited = useRef(!!initial);
  const [defaultsBusy, setDefaultsBusy] = useState(false);
  const [appliedDefaults, setAppliedDefaults] = useState<NativeProjectDefaults>();
  const [expanded, setExpanded] = useState(false);
  const [deliverables, setDeliverables] = useState(initial?.deliverables ?? '');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(initial?.acceptanceCriteria ?? '');
  const [choice, setChoice] = useState<ModelChoice>(() => initial?.choice ?? modelChoice),
    [planMode, setPlanMode] = useState(initial?.planMode ?? true),
    [terminalProfile, setTerminalProfile] = useState<AgentTerminalProfile>(() =>
      structuredClone(initial?.terminalProfile ?? terminalTemplate ?? terminalPreset()),
    ),
    [modelReady, setModelReady] = useState(false),
    [context, setContext] = useState<ContextPolicy>(() => initial?.contextPolicy ?? contextPolicy),
    [write, setWrite] = useState(initial?.write ?? true),
    [exec, setExec] = useState(initial?.exec ?? true),
    [urls, setUrls] = useState(initial?.urls ?? ''),
    [inputs, setInputs] = useState(initial?.inputs ?? ''),
    [writePaths, setWritePaths] = useState(initial?.writePaths ?? '.'),
    [maxRequests, setMaxRequests] = useState(initial?.maxRequests ?? 80),
    [maxTokens, setMaxTokens] = useState(initial?.maxTokens ?? 500000),
    [maxCost, setMaxCost] = useState<number | null>(initial?.maxCost ?? null),
    [concurrency, setConcurrency] = useState(initial?.concurrency ?? 4);
  const selected = providers.find((p) => p.id === choice.providerId);
  const contextValid = validContextPolicy(
    context,
    selected ? minimumContextWindowTokens(selected) : 4096,
    selected?.contextLimit || 4096,
  );
  const chat = kind === 'chat';
  const terminal = !chat && executionKind === 'docker-agent';
  const lines = (s: string) =>
    s
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  const permissionsValid =
    chat ||
    terminal ||
    Permissions.safeParse({
      read: true,
      write,
      exec,
      urls: lines(urls),
      writePaths: lines(writePaths),
    }).success;
  const setupReady = terminal
    ? AgentTerminalProfile.safeParse(terminalProfile).success
    : modelReady &&
      contextValid &&
      permissionsValid &&
      Budget.safeParse({ maxRequests, maxTokens, maxCost }).success &&
      (chat || (concurrency >= 1 && concurrency <= 4 && Number.isInteger(concurrency)));
  const requirementsReady =
    chat || terminal || validRequirements(deliverables, acceptanceCriteria, !planMode);
  const compact = !chat && !terminal && !!appliedDefaults && setupReady && !expanded;
  const currentDraft: RunSetupDraft = {
    choice,
    planMode,
    executionKind,
    terminalProfile,
    contextPolicy: context,
    write,
    exec,
    urls,
    inputs,
    writePaths,
    maxRequests,
    maxTokens,
    maxCost,
    concurrency,
    deliverables,
    acceptanceCriteria,
  };
  const changedRef = useRef(changed);
  changedRef.current = changed;
  useEffect(() => {
    changedRef.current?.(currentDraft);
  }, [
    choice,
    planMode,
    terminalProfile,
    context,
    write,
    exec,
    urls,
    inputs,
    writePaths,
    maxRequests,
    maxTokens,
    maxCost,
    concurrency,
    deliverables,
    acceptanceCriteria,
  ]);
  const applyDefaults = (defaults: NativeProjectDefaults) => {
    setAppliedDefaults(defaults);
    if (edited.current) setExpanded(true);
    if (defaults.modelChoice) setChoice(defaults.modelChoice);
    if (defaults.contextPolicy) setContext(defaults.contextPolicy);
    setPlanMode(defaults.planMode);
    setMaxRequests(defaults.budget.maxRequests);
    setMaxTokens(defaults.budget.maxTokens);
    setMaxCost(defaults.budget.maxCost);
    setConcurrency(defaults.concurrency);
  };
  return (
    <Modal
      title={chat ? '新建独立对话' : '新建项目任务'}
      subtitle={(chat ? '归属：独立会话' : `归属：${projectName}`) + ' · ' + objective.slice(0, 80)}
      close={close}
      busy={busy || defaultsBusy}
    >
      <form
        onChangeCapture={() => {
          edited.current = true;
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (
            busy ||
            defaultsBusy ||
            submitDisabled ||
            !setupReady ||
            !requirementsReady ||
            !objective.trim() ||
            (localSurface === 'terminal' && chat)
          )
            return;
          edited.current = true;
          submit(
            {
              ...(terminal ? {} : { ...choice, contextPolicy: context }),
              planMode: terminal ? false : planMode,
              execution: terminal ? { kind: 'docker-agent', profile: terminalProfile } : { kind: 'native' },
              inputs: lines(inputs),
              ...(!chat && !terminal
                ? {
                    ...(requirementLines(deliverables).length
                      ? { deliverables: requirementLines(deliverables) }
                      : {}),
                    ...(requirementLines(acceptanceCriteria).length
                      ? { acceptanceCriteria: requirementLines(acceptanceCriteria) }
                      : {}),
                  }
                : {}),
              permissionProfile: chat
                ? { read: false, write: false, exec: false, urls: [], writePaths: [] }
                : terminal
                  ? { read: true, write: true, exec: true, urls: [], writePaths: ['.'] }
                  : { read: true, write, exec, urls: lines(urls), writePaths: lines(writePaths) },
              budget: { maxRequests, maxTokens, maxCost },
              limits: {
                maxDepth: chat ? 0 : 2,
                maxAgents: chat ? 1 : 12,
                concurrency: chat ? 1 : concurrency,
                toolConcurrency: 4,
                maxSteps: 20,
                maxMinutes: terminal ? Math.ceil(terminalProfile.timeoutMs / 60000) : 30,
              },
            },
            currentDraft,
          );
        }}
      >
        <div className="form-body">
          {beforeForm}
          {!permissionsValid && (
            <p className="field-error" role="alert">
              网页授权须为有效 URL，最多 40 项；请核对本次执行范围后创建。
            </p>
          )}
          {compact && appliedDefaults && (
            <RunConfirmation
              projectName={projectName}
              objective={objective}
              value={currentDraft}
              defaults={appliedDefaults}
              providerLabel={selected?.label}
              adjust={() => {
                edited.current = true;
                setExpanded(true);
              }}
              disabled={busy}
            />
          )}
          {!chat && !terminal && (
            <TaskRequirements
              deliverables={deliverables}
              criteria={acceptanceCriteria}
              required={!planMode}
              disabled={busy}
              change={(field, value) => {
                edited.current = true;
                if (field === 'deliverables') setDeliverables(value);
                else setAcceptanceCriteria(value);
              }}
            />
          )}
          <div hidden={compact}>
            {!chat && !terminal && projectId && (
              <NativeProjectDefaultsPanel
                projectId={projectId}
                value={{
                  modelChoice: choice,
                  contextPolicy: context,
                  planMode,
                  budget: { maxRequests, maxTokens, maxCost },
                  concurrency,
                }}
                canSave={!busy && setupReady}
                edited={() => edited.current || busy}
                apply={applyDefaults}
                activity={setDefaultsBusy}
              />
            )}
            <p className="field-help">
              {chat
                ? '选择会话模型后开始聊天。独立对话可使用技能说明；处理项目文件和生成附件时，在项目下新建任务。'
                : terminal
                  ? '确认终端配置后，在独立 Docker 任务目录中执行。'
                  : '确认模型、计划模式与授权范围。'}
            </p>
            {!chat && !terminal && (
              <>
                <label className="check-label">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="计划模式"
                    checked={planMode}
                    disabled={busy}
                    onChange={(e) => setPlanMode(e.target.checked)}
                  />
                  计划模式
                </label>
                <p className="field-help">
                  {planMode
                    ? '先生成计划，确认具体版本后执行。'
                    : '创建任务即授权在下方权限和预算内执行，仍需提供验收证据。'}
                </p>
              </>
            )}
            {terminal ? (
              <>
                <label>
                  API 连接
                  <select
                    aria-label="任务 API 连接"
                    value={
                      terminalProfile.connectionId === null
                        ? 'environment'
                        : terminalProfile.connectionId || ''
                    }
                    disabled={busy}
                    onChange={(event) => {
                      const { connection: _frozen, connectionId: _old, ...clean } = terminalProfile;
                      setTerminalProfile({
                        ...clean,
                        ...(event.target.value
                          ? { connectionId: event.target.value === 'environment' ? null : event.target.value }
                          : {}),
                      });
                    }}
                  >
                    <option value="">使用默认连接</option>
                    <option value="environment">仅使用模板环境变量</option>
                    {terminalConnections
                      .filter(
                        (connection) =>
                          terminalProfile.agent === 'custom' ||
                          (terminalProfile.agent === 'codex'
                            ? connection.protocol === 'openai-responses'
                            : terminalProfile.agent === 'gemini'
                              ? connection.protocol === 'gemini'
                              : connection.protocol === 'anthropic-messages'),
                      )
                      .map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.name} · {connection.model}
                        </option>
                      ))}
                  </select>
                </label>
                <p className="field-help">
                  连接在创建任务时固定。CLI 安装、API 连接和项目默认配置可在终端管理中调整。
                </p>
                <details>
                  <summary>终端参数</summary>
                  <TerminalSetup value={terminalProfile} change={setTerminalProfile} disabled={busy} />
                </details>
              </>
            ) : (
              <>
                <ModelPicker
                  providers={providers}
                  value={choice}
                  change={(next) => {
                    edited.current = true;
                    setChoice(next);
                  }}
                  ready={setModelReady}
                  disabled={busy}
                  label={chat ? '会话模型连接' : '总代理连接'}
                  preserveInvalid
                />
                <details className="context-compact-setup">
                  <summary>上下文窗口 · {context.mode === 'manual' ? '手动分配' : '托管'}</summary>
                  <ContextPolicyEditor
                    value={context}
                    change={(next) => {
                      edited.current = true;
                      setContext(next);
                    }}
                    minimumWindowTokens={selected ? minimumContextWindowTokens(selected) : 4096}
                    providerLimit={selected?.contextLimit || 4096}
                    disabled={busy || !selected}
                  />
                </details>
                {['chatgpt', 'codex'].includes(selected?.authMode || '') && (
                  <p className="field-help">
                    正在使用 ChatGPT 订阅 ·{' '}
                    <button type="button" className="text-button" disabled={busy} onClick={manageUsage}>
                      管理用量
                    </button>
                  </p>
                )}
                {(!selected?.keyConfigured || selected.checkedRevision !== selected.revision) && (
                  <div className="inline-warning">
                    请先连接并验证一个可用模型。
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (busy) return;
                        settings({
                          planMode,
                          executionKind,
                          terminalProfile,
                          choice,
                          contextPolicy: context,
                          write,
                          exec,
                          urls,
                          inputs,
                          writePaths,
                          maxRequests,
                          maxTokens,
                          maxCost,
                          concurrency,
                          deliverables,
                          acceptanceCriteria,
                        });
                      }}
                    >
                      前往模型设置
                    </button>
                  </div>
                )}
              </>
            )}
            {!chat && !terminal && (
              <>
                <label>
                  补充资料路径（可选，每行一项）
                  <textarea
                    value={inputs}
                    disabled={busy}
                    onChange={(e) => setInputs(e.target.value)}
                    placeholder="已可读取整个项目目录；可在此指定重点文件"
                    rows={2}
                  />
                </label>
                <details className="permission-card">
                  <summary>
                    执行范围 · 项目内读取{write ? ' · 任务目录写入' : ''}
                    {exec ? ' · 命令执行' : ''} · {lines(urls).length} 个网页
                  </summary>
                  <label className="check-label">
                    <input type="checkbox" checked readOnly disabled={busy} />
                    项目内读取
                  </label>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={write}
                      disabled={busy}
                      onChange={(e) => setWrite(e.target.checked)}
                    />
                    任务目录写入
                  </label>
                  {write && (
                    <label>
                      允许写入的相对目录
                      <textarea
                        rows={1}
                        value={writePaths}
                        disabled={busy}
                        onChange={(e) => setWritePaths(e.target.value)}
                      />
                    </label>
                  )}
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={exec}
                      disabled={busy}
                      onChange={(e) => setExec(e.target.checked)}
                    />
                    命令执行（当前系统用户权限）
                  </label>
                  <label>
                    授权网页 URL（每行一项）
                    <textarea
                      value={urls}
                      disabled={busy}
                      onChange={(e) => setUrls(e.target.value)}
                      rows={2}
                      placeholder="https://…"
                    />
                  </label>
                </details>
              </>
            )}
            {!terminal && (
              <div className="form-columns">
                <label>
                  模型请求上限
                  <input
                    type="number"
                    min={1}
                    max={80}
                    value={maxRequests}
                    disabled={busy}
                    onChange={(e) => setMaxRequests(Number(e.target.value))}
                  />
                </label>
                <label>
                  Token 上限
                  <input
                    type="number"
                    min={1000}
                    value={maxTokens}
                    disabled={busy}
                    onChange={(e) => setMaxTokens(Number(e.target.value))}
                  />
                </label>
                {maxCost !== null && (
                  <label>
                    费用预算
                    <input
                      aria-label="费用预算"
                      type="number"
                      min={0.000001}
                      step="any"
                      value={maxCost}
                      disabled={busy}
                      onChange={(event) => setMaxCost(event.target.value ? Number(event.target.value) : null)}
                    />
                    <span className="field-help">
                      价格未知时仍受请求与 Token 上限限制；清空可移除金额上限。
                    </span>
                  </label>
                )}
                {!chat && (
                  <label>
                    并发实例
                    <input
                      type="number"
                      min={1}
                      max={4}
                      value={concurrency}
                      disabled={busy}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                    />
                  </label>
                )}
              </div>
            )}
            <p className="field-help">
              {chat
                ? '普通回复后等待你继续。调用与 Token 按会话预算累计。'
                : terminal
                  ? '只映射独立任务目录；不会修改项目主目录或自动发布。'
                  : `${planMode ? '接受计划后' : '创建后'}执行。每次最多 12 个 Agent，递归深度 2，最长 30 分钟。`}
            </p>
          </div>
          {appliedDefaults && expanded && setupReady && (
            <button type="button" className="text-button" disabled={busy} onClick={() => setExpanded(false)}>
              返回配置确认
            </button>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy || defaultsBusy} onClick={close}>
            返回
          </button>
          <button
            className="primary"
            disabled={
              busy || defaultsBusy || submitDisabled || !setupReady || !requirementsReady || !objective.trim()
            }
          >
            {busy
              ? '正在创建…'
              : chat
                ? '开始对话'
                : terminal
                  ? '创建 Docker 任务'
                  : planMode
                    ? '生成约定与计划'
                    : '开始执行'}
            <Icon name="arrow" size={15} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
