import { useRef } from 'react';
import type { Project, Run } from '../../../packages/contracts/src/index';
import type { SelectableProvider } from './ModelPicker';
import { GardenAccent, EmptyArtwork } from './Brand';
import { Icon } from './Icon';
import './home.css';

export function WorkspaceHome({
  projects,
  project,
  runs,
  providers,
  draft,
  setDraft,
  busy,
  selectProject,
  selectRun,
  openProject,
  openFiles,
  openSettings,
  manage,
  start,
}: {
  projects: Project[];
  project?: Project;
  runs: Run[];
  providers: SelectableProvider[];
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  selectProject: (id: string) => void;
  selectRun: (run: Run) => void;
  openProject: () => void;
  openFiles: () => void;
  openSettings: () => void;
  manage: () => void;
  start: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const available = providers.filter((p) => p.keyConfigured && p.checkedRevision === p.revision);
  const recent = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  return (
    <div className="welcome">
      <GardenAccent />
      <div className="welcome-content">
        <header className="home-heading">
          <div>
            <span className="eyebrow">
              <Icon name="spark" size={15} /> ELYSIA WORKSPACE
            </span>
            <h1>{project ? '在项目里推进一个目标' : '开始一段独立对话'}</h1>
            <p className="welcome-subtitle">
              {project
                ? `任务归属于「${project.name}」，模型按需选择技能，计划接受后执行。`
                : '会话保存在工作台，不绑定项目。需要处理项目资料时，可选择项目新建任务。'}
            </p>
          </div>
          <button className="secondary" onClick={openProject}>
            <Icon name="folder" size={16} /> 新建项目
          </button>
        </header>
        <div className="home-grid">
          <div className="home-primary">
            <section className="composer" aria-label={project ? '创建项目任务' : '创建独立对话'}>
              <div className="composer-title">
                <Icon name="chat" size={17} />
                <span>{project ? '项目任务' : '独立对话'}</span>
                <span className="composer-shortcut">Ctrl + Enter 继续</span>
              </div>
              <textarea
                ref={input}
                aria-label={project ? '任务目标' : '对话内容'}
                placeholder={project ? '描述任务目标、资料和预期交付…' : '写下想讨论的问题或内容…'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    (e.ctrlKey || e.metaKey) &&
                    e.key === 'Enter' &&
                    !e.nativeEvent.isComposing &&
                    draft.trim() &&
                    !busy
                  ) {
                    e.preventDefault();
                    start();
                  }
                }}
              />
              <div className="composer-bottom">
                <div className="composer-context">
                  <label className="project-select">
                    <Icon name={project ? 'folder' : 'chat'} size={15} />
                    <select
                      aria-label="会话归属"
                      value={project?.id || ''}
                      onChange={(e) => selectProject(e.target.value)}
                    >
                      <option value="">独立对话 · 不绑定项目</option>
                      {projects
                        .filter((p) => !p.archived)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} · 项目任务
                          </option>
                        ))}
                    </select>
                  </label>
                  <button className="context-button model-context" onClick={openSettings}>
                    <span className={'status-dot ' + (available.length ? 'done' : 'waiting')} />
                    {available.length ? `${available.length} 个连接可用` : '连接模型'}
                  </button>
                </div>
                <button
                  className="primary"
                  disabled={!draft.trim() || busy || !!project?.archived}
                  onClick={start}
                >
                  选择模型并继续
                  <Icon name="arrow" size={16} />
                </button>
              </div>
            </section>
            <div className="suggestions" aria-label="对话与任务灵感">
              {[
                ['file', '整理报告', '阅读指定资料，整理一份有来源、可核对的报告。'],
                ['tree', '规划任务', '围绕目标制定有依赖和验收项的计划，分派任务并集成交付。'],
                ['chat', '讨论思路', '帮我梳理思路，逐步明确问题和可行方案。'],
              ].map(([icon, title, prompt]) => (
                <button
                  key={title}
                  onClick={() => {
                    setDraft(prompt);
                    input.current?.focus();
                  }}
                >
                  <span className="starter-icon">
                    <Icon name={icon} size={18} />
                  </span>
                  <strong>{title}</strong>
                  <span>{prompt}</span>
                </button>
              ))}
            </div>
            <section className="recent-section" aria-label="最近对话">
              <div className="home-section-heading">
                <h2>{project ? '项目下的任务' : '独立对话'}</h2>
                <span>
                  {project?.name || '不绑定项目'} · {runs.length}
                </span>
              </div>
              {recent.length ? (
                <div className="recent-list">
                  {recent.map((run) => (
                    <button key={run.id} className="recent-row" onClick={() => selectRun(run)}>
                      <span className={'recent-icon ' + run.status.toLowerCase()}>
                        <Icon name={run.kind === 'chat' ? 'chat' : 'tree'} size={18} />
                      </span>
                      <span className="recent-title">
                        <strong>{run.title || run.objective}</strong>
                        <small>
                          {run.kind === 'chat'
                            ? '独立对话'
                            : `项目：${project?.name || projects.find((p) => p.id === run.projectId)?.name || '未找到项目'}`}{' '}
                          ·{' '}
                          {new Date(run.createdAt).toLocaleString('zh-CN', {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </small>
                      </span>
                      <Icon name="arrow" size={16} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="recent-empty">
                  <EmptyArtwork kind="workspace" />
                  <div>
                    <strong>{project ? '新建任务，归属清楚' : '第一段独立对话，从这里开始'}</strong>
                    <p>会话自动保存，可改名、归档、恢复或删除。</p>
                  </div>
                </div>
              )}
            </section>
          </div>
          <aside className="home-context" aria-label="工作空间概览">
            <section className="context-card project-context">
              <div className="home-section-heading">
                <h2>{project ? '当前项目' : '当前空间'}</h2>
                <span className="directory-label">
                  {project?.baseline ? 'Git' : project ? '目录' : '独立会话'}
                </span>
              </div>
              <span className="context-project-icon">
                <Icon name={project ? 'folder' : 'chat'} size={24} />
              </span>
              <h3>{project?.name || '个人对话'}</h3>
              <p className="context-path" title={project?.workspaceRoot}>
                {project?.workspaceRoot || '无需创建项目即可聊天。项目任务保留自己的归属与执行计划。'}
              </p>
              {project && (
                <button className="context-link" onClick={openFiles}>
                  浏览项目资料
                  <Icon name="arrow" size={15} />
                </button>
              )}
              <button className="context-link" onClick={manage}>
                管理项目、对话与归档
                <Icon name="arrow" size={15} />
              </button>
            </section>
            <section className="context-card connection-context">
              <div className="home-section-heading">
                <h2>模型选择</h2>
                <Icon name="globe" size={17} />
              </div>
              <h3>{available.length ? '按任务选择合适模型' : '连接订阅或 API'}</h3>
              <p>订阅连接提供账户可用模型目录。接受任务计划前，也可分别指定一级子代理的模型。</p>
              <button className="context-link" onClick={openSettings}>
                模型与连接设置
                <Icon name="arrow" size={15} />
              </button>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
