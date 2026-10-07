import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, mutation, initializeSession } from './api';
import { PreviewPanel } from './PreviewPanel';
import { ProjectFiles } from './ProjectFiles';
import { manageUsage } from './desktop';
import { VERSION } from '../../../packages/contracts/src/index';
import { isBinaryFile } from '../../../packages/contracts/src/files';
const ProviderSettings = React.lazy(() =>
  import('./ProviderSettings').then((module) => ({ default: module.ProviderSettings })),
);
import type {
  Run,
  Task,
  Project,
  ProjectSpace,
  Agent,
  Message,
  Artifact,
  RequestRecord,
  Operation,
  Contract,
  ProviderConfig,
} from '../../../packages/contracts/src/index';
import { Icon } from './Icon';
import { BrandIcon, EmptyArtwork } from './Brand';
import { Modal, ModalErrorContext } from './Modal';
import { WorkspaceHome } from './WorkspaceHome';
import { WorkspaceManager } from './WorkspaceManager';
import { ConversationScroll } from './ConversationScroll';
import { ModelPicker, defaultChoice, type ModelChoice } from './ModelPicker';
import { MotionContent, MotionTabs, Presence, usePositionMotion } from './Motion';
import './style.css';
import './motion.css';
type Detail = {
  run: Run;
  tasks: Task[];
  agents: Agent[];
  messages: Message[];
  artifacts: Artifact[];
  requests: RequestRecord[];
  operations: Operation[];
  events: any[];
  edges: { taskId: string; dependencyId: string }[];
};
type Provider = ProviderConfig & { keyConfigured: boolean };
const statuses: Record<string, string> = {
  DRAFT: '待开始',
  READY: '就绪',
  RUNNING: '执行中',
  WAITING: '等待',
  VERIFYING: '待验收',
  DONE: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};
const reasons: Record<string, string> = {
  subscription_limit: 'ChatGPT 订阅额度受限，请在模型设置中管理用量',
  plan: '等待接受计划',
  user: '等待你的回答',
  children: '等待子任务',
  paused: '已暂停',
  interrupted: '服务中断，等待恢复',
  verification: '副作用待核验',
  limit: '达到运行上限',
  rate_limit: '等待账号额度',
};
function Badge({ status }: { status: string }) {
  return (
    <span className={'badge ' + status.toLowerCase()}>
      <i />
      {statuses[status] || status}
    </span>
  );
}
function App() {
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [projects, setProjects] = useState<Project[]>([]),
    [spaces, setSpaces] = useState<ProjectSpace[]>([]),
    [spaceId, setSpaceId] = useState('default'),
    [runs, setRuns] = useState<Run[]>([]),
    [providers, setProviders] = useState<Provider[]>([]),
    [projectId, setProjectId] = useState(''),
    [runId, setRunId] = useState(''),
    [detail, setDetail] = useState<Detail | null>(null),
    [tab, setTab] = useState('tasks'),
    [previewOpen, setPreviewOpen] = useState(false),
    [previewTaskId, setPreviewTaskId] = useState(''),
    [modal, setModal] = useState(''),
    [artifactView, setArtifactView] = useState<{
      name: string;
      text: string | null;
      bytes: number;
      id: string;
    } | null>(null),
    [draft, setDraft] = useState(''),
    [replies, setReplies] = useState<Record<string, string>>({}),
    [streaming, setStreaming] = useState<Record<string, string>>({});
  const project = projects.find((p) => p.id === projectId);
  const projectRuns = runs.filter(
    (r) => !r.archived && (projectId ? r.projectId === projectId : r.kind === 'chat'),
  );
  const spaceProjects = projects.filter((p) => p.spaceId === spaceId && !p.archived);
  const isChat = detail?.run.kind === 'chat';
  const archived = !!detail?.run.archived || !!project?.archived;
  const [assignments, setAssignments] = useState<Record<string, ModelChoice>>({});
  const [assignmentReady, setAssignmentReady] = useState<Record<string, boolean>>({});
  const proposedChoice = (task: Task['spec']): ModelChoice => {
    const fallback = defaultChoice(providers, task.providerId);
    return {
      ...fallback,
      model: task.model ?? fallback.model,
      reasoningEffort: task.reasoningEffort ?? fallback.reasoningEffort,
    };
  };
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const mainMotion = usePositionMotion<HTMLElement>();
  const activeRunId = useRef('');
  const detailRequest = useRef(0);
  const actionPending = useRef(false);
  const reply = replies[runId] || '';
  const refresh = useCallback(async () => {
    const [p, r, v, s] = await Promise.all([
      api<Project[]>('/projects'),
      api<Run[]>('/runs'),
      api<Provider[]>('/providers'),
      api<ProjectSpace[]>('/spaces'),
    ]);
    setProjects(p);
    setRuns(r);
    setProviders(v);
    setSpaces(s);
    setSpaceId((old) =>
      s.some((item) => item.id === old) ? old : s.find((item) => item.protected)?.id || s[0]?.id || 'default',
    );
    setProjectId((old) => (p.some((item) => item.id === old) ? old : ''));
  }, []);
  const refreshDetail = useCallback(async () => {
    const wanted = activeRunId.current;
    if (!wanted) return;
    const request = ++detailRequest.current;
    const result = await api<Detail>('/runs/' + wanted);
    if (activeRunId.current === wanted && detailRequest.current === request)
      setDetail((old) => (old?.run.id === wanted && old.run.revision > result.run.revision ? old : result));
  }, []);
  useEffect(() => {
    initializeSession()
      .then(() => {
        setReady(true);
        return refresh();
      })
      .catch((e) => setError(e.message));
  }, [refresh]);
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [ready, refresh]);
  useEffect(() => {
    setDetail(null);
    setStreaming({});
    if (!ready || !runId) return;
    void refreshDetail().catch((e) => setError(e.message));
    const source = new EventSource('/api/runs/' + runId + '/events');
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reload = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = null;
          void refreshDetail().catch(() => {});
          void refresh().catch(() => {});
        }, 120);
    };
    const events = [
      'run.updated',
      'plan.proposed',
      'task.updated',
      'agent.started',
      'message.completed',
      'tool.started',
      'tool.completed',
      'decision.required',
      'artifact.created',
      'usage.updated',
      'error',
    ];
    for (const event of events)
      source.addEventListener(event, (e) => {
        if (event === 'message.completed') {
          const data = JSON.parse((e as MessageEvent).data);
          setStreaming((old) => ({ ...old, [data.taskId]: '' }));
        }
        reload();
      });
    source.addEventListener('message.delta', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setStreaming((old) => ({ ...old, [data.taskId]: (old[data.taskId] || '') + data.text }));
    });
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [ready, runId, refreshDetail, refresh]);
  useEffect(() => {
    setAssignments({});
    setAssignmentReady({});
  }, [detail?.run.id, detail?.run.plan?.version]);
  useEffect(() => setError(''), [modal]);
  async function act(fn: () => Promise<unknown>) {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      await refreshDetail();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }
  const sendReply = () => {
    if (!detail || busy || archived || !reply.trim() || ['DONE', 'CANCELLED'].includes(detail.run.status))
      return;
    const target = runId;
    const text = reply;
    const revision = detail.run.revision;
    void act(async () => {
      await mutation('/runs/' + target + '/messages', { expectedRevision: revision, text });
      setReplies((old) => (old[target] === text ? { ...old, [target]: '' } : old));
    });
  };
  const selectRun = (run: Run) => {
    activeRunId.current = run.id;
    setPreviewTaskId(run.rootTaskId);
    setRunId(run.id);
    setProjectId(run.projectId || '');
    const owner = projects.find((p) => p.id === run.projectId);
    if (owner) setSpaceId(owner.spaceId);
    setPreviewOpen(false);
    setTab(run.kind === 'chat' ? 'agents' : 'tasks');
  };
  const newRun = () => {
    activeRunId.current = '';
    setRunId('');
    setDetail(null);
    setPreviewOpen(false);
  };
  const selectProject = (id: string) => {
    setProjectId(id);
    const owner = projects.find((p) => p.id === id);
    if (owner) setSpaceId(owner.spaceId);
    newRun();
  };
  const managed = async (deleted?: { kind: 'project' | 'run' | 'space'; id: string }) => {
    if (
      (deleted?.kind === 'run' && deleted.id === runId) ||
      (deleted?.kind === 'project' && deleted.id === projectId)
    ) {
      newRun();
      if (deleted.kind === 'project') setProjectId('');
    } else if (runId) await refreshDetail();
    await refresh();
    if (deleted?.kind === 'run')
      setReplies((old) => {
        const next = { ...old };
        delete next[deleted.id];
        return next;
      });
    if (projectId && deleted?.kind === 'space') {
      const currentProjects = await api<Project[]>('/projects');
      const currentProject = currentProjects.find((item) => item.id === projectId);
      if (currentProject) setSpaceId(currentProject.spaceId);
    }
  };
  const totalTokens =
    detail?.requests.reduce((s, r) => s + (r.usage?.inputTotal ?? 0) + (r.usage?.outputTotal ?? 0), 0) || 0;
  const runAction = (action: string) =>
    act(() => mutation('/runs/' + runId + '/actions', { action, expectedRevision: detail!.run.revision }));
  async function openArtifact(a: Artifact) {
    await act(async () => {
      const response = await fetch('/api/artifacts/' + a.id);
      if (!response.ok) throw new Error('无法读取产物');
      const bytes = new Uint8Array(await response.arrayBuffer());
      setArtifactView({
        name: a.name,
        text: isBinaryFile(a.name, bytes) ? null : new TextDecoder().decode(bytes),
        bytes: bytes.length,
        id: a.id,
      });
    });
  }
  if (!ready)
    return (
      <div className="auth-screen">
        <BrandIcon />
        <h1>Elysia</h1>
        <p>{error || '正在连接本机工作台…'}</p>
        {error && (
          <div className="auth-help">
            请双击 <code>Start-Elysia.vbs</code> 重新打开独立工作台。
            <br />
            重新启动服务可获取新的链接。
          </div>
        )}
      </div>
    );
  return (
    <div className={'app-shell' + (sidebarCollapsed ? ' sidebar-collapsed' : '')}>
      <aside className="sidebar">
        <div className="brand">
          <BrandIcon />
          <span>
            Elysia<small>你的本机协作空间</small>
          </span>
        </div>
        <button
          className="new-task"
          onClick={() => selectProject('')}
          title="新建独立对话"
          aria-label="新建独立对话"
        >
          <Icon name="plus" />
          <span>新建独立对话</span>
        </button>
        <button
          className={'nav-item ' + (!runId ? 'selected' : '')}
          onClick={newRun}
          aria-current={!runId ? 'page' : undefined}
          aria-label="工作台"
          title="工作台"
        >
          <Icon name="grid" />
          <span>工作台</span>
        </button>
        <div className="space-selector">
          <label htmlFor="sidebar-space">项目空间</label>
          <div>
            <select
              id="sidebar-space"
              value={spaceId}
              onChange={(e) => {
                setSpaceId(e.target.value);
                setProjectId('');
                newRun();
              }}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              title="管理平级项目空间"
              aria-label="管理平级项目空间"
              onClick={() => setModal('manage:spaces')}
            >
              <Icon name="settings" size={15} />
            </button>
          </div>
        </div>
        <div className="side-heading">
          项目
          <button aria-label="添加项目" onClick={() => setModal('project')}>
            <Icon name="plus" size={15} />
          </button>
        </div>
        <nav className="project-list" aria-label="项目">
          {spaceProjects.map((p) => (
            <button
              className={'project-item ' + (p.id === projectId ? 'selected' : '')}
              key={p.id}
              title={p.name}
              aria-current={p.id === projectId ? 'true' : undefined}
              onClick={() => {
                selectProject(p.id);
              }}
            >
              <Icon name="folder" size={16} />
              <span>{p.name}</span>
              <small>{p.baseline ? 'Git' : '目录'}</small>
            </button>
          ))}
          {!spaceProjects.length && (
            <button className="empty-project" onClick={() => setModal('project')}>
              打开本机文件夹 <Icon name="plus" size={14} />
            </button>
          )}
        </nav>
        <div className="side-heading history-heading">
          {projectId ? '项目任务' : '独立对话'}
          <span>{projectRuns.length}</span>
        </div>
        <div className="history-list">
          {projectRuns.map((r) => (
            <button
              key={r.id}
              title={
                (r.title || r.objective) +
                ' · ' +
                (r.kind === 'chat' ? '独立对话' : project?.name || '项目任务')
              }
              aria-current={r.id === runId ? 'page' : undefined}
              className={'history-item ' + (r.id === runId ? 'selected' : '')}
              onClick={() => selectRun(r)}
            >
              <span className={'status-dot ' + r.status.toLowerCase()} />
              <span>
                {r.title || r.objective}
                <small>{r.kind === 'chat' ? '独立对话' : project?.name}</small>
              </span>
            </button>
          ))}
          {!projectRuns.length && (
            <p className="sidebar-muted">
              还没有{projectId ? '项目任务' : '独立对话'}。
              <br />
              从一个目标开始协作。
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            onClick={() => setModal('manage:archive')}
            title="项目、对话与归档"
            aria-label="项目、对话与归档"
          >
            <Icon name="history" />
            <span>项目、对话与归档</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setModal('settings')}
            aria-label="模型与设置"
            title="模型与设置"
          >
            <Icon name="settings" />
            <span>模型与设置</span>
          </button>
          <div className="local-indicator">
            <i />
            本机连接<span>v{VERSION}</span>
          </div>
        </div>
      </aside>
      <main className="main" ref={mainMotion.ref}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button sidebar-toggle"
              onClick={() => mainMotion.change(() => setSidebarCollapsed((collapsed) => !collapsed))}
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!sidebarCollapsed}
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            >
              <Icon name="panel" />
            </button>
            <Icon name="folder" size={16} />
            <span>{project?.name || '独立对话'}</span>
            <span className="slash">/</span>
            <strong title={detail?.run.objective}>
              {detail ? detail.run.title || detail.run.objective : '工作台'}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="local-chip port-chip" title={location.origin}>
              <Icon name="lock" size={12} />
              本机 · {location.port}
            </span>
            <button
              className="icon-button"
              onClick={() => void act(refresh)}
              title="刷新"
              aria-label="刷新工作台"
              disabled={busy}
            >
              <Icon name="refresh" size={16} />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError('')} aria-label="关闭错误">
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {!runId ? (
          <WorkspaceHome
            projects={projects}
            project={project}
            runs={projectRuns}
            providers={providers}
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            selectRun={selectRun}
            selectProject={selectProject}
            openProject={() => setModal('project')}
            openFiles={() => setModal('project-files')}
            openSettings={() => setModal('settings')}
            manage={() => setModal('manage:projects')}
            start={() => setModal('run')}
          />
        ) : detail ? (
          <>
            <div className="run-toolbar">
              <div>
                <Badge status={detail.run.status} />
                <span className="run-reason">
                  {(isChat && detail.run.reason === 'user'
                    ? '等待下一条消息'
                    : reasons[detail.run.reason || '']) ||
                    detail.run.reason ||
                    (detail.run.status === 'DONE'
                      ? '交付已完成，可查看产物与验证记录'
                      : '进度与结果自动保存')}
                </span>
              </div>
              <div className="run-controls">
                <button className="quiet-button" onClick={() => setModal('manage:runs')}>
                  <Icon name="history" size={14} />
                  管理对话
                </button>
                {!isChat && (
                  <>
                    <button
                      className="quiet-button preview-toggle"
                      aria-pressed={previewOpen}
                      onClick={() => setPreviewOpen(!previewOpen)}
                    >
                      <Icon name="code" size={14} />
                      {previewOpen ? '收起预览' : '打开预览'}
                    </button>
                    <button className="quiet-button" onClick={() => setModal('contract')}>
                      <Icon name="file" size={14} />
                      任务约定
                    </button>
                  </>
                )}
                {['READY', 'RUNNING'].includes(detail.run.status) ? (
                  <button
                    className="quiet-button"
                    disabled={busy || archived}
                    onClick={() => void runAction('pause')}
                  >
                    <Icon name="pause" size={14} />
                    暂停
                  </button>
                ) : (
                  !['DONE', 'CANCELLED'].includes(detail.run.status) && (
                    <button
                      className="quiet-button"
                      disabled={
                        busy ||
                        archived ||
                        detail.run.reason === 'plan' ||
                        detail.run.reason === 'verification' ||
                        detail.run.reason === 'user'
                      }
                      onClick={() => void runAction('resume')}
                    >
                      <Icon name="play" size={14} />
                      恢复
                    </button>
                  )
                )}
                {!['DONE', 'CANCELLED'].includes(detail.run.status) && (
                  <button
                    className="quiet-button danger"
                    disabled={busy || archived}
                    onClick={() => void runAction('cancel')}
                  >
                    <Icon name="stop" size={14} />
                    取消
                  </button>
                )}
              </div>
            </div>
            <div
              key={detail.run.id}
              className={'run-layout' + (previewOpen ? ' preview-open' : '') + (isChat ? ' chat-layout' : '')}
            >
              <section className="conversation">
                <ConversationScroll>
                  {!isChat && (
                    <div className="user-message">
                      <div className="message-avatar user">你</div>
                      <div>
                        <span className="message-label">
                          {isChat ? '独立对话 · 你' : `任务目标 · ${project?.name || '项目'}`}
                        </span>
                        <p>{detail.run.objective}</p>
                      </div>
                    </div>
                  )}
                  {archived && (
                    <div className="system-note archive-note">
                      <Icon name="history" size={14} />
                      <span>
                        {project?.archived
                          ? '所属项目已归档，恢复项目后可继续。'
                          : '对话已归档，恢复后可继续。'}
                      </span>
                      <button className="text-button" onClick={() => setModal('manage:archive')}>
                        查看归档
                      </button>
                    </div>
                  )}
                  {!isChat && (
                    <div className="system-note">
                      <Icon name="lock" size={14} />
                      <span>
                        授权：读取{detail.run.contract.permissionProfile.write ? ' · 指定目录写入' : ''}
                        {detail.run.contract.permissionProfile.exec ? ' · 命令执行' : ''} ·{' '}
                        {detail.run.contract.permissionProfile.urls.length} 个网页来源。
                        {!detail.run.acceptedPlanVersion && '计划接受后开始执行。'}
                      </span>
                    </div>
                  )}
                  {detail.messages
                    .filter((m) => m.role !== 'tool')
                    .map((m) => {
                      const agent = detail.agents.find((a) => a.sessionId === m.sessionId);
                      const task = detail.tasks.find((t) => t.id === agent?.taskId);
                      return (
                        <div className={'message ' + m.role} key={m.id}>
                          <div className={'message-avatar ' + m.role}>
                            {m.role === 'user' ? (
                              '你'
                            ) : (
                              <Icon name={task?.spec.role === 'coordinator' ? 'spark' : 'tree'} size={17} />
                            )}
                          </div>
                          <div className="message-body">
                            <div className="message-label">
                              {m.role === 'user'
                                ? isChat
                                  ? '你'
                                  : '用户 / 交接'
                                : task?.spec.role === 'coordinator'
                                  ? isChat
                                    ? '助手'
                                    : '总代理'
                                  : task?.spec.title || 'Agent'}
                              <small>{m.role === 'assistant' ? agent?.providerBinding.model : ''}</small>
                            </div>
                            {m.text && <p>{m.text}</p>}
                            {m.calls?.map((c) => (
                              <div className="tool-chip" key={c.id}>
                                <Icon name="code" size={12} />
                                {c.name}
                                <span>
                                  {detail.operations.find((o) => o.toolCallId === c.id)?.status === 'DONE'
                                    ? '已记录'
                                    : '处理中'}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  {Object.entries(streaming)
                    .filter(([, value]) => value)
                    .map(([taskId, value]) => (
                      <div className="message assistant" key={taskId}>
                        <div className="message-avatar assistant">
                          <Icon name="spark" size={17} />
                        </div>
                        <div className="message-body">
                          <div className="message-label">
                            正在生成
                            <span className="typing-dot" />
                          </div>
                          <p>{value}</p>
                        </div>
                      </div>
                    ))}
                  {detail.events
                    .filter(
                      (e) =>
                        e.type === 'decision.required' &&
                        e.payload.questions &&
                        detail.tasks.some(
                          (t) =>
                            t.id === e.payload.taskId && t.status === 'WAITING' && t.waitReason === 'user',
                        ),
                    )
                    .slice(-1)
                    .map((e) => (
                      <div className="question-card" key={e.eventId}>
                        <span className="eyebrow">需要你的输入</span>
                        {e.payload.questions.map((q: string, i: number) => (
                          <p key={i}>
                            {i + 1}. {q}
                          </p>
                        ))}
                      </div>
                    ))}
                  {detail.run.plan && (
                    <div className="plan-card">
                      <div className="plan-card-head">
                        <div>
                          <span className="eyebrow">EXECUTION PLAN · V{detail.run.plan.version}</span>
                          <h3>团队的执行计划</h3>
                        </div>
                        <span className="plan-count">{detail.run.plan.tasks.length} 个子任务</span>
                      </div>
                      <p>{detail.run.plan.summary}</p>
                      {detail.run.plan.tasks.map((t, i) => (
                        <div className="plan-row" key={t.key}>
                          <span className="step-number">{String(i + 1).padStart(2, '0')}</span>
                          <div>
                            <strong>{t.title}</strong>
                            <p>{t.objective}</p>
                            <small>
                              {t.providerId}
                              {t.model ? ' · ' + t.model : ''}
                              {t.reasoningEffort ? ' · ' + t.reasoningEffort : ''}{' '}
                              {t.dependsOn.length ? '· 依赖 ' + t.dependsOn.join(', ') : ''}
                            </small>
                            {detail.run.reason === 'plan' && (
                              <ModelPicker
                                providers={providers}
                                label={`一级子代理 ${i + 1} · ${t.title}`}
                                value={assignments[t.key] || proposedChoice(t)}
                                disabled={busy || archived}
                                change={(choice) => setAssignments((old) => ({ ...old, [t.key]: choice }))}
                                ready={(valid) =>
                                  setAssignmentReady((old) =>
                                    old[t.key] === valid ? old : { ...old, [t.key]: valid },
                                  )
                                }
                              />
                            )}
                          </div>
                        </div>
                      ))}
                      <div className="plan-footer">
                        <span>
                          <Icon name="lock" size={13} />
                          {detail.run.authorized ? '执行范围已接受' : '接受这个版本后执行'}
                        </span>
                        {detail.run.reason === 'plan' && (
                          <button
                            className="primary"
                            disabled={
                              busy || archived || detail.run.plan.tasks.some((t) => !assignmentReady[t.key])
                            }
                            onClick={() =>
                              void act(() =>
                                mutation('/runs/' + runId + '/plan/accept', {
                                  expectedRevision: detail.run.revision,
                                  version: detail.run.plan!.version,
                                  assignments: detail.run.plan!.tasks.map((task) => ({
                                    key: task.key,
                                    ...(assignments[task.key] || proposedChoice(task)),
                                  })),
                                }),
                              )
                            }
                          >
                            接受并开始
                            <Icon name="play" size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {!isChat && detail.run.status === 'DONE' && (
                    <div className="delivery-card">
                      <Icon name="check" size={24} />
                      <div>
                        <h3>交付已通过证据核验</h3>
                        <p>查看右侧产物和差异，复核内容是否符合你的目标。</p>
                      </div>
                    </div>
                  )}
                </ConversationScroll>
                {['DONE', 'CANCELLED'].includes(detail.run.status) ? (
                  <div className="conversation-ended">
                    <Icon name={detail.run.status === 'DONE' ? 'check' : 'stop'} size={18} />
                    <span>
                      {isChat
                        ? '本次对话已结束'
                        : detail.run.status === 'DONE'
                          ? '本次任务已完成'
                          : '本次任务已取消'}
                    </span>
                    <button
                      className="secondary"
                      onClick={() => {
                        if (isChat) {
                          selectProject('');
                          return;
                        }
                        setPreviewOpen(false);
                        setTab('artifacts');
                      }}
                    >
                      {isChat ? '新建独立对话' : '查看产物'}
                      <Icon name="arrow" size={14} />
                    </button>
                  </div>
                ) : (
                  <form
                    className="reply-box"
                    onSubmit={(e) => {
                      e.preventDefault();
                      sendReply();
                    }}
                  >
                    <textarea
                      aria-label="回复或补充需求"
                      value={reply}
                      onChange={(e) => setReplies((old) => ({ ...old, [runId]: e.target.value }))}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          sendReply();
                        }
                      }}
                      placeholder={
                        archived ? '恢复归档后可继续对话' : isChat ? '继续对话…' : '回答问题，或补充需求…'
                      }
                      disabled={archived || ['DONE', 'CANCELLED'].includes(detail.run.status)}
                    />
                    <div>
                      <span>
                        {busy
                          ? '正在提交…'
                          : archived
                            ? '已归档，保留全部对话记录'
                            : isChat
                              ? 'Ctrl + Enter 发送 · 独立会话自动保存'
                              : 'Ctrl + Enter 发送 · 补充需求在安全边界应用'}
                      </span>
                      <button
                        className="send-button"
                        aria-label="发送补充需求"
                        disabled={
                          archived ||
                          !reply.trim() ||
                          busy ||
                          ['DONE', 'CANCELLED'].includes(detail.run.status)
                        }
                      >
                        <Icon name="send" size={17} />
                      </button>
                    </div>
                  </form>
                )}
              </section>
              <Presence>
                {previewOpen && (
                  <PreviewPanel
                    runId={runId}
                    tasks={detail.tasks}
                    agents={detail.agents}
                    messages={detail.messages}
                    operations={detail.operations}
                    artifacts={detail.artifacts}
                    streaming={streaming}
                    selectedTaskId={previewTaskId}
                    selectTask={setPreviewTaskId}
                    close={() => setPreviewOpen(false)}
                  />
                )}
              </Presence>
              {!previewOpen && (
                <aside className="details-panel">
                  <MotionTabs className="detail-tabs" label="任务详情" value={tab}>
                    {(isChat
                      ? [
                          { key: 'agents', icon: 'chat', title: '模型' },
                          { key: 'usage', icon: 'chart', title: '用量' },
                        ]
                      : [
                          { key: 'tasks', icon: 'grid', title: '任务' },
                          { key: 'agents', icon: 'tree', title: '代理' },
                          { key: 'artifacts', icon: 'file', title: '产物' },
                          { key: 'usage', icon: 'chart', title: '用量' },
                        ]
                    ).map((t) => (
                      <button
                        key={t.key}
                        className={tab === t.key ? 'active' : ''}
                        aria-pressed={tab === t.key}
                        onClick={() => setTab(t.key)}
                      >
                        <Icon name={t.icon} size={15} />
                        {t.title}
                      </button>
                    ))}
                  </MotionTabs>
                  <MotionContent className="detail-content" motionKey={tab}>
                    {tab === 'tasks' && (
                      <>
                        <div className="panel-heading">
                          <h3>执行拓扑</h3>
                          <span>
                            {detail.tasks.filter((t) => t.status === 'DONE').length}/{detail.tasks.length}{' '}
                            完成
                          </span>
                        </div>
                        <TaskGraph detail={detail} />
                        <div className="panel-heading">
                          <h3>任务列表</h3>
                          <span>按任务查看进度与结果</span>
                        </div>
                        {detail.tasks.map((t) => (
                          <div className="task-detail" key={t.id}>
                            <div>
                              <strong>{t.spec.title}</strong>
                              <Badge status={t.status} />
                            </div>
                            <p>{t.waitReason ? reasons[t.waitReason] || t.waitReason : t.spec.objective}</p>
                            <small>
                              {t.spec.providerId} · 深度 {t.depth}
                            </small>
                            {t.baseline && <code title={t.baseline}>基线 {t.baseline.slice(0, 10)}</code>}
                            <button
                              className="agent-preview-button"
                              onClick={() => {
                                setPreviewTaskId(t.id);
                                setPreviewOpen(true);
                              }}
                            >
                              预览此代理的工作 ↗
                            </button>
                            {t.workspace && (
                              <p className="path-text" title={t.workspace}>
                                {t.workspace}
                              </p>
                            )}
                            {Boolean(t.result) && (
                              <details>
                                <summary>查看结果</summary>
                                <pre>{JSON.stringify(t.result, null, 2)}</pre>
                              </details>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                    {tab === 'agents' && (
                      <>
                        <div className="panel-heading">
                          <h3>{isChat ? '会话模型' : '代理责任树'}</h3>
                          <span>
                            {detail.agents.length}/{detail.run.limits.maxAgents}
                          </span>
                        </div>
                        {detail.agents.map((a) => {
                          const task = detail.tasks.find((t) => t.id === a.taskId);
                          return (
                            <div
                              className="agent-card"
                              key={a.id}
                              style={{ marginLeft: (task?.depth || 0) * 14 }}
                            >
                              <div className="agent-avatar">
                                <Icon name={task?.spec.role === 'coordinator' ? 'spark' : 'tree'} size={18} />
                              </div>
                              <div>
                                <strong>
                                  {task?.spec.role === 'coordinator'
                                    ? isChat
                                      ? '助手'
                                      : '总代理'
                                    : task?.spec.title}
                                </strong>
                                <p>
                                  {a.providerBinding.label} · {a.providerBinding.model}
                                </p>
                                <small>独立会话 {a.sessionId.slice(0, 8)}</small>
                                {!isChat && (
                                  <button
                                    className="agent-preview-button"
                                    onClick={() => {
                                      setPreviewTaskId(a.taskId);
                                      setPreviewOpen(true);
                                    }}
                                  >
                                    查看工作预览 ↗
                                  </button>
                                )}
                              </div>
                              <span className={'status-dot ' + a.status.toLowerCase()} />
                            </div>
                          );
                        })}
                        <div className="info-note">
                          {isChat
                            ? '独立会话不绑定项目；后续回复使用当前会话模型。'
                            : '每个实例独立保存会话、工具操作和工作目录。'}
                          账号共享并发与速率额度。
                        </div>
                      </>
                    )}
                    {tab === 'artifacts' && (
                      <>
                        <div className="panel-heading">
                          <h3>版本化产物</h3>
                          <span>{detail.artifacts.length} 个</span>
                        </div>
                        {detail.artifacts.map((a) => (
                          <button className="artifact-card" key={a.id} onClick={() => void openArtifact(a)}>
                            <span className="artifact-icon">
                              <Icon name={a.name.endsWith('.diff') ? 'code' : 'file'} size={21} />
                            </span>
                            <div>
                              <strong>{a.name}</strong>
                              <p>
                                v{a.version} · {a.verified ? '证据已核验' : '待验收'}
                              </p>
                              <small>SHA256 {a.hash.slice(0, 12)}</small>
                            </div>
                            <Icon name="arrow" size={14} />
                          </button>
                        ))}
                        {!detail.artifacts.length && (
                          <Empty title="产物将在这里交付" text="报告、附件和 Git diff 会保留版本与来源。" />
                        )}
                        <div className="panel-heading">
                          <h3>待核验操作</h3>
                        </div>
                        {detail.operations
                          .filter((o) => o.status === 'UNCERTAIN')
                          .map((o) => (
                            <div className="decision-card" key={o.id}>
                              <strong>{o.name}</strong>
                              <p>{o.error || '操作 intent 已记录，结果未确定。请核验本机证据。'}</p>
                              <pre>{JSON.stringify(o.evidence || o.args, null, 2)}</pre>
                              <button className="secondary" onClick={() => setModal('decision:' + o.id)}>
                                提交核验决定
                              </button>
                            </div>
                          ))}
                        {!detail.operations.some((o) => o.status === 'UNCERTAIN') && (
                          <p className="muted small">当前没有待核验副作用</p>
                        )}
                      </>
                    )}
                    {tab === 'usage' && <UsagePanel detail={detail} totalTokens={totalTokens} />}
                  </MotionContent>
                  <div className="panel-bottom">
                    <Icon name="history" size={13} />
                    任务记录自动保存在本机
                  </div>
                </aside>
              )}
            </div>
          </>
        ) : (
          <div className="loading">正在读取任务…</div>
        )}
      </main>
      <ModalErrorContext.Provider value={error}>
        <Presence>
          {modal ? (
            <React.Fragment key={modal}>
              {modal === 'project' && (
                <ProjectModal
                  spaces={spaces}
                  projects={projects}
                  initialSpaceId={spaceId}
                  close={() => setModal('')}
                  busy={busy}
                  submit={(body) =>
                    act(async () => {
                      const p = await mutation<Project>('/projects', body);
                      selectProject(p.id);
                      setSpaceId(p.spaceId);
                      setModal('');
                    })
                  }
                />
              )}
              {modal === 'project-files' && project && (
                <Modal title={project.name} subtitle={project.workspaceRoot} close={() => setModal('')} wide>
                  <ProjectFiles projectId={project.id} />
                </Modal>
              )}
              {modal.startsWith('manage:') && (
                <WorkspaceManager
                  spaces={spaces}
                  projects={projects}
                  runs={runs}
                  initial={modal.slice(7)}
                  close={() => setModal('')}
                  updated={managed}
                  selectRun={selectRun}
                />
              )}
              {modal === 'run' && (
                <RunModal
                  objective={draft}
                  kind={project ? 'task' : 'chat'}
                  projectName={project?.name}
                  providers={providers}
                  close={() => setModal('')}
                  busy={busy}
                  submit={(body) =>
                    act(async () => {
                      const run = await mutation<Run>('/runs', {
                        ...body,
                        objective: draft,
                        kind: project ? 'task' : 'chat',
                        projectId: projectId || null,
                      });
                      selectRun(run);
                      setDraft('');
                      setModal('');
                    })
                  }
                  settings={() => setModal('settings')}
                />
              )}
              {modal === 'settings' && (
                <React.Suspense
                  fallback={
                    <Modal title="模型与连接" close={() => setModal('')}>
                      <div className="form-body" role="status">
                        正在加载模型设置…
                      </div>
                    </Modal>
                  }
                >
                  <ProviderSettings providers={providers} close={() => setModal('')} updated={refresh} />
                </React.Suspense>
              )}
              {modal === 'contract' && detail && (
                <ContractModal
                  contract={detail.run.contract}
                  close={() => setModal('')}
                  busy={busy}
                  disabled={archived || ['DONE', 'CANCELLED'].includes(detail.run.status)}
                  submit={(contract) =>
                    act(async () => {
                      await mutation('/runs/' + runId + '/messages', {
                        expectedRevision: detail.run.revision,
                        contract,
                        text: '我已修改任务约定，请根据约定重新提出计划。',
                      });
                      setModal('');
                    })
                  }
                />
              )}
              {modal.startsWith('decision:') && detail && (
                <DecisionModal
                  operation={detail.operations.find((o) => o.id === modal.slice(9))!}
                  close={() => setModal('')}
                  busy={busy}
                  submit={(body) =>
                    act(async () => {
                      await mutation('/runs/' + runId + '/decisions', {
                        ...body,
                        expectedRevision: detail.run.revision,
                      });
                      setModal('');
                    })
                  }
                />
              )}
            </React.Fragment>
          ) : null}
        </Presence>
      </ModalErrorContext.Provider>
      <Presence>
        {artifactView && (
          <Modal
            title={artifactView.name}
            subtitle="已登记产物 · 内容哈希由服务端核对"
            close={() => setArtifactView(null)}
            wide
          >
            <div className="artifact-preview">
              {artifactView.text === null ? (
                <p>
                  已登记附件（{Math.max(1, Math.ceil(artifactView.bytes / 1024))}{' '}
                  KiB），下载后使用对应应用打开。
                </p>
              ) : (
                <pre>{artifactView.text}</pre>
              )}
            </div>
            <footer className="modal-footer">
              <a className="secondary" href={'/api/artifacts/' + artifactView.id} download>
                下载产物
              </a>
              <button className="primary" onClick={() => setArtifactView(null)}>
                完成
              </button>
            </footer>
          </Modal>
        )}
      </Presence>
    </div>
  );
}
function Empty({
  kind = 'delivery',
  title,
  text,
}: {
  kind?: 'workspace' | 'delivery';
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <EmptyArtwork kind={kind} />
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
function TaskGraph({ detail }: { detail: Detail }) {
  const tasks = detail.tasks.filter((t) => t.parentTaskId);
  const ranks = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++)
    for (const t of tasks) {
      const deps = detail.edges.filter((e) => e.taskId === t.id).map((e) => e.dependencyId);
      ranks.set(t.id, deps.length ? Math.max(...deps.map((d) => ranks.get(d) || 0)) + 1 : 0);
    }
  return (
    <div className="task-graph">
      <div className="graph-root">
        <Icon name="spark" size={15} />
        总代理 · 集成与验收
      </div>
      {!tasks.length ? (
        <div className="graph-single">单 Agent 执行</div>
      ) : (
        [...new Set(ranks.values())]
          .sort((a, b) => a - b)
          .map((rank) => (
            <div className="graph-level" key={rank}>
              <span className="graph-rank">阶段 {rank + 1}</span>
              {tasks
                .filter((t) => ranks.get(t.id) === rank)
                .map((t) => (
                  <div className="graph-node" key={t.id}>
                    <span className={'status-dot ' + t.status.toLowerCase()} />
                    <span>{t.spec.title}</span>
                    <small>
                      {detail.edges
                        .filter((e) => e.taskId === t.id)
                        .map((e) => detail.tasks.find((t) => t.id === e.dependencyId)?.spec.key)
                        .join(' → ')}
                    </small>
                  </div>
                ))}
            </div>
          ))
      )}
      <small className="graph-caption">任务按依赖顺序推进</small>
    </div>
  );
}
function UsagePanel({ detail, totalTokens }: { detail: Detail; totalTokens: number }) {
  const settled = detail.requests.filter((r) => r.status === 'SETTLED'),
    unknown = detail.requests.filter((r) => r.status === 'UNKNOWN');
  const totalCostKnown = settled.length && settled.every((r) => r.usage?.cost !== null);
  const costs = settled.reduce((sum, r) => sum + (r.usage?.cost || 0), 0);
  return (
    <>
      <div className="panel-heading">
        <h3>调用与预算</h3>
        <span>按 requestId 去重</span>
      </div>
      <div className="metric-grid">
        <div>
          <span>模型请求</span>
          <strong>
            {detail.requests.length}
            <small> / {detail.run.contract.budget.maxRequests}</small>
          </strong>
        </div>
        <div>
          <span>实际 Token</span>
          <strong>{totalTokens.toLocaleString()}</strong>
        </div>
        <div>
          <span>已知成本</span>
          <strong>{totalCostKnown ? costs.toFixed(4) : '—'}</strong>
        </div>
        <div>
          <span>待核验调用</span>
          <strong>{unknown.length}</strong>
        </div>
      </div>
      <div className="budget-bar">
        <i
          style={{
            transform: `scaleX(${Math.min(1, detail.requests.length / detail.run.contract.budget.maxRequests)})`,
          }}
        />
      </div>
      <div className="panel-heading">
        <h3>厂商缓存观测</h3>
      </div>
      {[...new Set(detail.requests.map((r) => r.providerId))].map((providerId) => {
        const rows = detail.requests.filter((r) => r.providerId === providerId && r.usage),
          cacheKnown = rows.length && rows.every((r) => r.usage?.cacheRead !== null),
          input = rows.reduce((s, r) => s + (r.usage?.inputTotal || 0), 0),
          cache = rows.reduce((s, r) => s + (r.usage?.cacheRead || 0), 0),
          ttft = rows.map((r) => r.usage?.ttftMs).filter((n): n is number => typeof n === 'number');
        return (
          <div className="cache-card" key={providerId}>
            <div>
              <strong>{providerId}</strong>
              <span>{cacheKnown && input ? Math.round((cache / input) * 100) + '% 命中' : '待观测'}</span>
            </div>
            <p>
              读取 {cacheKnown ? cache.toLocaleString() : '—'} / 输入 {input.toLocaleString()} Token
            </p>
            <small>
              平均首字 {ttft.length ? Math.round(ttft.reduce((a, b) => a + b, 0) / ttft.length) + ' ms' : '—'}
            </small>
          </div>
        );
      })}
      {!detail.requests.length && (
        <Empty kind="workspace" title="等待真实调用" text="使用供应商返回的 usage；缺失指标显示为未知。" />
      )}
      <div className="info-note">
        资料快照复用、厂商 Prompt 缓存和会话续接分别记录。未返回用量的请求保留预算预留；成本需要有效价格配置。
      </div>
      {detail.agents.some((a) => ['chatgpt', 'codex'].includes(a.providerBinding.authMode || '')) && (
        <div className="info-note">
          此任务使用 ChatGPT 订阅；API 单价不适用于订阅调用。
          <button className="text-button" onClick={manageUsage}>
            管理 ChatGPT 用量
          </button>
        </div>
      )}
      <div className="panel-heading">
        <h3>请求清单</h3>
      </div>
      {detail.requests.map((r) => (
        <details className="request-detail" key={r.id}>
          <summary>
            <span>{r.providerBinding.model}</span>
            <small>{r.status}</small>
          </summary>
          <pre>
            {JSON.stringify(
              { requestId: r.id, manifest: r.manifest, usage: r.usage, error: r.error },
              null,
              2,
            )}
          </pre>
        </details>
      ))}
    </>
  );
}
function ProjectModal({
  spaces,
  projects,
  initialSpaceId,
  close,
  busy,
  submit,
}: {
  spaces: ProjectSpace[];
  projects: Project[];
  initialSpaceId: string;
  close: () => void;
  busy: boolean;
  submit: (body: any) => void;
}) {
  const [name, setName] = useState(''),
    [root, setRoot] = useState(''),
    [baseline, setBaseline] = useState('HEAD'),
    [spaceId, setSpaceId] = useState(initialSpaceId);
  const [folder, setFolder] = useState<any>(),
    [inspecting, setInspecting] = useState(false),
    [error, setError] = useState('');
  const existing = projects.find(
    (item) =>
      item.spaceId === spaceId && item.workspaceRoot.toLowerCase() === folder?.workspaceRoot?.toLowerCase(),
  );
  const inspect = async (directory: string) => {
    setInspecting(true);
    setError('');
    setFolder(undefined);
    try {
      const info = await mutation('/projects/inspect', { workspaceRoot: directory });
      setRoot(info.workspaceRoot);
      setName(info.name.slice(0, 80));
      setBaseline('HEAD');
      setFolder(info);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInspecting(false);
    }
  };
  return (
    <Modal
      title="新建项目"
      subtitle="选择资料目录与所属项目空间，再在项目下新建任务"
      close={close}
      busy={busy || inspecting}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit({ name, workspaceRoot: root, spaceId, ...(folder?.gitAvailable ? { baseline } : {}) });
        }}
      >
        <div className="form-body">
          <label>
            所属项目空间
            <select aria-label="新项目所属空间" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="folder-picker"
            disabled={inspecting || !window.elysia}
            onClick={async () => {
              try {
                const directory = await window.elysia?.chooseDirectory();
                if (directory) {
                  setRoot(directory);
                  await inspect(directory);
                }
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <Icon name="folder" size={25} />
            <strong>选择本机文件夹</strong>
            <span>代码仓库、文档或资料目录</span>
          </button>
          {!window.elysia && (
            <p className="field-help">命令行模式可填写下方路径；桌面入口支持系统文件夹选择。</p>
          )}
          <label>
            文件夹路径
            <div className="folder-path-row">
              <input
                required
                value={root}
                disabled={inspecting}
                onChange={(e) => {
                  setRoot(e.target.value);
                  setFolder(undefined);
                }}
                placeholder="D:\项目或资料目录"
              />
              <button
                type="button"
                className="secondary"
                disabled={inspecting || !root.trim()}
                onClick={() => void inspect(root)}
              >
                读取目录
              </button>
            </div>
          </label>
          {inspecting && <p role="status">正在读取文件夹…</p>}
          {error && (
            <p className="inline-warning" role="alert">
              {error}
            </p>
          )}
          {folder && (
            <div className="folder-inspection">
              <strong>
                {existing
                  ? existing.archived
                    ? '该空间中已有归档项目，可打开后恢复'
                    : '当前空间中已有此项目，点击下方按钮即可打开'
                  : folder.gitAvailable
                    ? '已识别 Git 项目'
                    : '已识别本机文件夹'}
              </strong>
              <p className="field-help">
                {folder.gitAvailable
                  ? '根据 Git 基线创建任务目录，保留主目录中的未提交改动。'
                  : folder.gitRoot
                    ? '当前目录是仓库子目录或还没有提交；代理可读取资料，并在独立任务目录生成结果。'
                    : '代理可读取此目录中的资料，并在独立任务目录生成结果。'}
              </p>
              <div className="folder-entries">
                {folder.entries.map((e: any) => (
                  <span key={e.name}>
                    {e.directory ? '▸ ' : ''}
                    {e.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          <label>
            项目名称
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：我的研究项目"
            />
          </label>
          {folder?.gitAvailable && (
            <label>
              Git 基线
              <input required value={baseline} onChange={(e) => setBaseline(e.target.value)} />
              <span className="field-help">解析并保存具体 commit，不复制主目录的未提交改动。</span>
            </label>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy || inspecting} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy || inspecting || !folder || !name.trim()}>
            {existing ? '打开已有项目' : '打开文件夹作为项目'}
            <Icon name="arrow" size={15} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function RunModal({
  providers,
  objective,
  kind,
  projectName,
  close,
  busy,
  submit,
  settings,
}: {
  providers: Provider[];
  objective: string;
  kind: 'task' | 'chat';
  projectName?: string;
  close: () => void;
  busy: boolean;
  submit: (body: any) => void;
  settings: () => void;
}) {
  const [choice, setChoice] = useState<ModelChoice>(() => defaultChoice(providers)),
    [modelReady, setModelReady] = useState(false),
    [write, setWrite] = useState(true),
    [exec, setExec] = useState(true),
    [urls, setUrls] = useState(''),
    [inputs, setInputs] = useState(''),
    [writePaths, setWritePaths] = useState('.'),
    [maxRequests, setMaxRequests] = useState(80),
    [maxTokens, setMaxTokens] = useState(500000),
    [concurrency, setConcurrency] = useState(4);
  const selected = providers.find((p) => p.id === choice.providerId);
  const chat = kind === 'chat';
  const lines = (s: string) =>
    s
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  return (
    <Modal
      title={chat ? '新建独立对话' : '新建项目任务'}
      subtitle={(chat ? '归属：独立会话' : `归属：${projectName}`) + ' · ' + objective.slice(0, 80)}
      close={close}
      busy={busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || !modelReady || !objective.trim()) return;
          submit({
            ...choice,
            inputs: lines(inputs),
            permissionProfile: chat
              ? { read: false, write: false, exec: false, urls: [], writePaths: [] }
              : { read: true, write, exec, urls: lines(urls), writePaths: lines(writePaths) },
            budget: { maxRequests, maxTokens, maxCost: null },
            limits: {
              maxDepth: chat ? 0 : 2,
              maxAgents: chat ? 1 : 12,
              concurrency: chat ? 1 : concurrency,
              toolConcurrency: 4,
              maxSteps: 20,
              maxMinutes: 30,
            },
          });
        }}
      >
        <div className="form-body">
          <p className="field-help">
            {chat
              ? '选择会话模型后开始聊天。独立对话可使用技能说明；处理项目文件和生成附件时，在项目下新建任务。'
              : '模型会根据目标自动选择办公技能。接受计划前可分别分配一级子代理的模型。'}
          </p>
          <ModelPicker
            providers={providers}
            value={choice}
            change={setChoice}
            ready={setModelReady}
            disabled={busy}
            label={chat ? '会话模型连接' : '总代理连接'}
          />
          {['chatgpt', 'codex'].includes(selected?.authMode || '') && (
            <p className="field-help">
              正在使用 ChatGPT 订阅 ·{' '}
              <button type="button" className="text-button" onClick={manageUsage}>
                管理用量
              </button>
            </p>
          )}
          {(!selected?.keyConfigured || selected.checkedRevision !== selected.revision) && (
            <div className="inline-warning">
              请先连接并验证一个可用模型。
              <button type="button" onClick={settings}>
                前往模型设置
              </button>
            </div>
          )}
          {!chat && (
            <>
              <label>
                补充资料路径（可选，每行一项）
                <textarea
                  value={inputs}
                  onChange={(e) => setInputs(e.target.value)}
                  placeholder="已可读取整个项目目录；可在此指定重点文件"
                  rows={2}
                />
              </label>
              <div className="permission-card">
                <h4>执行范围</h4>
                <label className="check-label">
                  <input type="checkbox" checked readOnly />
                  项目内读取
                </label>
                <label className="check-label">
                  <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
                  任务目录写入
                </label>
                {write && (
                  <label>
                    允许写入的相对目录
                    <textarea rows={1} value={writePaths} onChange={(e) => setWritePaths(e.target.value)} />
                  </label>
                )}
                <label className="check-label">
                  <input type="checkbox" checked={exec} onChange={(e) => setExec(e.target.checked)} />
                  命令执行（当前系统用户权限）
                </label>
                <label>
                  授权网页 URL（每行一项）
                  <textarea
                    value={urls}
                    onChange={(e) => setUrls(e.target.value)}
                    rows={2}
                    placeholder="https://…"
                  />
                </label>
              </div>
            </>
          )}
          <div className="form-columns">
            <label>
              模型请求上限
              <input
                type="number"
                min={1}
                max={80}
                value={maxRequests}
                onChange={(e) => setMaxRequests(Number(e.target.value))}
              />
            </label>
            <label>
              Token 上限
              <input
                type="number"
                min={1000}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
              />
            </label>
            {!chat && (
              <label>
                并发实例
                <input
                  type="number"
                  min={1}
                  max={4}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                />
              </label>
            )}
          </div>
          <p className="field-help">
            {chat
              ? '普通回复后等待你继续。调用与 Token 按会话预算累计。'
              : '先生成约定和计划，你接受具体版本后再执行。每次最多 12 个 Agent，递归深度 2，最长 30 分钟。'}
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            返回
          </button>
          <button className="primary" disabled={busy || !modelReady || !objective.trim()}>
            {chat ? '开始对话' : '生成约定与计划'}
            <Icon name="arrow" size={15} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function ContractModal({
  contract,
  close,
  submit,
  busy,
  disabled,
}: {
  contract: Contract;
  close: () => void;
  submit: (c: Contract) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [value, setValue] = useState(contract);
  const labels: Record<string, string> = {
    scope: '范围',
    nonGoals: '不包含',
    inputs: '输入资料',
    deliverables: '交付物',
    acceptanceCriteria: '验收项',
    constraints: '约束',
    assumptions: '可见假设',
  };
  return (
    <Modal
      title={'任务约定 · v' + contract.version}
      subtitle="修改后在安全边界重新生成计划，原授权与预算继续生效"
      busy={busy}
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
      >
        <div className="form-body">
          <label>
            目标
            <textarea
              value={value.objective}
              onChange={(e) => setValue((v) => ({ ...v, objective: e.target.value }))}
            />
          </label>
          {Object.entries(labels).map(([key, label]) => (
            <label key={key}>
              {label}（每行一项）
              <textarea
                rows={2}
                value={(value[key as keyof Contract] as string[]).join('\n')}
                onChange={(e) => setValue((v) => ({ ...v, [key]: e.target.value.split('\n') }))}
              />
            </label>
          ))}
          <p className="field-help">
            请求上限 {contract.budget.maxRequests} · Token 上限 {contract.budget.maxTokens}
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            关闭
          </button>
          <button className="primary" disabled={busy || disabled}>
            保存并重新规划
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function DecisionModal({
  operation,
  close,
  submit,
  busy,
}: {
  operation: Operation;
  close: () => void;
  submit: (body: any) => void;
  busy: boolean;
}) {
  const [outcome, setOutcome] = useState('confirmed'),
    [note, setNote] = useState(''),
    [result, setResult] = useState('{}'),
    [parseError, setParseError] = useState('');
  return (
    <Modal title="核验副作用结果" subtitle="请先检查本机文件或进程证据，再提交决定" close={close} busy={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const parsed = JSON.parse(result);
            setParseError('');
            submit({ operationId: operation.id, outcome, note, result: parsed });
          } catch {
            setParseError('结果需要是合法 JSON');
          }
        }}
      >
        <div className="form-body">
          <pre>{JSON.stringify(operation.evidence || operation.args, null, 2)}</pre>
          <label>
            核验结论
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="confirmed">确认已应用</option>
              <option value="not_applied">确认未应用 / 失败</option>
            </select>
          </label>
          <label>
            证据说明
            <textarea required value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label>
            经核验的工具结果 JSON
            <textarea className="code-input" value={result} onChange={(e) => setResult(e.target.value)} />
          </label>
          {parseError && <p role="alert">{parseError}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            返回
          </button>
          <button className="primary" disabled={busy}>
            提交决定
          </button>
        </footer>
      </form>
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
