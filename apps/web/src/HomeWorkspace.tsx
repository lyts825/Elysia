import { useRef } from 'react';
import type { Project, ProviderConfig, Run } from '../../../packages/contracts/src/index';
import { Icon } from './Icon';
import { EmptyArtwork, GardenAccent } from './Brand';
import './home.css';

const statusLabels: Record<string, string> = {
  DRAFT: '待开始',
  READY: '就绪',
  RUNNING: '执行中',
  WAITING: '等待中',
  VERIFYING: '待验收',
  DONE: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};
const starters = [
  {
    icon: 'code',
    title: '开发一个功能',
    description: '从实现计划到代码验证',
    prompt: '检查项目约定，拆解实现计划，修改代码并提供验证和差异。',
  },
  {
    icon: 'file',
    title: '整理一份报告',
    description: '阅读资料，形成可核对的结论',
    prompt: '阅读我指定的资料，整理一份有来源、可核对的 Markdown 报告。',
  },
  {
    icon: 'tree',
    title: '安排团队协作',
    description: '分解目标，跟进各个代理',
    prompt: '围绕我的目标制定有依赖和验收项的计划，分派任务并集成交付。',
  },
];
export function HomeWorkspace({
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
  start,
}: {
  projects: Project[];
  project?: Project;
  runs: Run[];
  providers: (ProviderConfig & { keyConfigured: boolean })[];
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  selectProject: (id: string) => void;
  selectRun: (run: Run) => void;
  openProject: () => void;
  openFiles: () => void;
  openSettings: () => void;
  start: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const available = providers.filter((p) => p.keyConfigured && p.checkedRevision === p.revision);
  const recent = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const active = runs.filter((r) => ['READY', 'RUNNING', 'WAITING', 'VERIFYING'].includes(r.status));
  return (
    <div className="welcome">
      <GardenAccent />
      <div className="welcome-content">
        <header className="home-heading">
          <div>
            <span className="eyebrow">
              <Icon name="spark" size={15} /> ELYSIA WORKSPACE
            </span>
            <h1>今天，想完成什么？</h1>
            <p className="welcome-subtitle">描述目标，模型会按需调用办公技能。过程可追踪，成果可预览。</p>
          </div>
          <button className="secondary" onClick={openProject}>
            <Icon name="folder" size={16} /> 打开文件夹
          </button>
        </header>
        <div className="home-grid">
          <div className="home-primary">
            <section className="composer" aria-label="创建任务">
              <div className="composer-title">
                <Icon name="chat" size={17} />
                <span>新任务</span>
                <span className="composer-shortcut">Ctrl + Enter 继续</span>
              </div>
              <textarea
                ref={input}
                aria-label="任务目标"
                placeholder="例如：整理这些资料，生成一份报告和汇总表格…"
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
                  {projects.length ? (
                    <label className="project-select">
                      <Icon name="folder" size={15} />
                      <select
                        aria-label="当前项目"
                        value={project?.id || ''}
                        onChange={(e) => selectProject(e.target.value)}
                      >
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <button className="context-button" onClick={openProject}>
                      <Icon name="folder" size={15} /> 选择项目
                    </button>
                  )}
                  <button
                    className="context-button model-context"
                    onClick={openSettings}
                    title="管理可用模型"
                  >
                    <span className={'status-dot ' + (available.length ? 'done' : 'waiting')} />
                    {available.length ? `${available.length} 个模型可用` : '连接模型'}
                  </button>
                </div>
                <button className="primary" disabled={!draft.trim() || busy} onClick={start}>
                  继续
                  <Icon name="arrow" size={16} />
                </button>
              </div>
            </section>
            <div className="suggestions" aria-label="任务灵感">
              {starters.map((item) => (
                <button
                  key={item.title}
                  onClick={() => {
                    setDraft(item.prompt);
                    input.current?.focus();
                  }}
                >
                  <span className="starter-icon">
                    <Icon name={item.icon} size={18} />
                  </span>
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                </button>
              ))}
            </div>
            <section className="recent-section" aria-label="最近任务">
              <div className="home-section-heading">
                <h2>最近任务</h2>
                <span>
                  {project?.name || '全部项目'} · {runs.length}
                </span>
              </div>
              {recent.length ? (
                <div className="recent-list">
                  {recent.map((run) => (
                    <button key={run.id} className="recent-row" onClick={() => selectRun(run)}>
                      <span className={'recent-icon ' + run.status.toLowerCase()}>
                        <Icon name={run.status === 'DONE' ? 'check' : 'chat'} size={18} />
                      </span>
                      <span className="recent-title">
                        <strong>{run.objective}</strong>
                        <small>
                          {new Date(run.createdAt).toLocaleString('zh-CN', {
                            month: 'long',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </small>
                      </span>
                      <span className={'badge ' + run.status.toLowerCase()}>
                        <i />
                        {statusLabels[run.status] || run.status}
                      </span>
                      <Icon name="arrow" size={16} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="recent-empty">
                  <EmptyArtwork kind="workspace" />
                  <div>
                    <strong>你的下一项成果，从这里开始</strong>
                    <p>创建任务后，可随时回来查看进度和交付。</p>
                  </div>
                </div>
              )}
            </section>
          </div>
          <aside className="home-context" aria-label="工作空间概览">
            <section className="context-card project-context">
              <div className="home-section-heading">
                <h2>当前项目</h2>
                <span className="directory-label">
                  {project?.baseline ? 'Git' : project ? '目录' : '未选择'}
                </span>
              </div>
              <span className="context-project-icon">
                <Icon name="folder" size={24} />
              </span>
              <h3>{project?.name || '连接你的本机项目'}</h3>
              <p className="context-path" title={project?.workspaceRoot}>
                {project?.workspaceRoot || '直接选择文件夹，开始处理代码或资料。'}
              </p>
              <button className="context-link" onClick={project ? openFiles : openProject}>
                {project ? '浏览项目文件' : '选择文件夹'}
                <Icon name="arrow" size={15} />
              </button>
            </section>
            <section className="context-card connection-context">
              <div className="home-section-heading">
                <h2>模型连接</h2>
                <Icon name="globe" size={17} />
              </div>
              {available.length ? (
                <>
                  <div className="connection-summary">
                    <span className="status-dot done" />
                    <strong>{available[0].label}</strong>
                  </div>
                  <p>{available[0].model}</p>
                  <small>
                    {available.length > 1
                      ? `另有 ${available.length - 1} 个已验证配置`
                      : '已通过实际调用验证'}
                  </small>
                </>
              ) : (
                <>
                  <h3>为任务连接一个模型</h3>
                  <p>使用 ChatGPT 订阅或 API Key。</p>
                  <small>连接验证后即可开始协作。</small>
                </>
              )}
              <button className="context-link" onClick={openSettings}>
                {available.length ? '管理模型与连接' : '前往连接'}
                <Icon name="arrow" size={15} />
              </button>
            </section>
            <div className="workspace-pulse">
              <span className="status-dot running" />
              <span>{active.length ? `${active.length} 项任务正在推进或等待处理` : '工作空间已就绪'}</span>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
