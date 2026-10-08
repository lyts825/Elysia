import type { Project } from '../../../packages/contracts/src/index';
import type { SelectableProvider } from './ModelPicker';
import { Icon } from './Icon';
import './home.css';

export function WorkspaceHome({
  projects,
  project,
  providers,
  draft,
  setDraft,
  busy,
  selectProject,
  openSettings,
  start,
}: {
  projects: Project[];
  project?: Project;
  providers: SelectableProvider[];
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  selectProject: (id: string) => void;
  openSettings: () => void;
  start: () => void;
}) {
  const connected = providers.some((p) => p.keyConfigured && p.checkedRevision === p.revision);
  return (
    <div className="welcome">
      <div className="welcome-content">
        <header className="home-heading">
          <h1>{project ? '新建任务' : '新建对话'}</h1>
        </header>
        <section className="composer" aria-label={project ? '创建项目任务' : '创建独立对话'}>
          <textarea
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
                !project?.archived
              ) {
                e.preventDefault();
                start();
              }
            }}
          />
          <div className="composer-bottom">
            <label className="project-select">
              <Icon name={project ? 'folder' : 'chat'} size={15} />
              <select
                aria-label="会话归属"
                value={project?.id || ''}
                disabled={busy}
                onChange={(e) => selectProject(e.target.value)}
              >
                <option value="">独立对话</option>
                {projects
                  .filter((p) => !p.archived)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="composer-actions">
              <span className="composer-shortcut" aria-hidden="true">
                Ctrl + Enter
              </span>
              <button
                className="primary"
                disabled={!draft.trim() || busy || !!project?.archived}
                onClick={start}
                title="继续 · Ctrl + Enter"
              >
                继续
                <Icon name="arrow" size={16} />
              </button>
            </div>
          </div>
        </section>
        {!connected && (
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
