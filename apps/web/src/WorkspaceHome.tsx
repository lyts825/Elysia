import type { AgentTerminalProfile, Project } from '../../../packages/contracts/src/index';
import { useId, type ReactNode } from 'react';
import type { SelectableProvider } from './ModelPicker';
import type { ModelChoice } from './ModelPicker';
import { ComposerModelPicker } from './ComposerModelPicker';
import { Icon } from './Icon';
import './home.css';
import './workspace-home.css';

export function WorkspaceHome({
  project,
  providers,
  modelChoice,
  changeModel,
  modelReady,
  setModelReady,
  contextControl,
  contextReady,
  draft,
  setDraft,
  busy,
  openSettings,
  start,
  terminal = false,
  terminalProfiles = [],
  terminalProfileId = '',
  changeTerminalProfile,
  openProject,
}: {
  project?: Project;
  providers: SelectableProvider[];
  modelChoice: ModelChoice;
  changeModel: (choice: ModelChoice) => void;
  modelReady: boolean;
  setModelReady: (ready: boolean) => void;
  contextControl: ReactNode;
  contextReady: boolean;
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  openSettings: () => void;
  start: () => void;
  terminal?: boolean;
  terminalProfiles?: AgentTerminalProfile[];
  terminalProfileId?: string;
  changeTerminalProfile?: (id: string) => void;
  openProject?: () => void;
}) {
  const connected = providers.some((p) => p.keyConfigured && p.checkedRevision === p.revision);
  const selectedTerminal = terminalProfiles.find((profile) => profile.id === terminalProfileId);
  const selectedProvider = providers.find((provider) => provider.id === modelChoice.providerId);
  const id = useId();
  return (
    <div className="welcome workspace-home">
      <div className="welcome-content">
        <header className="home-heading">
          <h1>{project ? '新建任务' : terminal ? 'Agent 终端' : '新建对话'}</h1>
          <p>
            {project
              ? '在当前项目中，把想法变成成果。'
              : terminal
                ? '选择项目，让 DSH 或 Codex CLI 开始工作。'
                : '从一个想法开始，一起把它完成。'}
          </p>
          {project && (
            <p className="home-project-reading" role="region" aria-label="当前项目完整名称" tabIndex={0}>
              {project.name}
            </p>
          )}
        </header>
        {terminal && !project ? (
          <div className="terminal-start-empty">
            <button type="button" className="primary" disabled={busy} onClick={openProject}>
              <Icon name="folder" size={16} /> 打开项目
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={openSettings}>
              终端管理
            </button>
          </div>
        ) : (
          <section className="composer" aria-label={project ? '创建项目任务' : '创建独立对话'}>
            <label className="home-draft-label" htmlFor={`${id}-draft`}>
              {project ? '任务目标' : '对话内容'}
            </label>
            <textarea
              id={`${id}-draft`}
              rows={2}
              aria-label={project ? '任务目标' : '对话内容'}
              placeholder={project ? '描述你要完成的任务…' : '有什么想聊的？'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  (e.ctrlKey || e.metaKey) &&
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  draft.trim() &&
                  !busy &&
                  modelReady &&
                  contextReady &&
                  !project?.archived
                ) {
                  e.preventDefault();
                  start();
                }
              }}
            />
            <div className="composer-bottom">
              <div className="composer-options">
                {terminal ? (
                  <>
                    <label className="terminal-template-select">
                      <select
                        aria-label="Agent 终端模板"
                        value={terminalProfileId}
                        disabled={busy || !terminalProfiles.length}
                        onChange={(event) => changeTerminalProfile?.(event.target.value)}
                      >
                        {!terminalProfiles.length && <option value="">正在读取终端模板…</option>}
                        {terminalProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="终端管理"
                      disabled={busy}
                      onClick={openSettings}
                    >
                      <Icon name="settings" size={16} />
                    </button>
                  </>
                ) : (
                  <>
                    <ComposerModelPicker
                      providers={providers}
                      value={modelChoice}
                      change={changeModel}
                      ready={setModelReady}
                      disabled={busy}
                      settings={openSettings}
                    />
                    {contextControl}
                  </>
                )}
              </div>
              <div className="composer-actions">
                <span className="composer-shortcut" aria-hidden="true">
                  Ctrl + Enter
                </span>
                <button
                  className="primary"
                  disabled={!draft.trim() || busy || !modelReady || !contextReady || !!project?.archived}
                  onClick={start}
                  title={`${project ? '继续' : '发送'} · Ctrl + Enter`}
                >
                  {project ? '继续' : '发送'}
                  <Icon name={project ? 'arrow' : 'send'} size={16} />
                </button>
              </div>
            </div>
            {terminal && selectedTerminal && (
              <p
                className="home-terminal-template"
                role="region"
                aria-label="当前终端模板完整名称"
                tabIndex={0}
              >
                当前模板：{selectedTerminal.label}
              </p>
            )}
          </section>
        )}
        {!terminal && (
          <details className="home-current-model">
            <summary>当前模型完整信息</summary>
            <dl className="home-model-reading" role="region" aria-label="当前模型连接与型号" tabIndex={0}>
              <div>
                <dt>连接名称</dt>
                <dd>{selectedProvider?.label || '未选择模型连接'}</dd>
              </div>
              <div>
                <dt>连接标识</dt>
                <dd>{modelChoice.providerId || '未选择'}</dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{modelChoice.model || selectedProvider?.model || '未指定'}</dd>
              </div>
            </dl>
          </details>
        )}
        {project?.archived && (
          <p className="home-connection" role="status">
            项目已归档，当前不能创建任务。
          </p>
        )}
        {!terminal && connected && !modelReady && (
          <p className="home-connection" role="status">
            当前模型尚未就绪，请检查模型选择与连接。
          </p>
        )}
        {!terminal && !contextReady && (
          <p className="home-connection" role="status">
            当前窗口分配超出所选模型的范围，请调整上下文窗口。
          </p>
        )}
        {!terminal && !connected && (
          <div className="home-connection" role="status">
            <span>先连接一个模型，即可开始。</span>
            <button className="text-button" disabled={busy} onClick={openSettings}>
              连接模型
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
