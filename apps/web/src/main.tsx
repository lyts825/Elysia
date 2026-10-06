import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, mutation, initializeSession } from './api';
import type {
  Run,
  Task,
  Project,
  Agent,
  Message,
  Artifact,
  RequestRecord,
  Operation,
  Contract,
  ProviderConfig,
} from '../../../packages/contracts/src/index';
import './style.css';
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
  plan: '等待接受计划',
  user: '等待你的回答',
  children: '等待子任务',
  paused: '已暂停',
  interrupted: '服务中断，等待恢复',
  verification: '副作用待核验',
  limit: '达到运行上限',
  rate_limit: '等待账号额度',
};
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    settings: (
      <>
        <path d="m9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    code: (
      <>
        <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" />
      </>
    ),
    work: (
      <>
        <rect x="4" y="5" width="16" height="15" rx="2" />
        <path d="M9 5V3h6v2M4 10h16m-9 0v3h2v-3" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </>
    ),
    send: (
      <>
        <path d="m4 12 16-8-5 16-3-7-8-1Zm8 1 8-9" />
      </>
    ),
    check: <path d="m5 12 4 4 10-10" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    pause: <path d="M8 5v14M16 5v14" />,
    play: <path d="m7 4 13 8-13 8Z" />,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
    file: (
      <>
        <path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8M8 16h6" />
      </>
    ),
    tree: (
      <>
        <rect x="9" y="2" width="6" height="5" rx="1" />
        <rect x="2" y="17" width="6" height="5" rx="1" />
        <rect x="16" y="17" width="6" height="5" rx="1" />
        <path d="M12 7v5M5 17v-5h14v5" />
      </>
    ),
    chart: (
      <>
        <path d="M4 3v18h17M8 16v-5m5 5V6m5 10v-8" />
      </>
    ),
    chat: <path d="M21 11a8 8 0 0 1-8 8H7l-5 3 1-6a8 8 0 0 1-1-5 9 9 0 0 1 19 0Z" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V6a4 4 0 0 1 8 0v4" />
      </>
    ),
    spark: (
      <>
        <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" />
      </>
    ),
    history: (
      <>
        <path d="M3 4v5h5M3 9a9 9 0 1 1 1 9m8-12v6l4 2" />
      </>
    ),
    folder: <path d="M3 6h7l2 3h9v11H3Z" />,
    refresh: (
      <>
        <path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.file}
    </svg>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span className={'badge ' + status.toLowerCase()}>
      <i />
      {statuses[status] || status}
    </span>
  );
}
function Modal({
  title,
  subtitle,
  close,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  close: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section className={'modal ' + (wide ? 'wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" onClick={close} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function App() {
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [projects, setProjects] = useState<Project[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [providers, setProviders] = useState<Provider[]>([]),
    [projectId, setProjectId] = useState(''),
    [runId, setRunId] = useState(''),
    [detail, setDetail] = useState<Detail | null>(null),
    [tab, setTab] = useState('tasks'),
    [modal, setModal] = useState(''),
    [artifactView, setArtifactView] = useState<{ name: string; text: string; id: string } | null>(null),
    [draft, setDraft] = useState(''),
    [reply, setReply] = useState(''),
    [streaming, setStreaming] = useState<Record<string, string>>({});
  const project = projects.find((p) => p.id === projectId);
  const refresh = useCallback(async () => {
    const [p, r, v] = await Promise.all([
      api<Project[]>('/projects'),
      api<Run[]>('/runs'),
      api<Provider[]>('/providers'),
    ]);
    setProjects(p);
    setRuns(r);
    setProviders(v);
    setProjectId((old) => old || p[0]?.id || '');
  }, []);
  const refreshDetail = useCallback(async () => {
    if (runId) setDetail(await api<Detail>('/runs/' + runId));
  }, [runId]);
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
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      await refreshDetail();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const selectRun = (run: Run) => {
    setRunId(run.id);
    setProjectId(run.projectId);
  };
  const newRun = () => {
    setRunId('');
    setDetail(null);
  };
  const totalTokens =
    detail?.requests.reduce((s, r) => s + (r.usage?.inputTotal ?? 0) + (r.usage?.outputTotal ?? 0), 0) || 0;
  const runAction = (action: string) =>
    act(() => mutation('/runs/' + runId + '/actions', { action, expectedRevision: detail!.run.revision }));
  async function openArtifact(a: Artifact) {
    await act(async () => {
      const response = await fetch('/api/artifacts/' + a.id);
      if (!response.ok) throw new Error('无法读取产物');
      setArtifactView({ name: a.name, text: await response.text(), id: a.id });
    });
  }
  if (!ready)
    return (
      <div className="auth-screen">
        <div className="brand-mark">
          <Icon name="spark" size={32} />
        </div>
        <h1>Elysia</h1>
        <p>{error || '正在连接本机工作台…'}</p>
        {error && (
          <div className="auth-help">
            请执行 <code>pnpm start</code>，使用终端打印的一次性引导链接打开。
            <br />
            重新启动服务可获取新的链接。
          </div>
        )}
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="spark" size={22} />
          </span>
          <span>
            Elysia<small>PERSONAL AGENT WORKSPACE</small>
          </span>
        </div>
        <button className="new-task" onClick={newRun}>
          <Icon name="plus" />
          新建任务<span>⌘ N</span>
        </button>
        <button className={'nav-item ' + (!runId ? 'selected' : '')} onClick={newRun}>
          <Icon name="grid" />
          工作台
        </button>
        <div className="side-heading">
          项目
          <button aria-label="添加项目" onClick={() => setModal('project')}>
            <Icon name="plus" size={15} />
          </button>
        </div>
        <div className="project-list">
          {projects.map((p) => (
            <button
              className={'project-item ' + (p.id === projectId ? 'selected' : '')}
              key={p.id}
              onClick={() => {
                setProjectId(p.id);
                newRun();
              }}
            >
              <Icon name={p.mode === 'code' ? 'code' : 'work'} size={16} />
              <span>{p.name}</span>
              <small>{p.mode}</small>
            </button>
          ))}
          {!projects.length && (
            <button className="empty-project" onClick={() => setModal('project')}>
              注册第一个本机项目 <Icon name="plus" size={14} />
            </button>
          )}
        </div>
        <div className="side-heading history-heading">
          最近任务<span>{runs.length}</span>
        </div>
        <div className="history-list">
          {runs
            .filter((r) => !projectId || r.projectId === projectId)
            .map((r) => (
              <button
                key={r.id}
                className={'history-item ' + (r.id === runId ? 'selected' : '')}
                onClick={() => selectRun(r)}
              >
                <span className={'status-dot ' + r.status.toLowerCase()} />
                <span>{r.objective}</span>
              </button>
            ))}
          {!runs.length && <p className="sidebar-muted">任务与交付记录会保存在本机</p>}
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setModal('settings')}>
            <Icon name="settings" />
            模型与设置
          </button>
          <div className="local-indicator">
            <i />
            本机连接<span>v0.1.0 · 待验收</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <Icon name="folder" size={16} />
            <span>{project?.name || '个人工作台'}</span>
            <span className="slash">/</span>
            <strong>{detail ? detail.run.objective.slice(0, 28) : '新任务'}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-chip">
              <Icon name="lock" size={12} />
              本机运行
            </span>
            <button className="icon-button" onClick={() => void act(refresh)} title="刷新">
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
          <div className="welcome">
            <div className="welcome-content">
              <span className="eyebrow">
                <i />
                ONE GOAL. A WHOLE TEAM.
              </span>
              <h1>把目标，交给团队。</h1>
              <p className="welcome-subtitle">从一个想法到可检查的交付。让不同模型在你的本机协作。</p>
              <div className="composer">
                <textarea
                  aria-label="任务目标"
                  placeholder="描述你想完成的事情…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="composer-bottom">
                  <div className="composer-hint">
                    <Icon name={project?.mode === 'code' ? 'code' : 'work'} size={15} />
                    {project
                      ? `${project.mode === 'code' ? 'Code' : 'Work'} · ${project.name}`
                      : '先选择一个本机项目'}
                  </div>
                  <button
                    className="primary"
                    disabled={!draft.trim() || busy}
                    onClick={() => setModal(project ? 'run' : 'project')}
                  >
                    开始协作
                    <Icon name="arrow" size={16} />
                  </button>
                </div>
              </div>
              <div className="suggestions">
                {[
                  {
                    icon: 'code',
                    title: '实现一个功能',
                    text: '检查项目约定，拆解实现计划，修改代码并提供验证和差异。',
                  },
                  {
                    icon: 'file',
                    title: '整理资料报告',
                    text: '阅读我指定的资料，整理一份有来源、可核对的 Markdown 报告。',
                  },
                  {
                    icon: 'tree',
                    title: '让团队分工',
                    text: '围绕我的目标制定有依赖和验收项的计划，分派任务并集成交付。',
                  },
                ].map((s) => (
                  <button key={s.title} onClick={() => setDraft(s.text)}>
                    <Icon name={s.icon} size={20} />
                    <strong>{s.title}</strong>
                    <span>{s.text}</span>
                    <Icon name="arrow" size={14} />
                  </button>
                ))}
              </div>
              <div className="workspace-summary">
                <span>
                  <Icon name="globe" size={15} />
                  {providers.filter((p) => p.checkedRevision === p.revision).length} 个可用模型
                </span>
                <span>
                  <Icon name="tree" size={15} />
                  有界递归协作
                </span>
                <span>
                  <Icon name="lock" size={15} />
                  你决定执行范围
                </span>
              </div>
            </div>
            <footer>目标 → 约定 → 计划 → 执行 → 验证 → 交付</footer>
          </div>
        ) : detail ? (
          <>
            <div className="run-toolbar">
              <div>
                <Badge status={detail.run.status} />
                <span className="run-reason">
                  {reasons[detail.run.reason || ''] || detail.run.reason || '任务状态与事件已持久保存'}
                </span>
              </div>
              <div className="run-controls">
                <button className="quiet-button" onClick={() => setModal('contract')}>
                  <Icon name="file" size={14} />
                  任务约定
                </button>
                {['READY', 'RUNNING'].includes(detail.run.status) ? (
                  <button className="quiet-button" disabled={busy} onClick={() => void runAction('pause')}>
                    <Icon name="pause" size={14} />
                    暂停
                  </button>
                ) : (
                  !['DONE', 'CANCELLED'].includes(detail.run.status) && (
                    <button
                      className="quiet-button"
                      disabled={
                        busy ||
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
                    disabled={busy}
                    onClick={() => void runAction('cancel')}
                  >
                    <Icon name="stop" size={14} />
                    取消
                  </button>
                )}
              </div>
            </div>
            <div className="run-layout">
              <section className="conversation">
                <div className="conversation-scroll">
                  <div className="user-message">
                    <div className="message-avatar user">你</div>
                    <div>
                      <span className="message-label">任务目标</span>
                      <p>{detail.run.objective}</p>
                    </div>
                  </div>
                  <div className="system-note">
                    <Icon name="lock" size={14} />
                    <span>
                      授权：读取{detail.run.contract.permissionProfile.write ? ' · 指定目录写入' : ''}
                      {detail.run.contract.permissionProfile.exec ? ' · 命令执行' : ''} ·{' '}
                      {detail.run.contract.permissionProfile.urls.length} 个网页来源。计划接受后开始执行。
                    </span>
                  </div>
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
                                ? '用户 / 交接'
                                : task?.spec.role === 'coordinator'
                                  ? '总代理'
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
                              {t.providerId} · {t.mode.toUpperCase()}{' '}
                              {t.dependsOn.length ? '· 依赖 ' + t.dependsOn.join(', ') : ''}
                            </small>
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
                            disabled={busy}
                            onClick={() =>
                              void act(() =>
                                mutation('/runs/' + runId + '/plan/accept', {
                                  expectedRevision: detail.run.revision,
                                  version: detail.run.plan!.version,
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
                  {detail.run.status === 'DONE' && (
                    <div className="delivery-card">
                      <Icon name="check" size={24} />
                      <div>
                        <h3>交付已通过证据核验</h3>
                        <p>查看右侧产物和差异，复核内容是否符合你的目标。</p>
                      </div>
                    </div>
                  )}
                </div>
                <form
                  className="reply-box"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      await mutation('/runs/' + runId + '/messages', {
                        expectedRevision: detail.run.revision,
                        text: reply,
                      });
                      setReply('');
                    });
                  }}
                >
                  <textarea
                    aria-label="回复或补充需求"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="回答问题，或补充需求…"
                    disabled={['DONE', 'CANCELLED'].includes(detail.run.status)}
                  />
                  <div>
                    <span>补充需求会在安全边界更新约定与计划</span>
                    <button
                      className="send-button"
                      aria-label="发送补充需求"
                      disabled={!reply.trim() || busy || ['DONE', 'CANCELLED'].includes(detail.run.status)}
                    >
                      <Icon name="send" size={17} />
                    </button>
                  </div>
                </form>
              </section>
              <aside className="details-panel">
                <div className="detail-tabs">
                  {[
                    { key: 'tasks', icon: 'grid', title: '任务' },
                    { key: 'agents', icon: 'tree', title: '代理' },
                    { key: 'artifacts', icon: 'file', title: '产物' },
                    { key: 'usage', icon: 'chart', title: '用量' },
                  ].map((t) => (
                    <button
                      key={t.key}
                      className={tab === t.key ? 'active' : ''}
                      onClick={() => setTab(t.key)}
                    >
                      <Icon name={t.icon} size={15} />
                      {t.title}
                    </button>
                  ))}
                </div>
                <div className="detail-content">
                  {tab === 'tasks' && (
                    <>
                      <div className="panel-heading">
                        <h3>执行拓扑</h3>
                        <span>
                          {detail.tasks.filter((t) => t.status === 'DONE').length}/{detail.tasks.length} 完成
                        </span>
                      </div>
                      <TaskGraph detail={detail} />
                      <div className="panel-heading">
                        <h3>任务列表</h3>
                        <span>依赖与责任分开记录</span>
                      </div>
                      {detail.tasks.map((t) => (
                        <div className="task-detail" key={t.id}>
                          <div>
                            <strong>{t.spec.title}</strong>
                            <Badge status={t.status} />
                          </div>
                          <p>{t.waitReason ? reasons[t.waitReason] || t.waitReason : t.spec.objective}</p>
                          <small>
                            {t.spec.mode.toUpperCase()} · {t.spec.providerId} · 深度 {t.depth}
                          </small>
                          {t.baseline && <code title={t.baseline}>基线 {t.baseline.slice(0, 10)}</code>}
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
                        <h3>代理责任树</h3>
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
                                {task?.spec.role === 'coordinator' ? '总代理' : task?.spec.title}
                              </strong>
                              <p>
                                {a.providerBinding.label} · {a.providerBinding.model}
                              </p>
                              <small>独立会话 {a.sessionId.slice(0, 8)}</small>
                            </div>
                            <span className={'status-dot ' + a.status.toLowerCase()} />
                          </div>
                        );
                      })}
                      <div className="info-note">
                        每个实例独立保存会话、工具操作和工作目录。账号共享并发与速率额度。
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
                        <Empty
                          icon="file"
                          title="产物将在这里交付"
                          text="报告、附件和 Git diff 会保留版本与来源。"
                        />
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
                </div>
                <div className="panel-bottom">
                  <Icon name="history" size={13} />
                  状态与事件保存在本机 SQLite
                </div>
              </aside>
            </div>
          </>
        ) : (
          <div className="loading">正在读取任务…</div>
        )}
      </main>
      {modal === 'project' && (
        <ProjectModal
          close={() => setModal('')}
          busy={busy}
          submit={(body) =>
            act(async () => {
              const p = await mutation<Project>('/projects', body);
              setProjectId(p.id);
              setModal('');
            })
          }
        />
      )}
      {modal === 'run' && project && (
        <RunModal
          project={project}
          objective={draft}
          providers={providers}
          close={() => setModal('')}
          busy={busy}
          submit={(body) =>
            act(async () => {
              const run = await mutation<Run>('/runs', { ...body, objective: draft, projectId });
              setRunId(run.id);
              setDraft('');
              setModal('');
            })
          }
          settings={() => setModal('settings')}
        />
      )}
      {modal === 'settings' && (
        <SettingsModal
          providers={providers}
          close={() => setModal('')}
          busy={busy}
          submit={(p, check) =>
            act(async () => {
              if (check) await mutation('/providers/' + p.id + '/check', { expectedRevision: p.revision });
              else await mutation('/providers/' + p.id, { ...p, expectedRevision: p.revision }, 'PUT');
            })
          }
        />
      )}
      {modal === 'contract' && detail && (
        <ContractModal
          contract={detail.run.contract}
          close={() => setModal('')}
          busy={busy}
          disabled={['DONE', 'CANCELLED'].includes(detail.run.status)}
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
      {artifactView && (
        <Modal
          title={artifactView.name}
          subtitle="已登记产物 · 内容哈希由服务端核对"
          close={() => setArtifactView(null)}
          wide
        >
          <div className="artifact-preview">
            <pre>{artifactView.text}</pre>
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
    </div>
  );
}
function Empty({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={32} />
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
      <small className="graph-caption">阶段间箭头由任务依赖计算</small>
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
            width:
              Math.min(100, (detail.requests.length / detail.run.contract.budget.maxRequests) * 100) + '%',
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
        <Empty icon="chart" title="等待真实调用" text="使用供应商返回的 usage；缺失指标显示为未知。" />
      )}
      <div className="info-note">
        资料快照复用、厂商 Prompt 缓存和会话续接分别记录。未返回用量的请求保留预算预留；成本需要有效价格配置。
      </div>
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
  close,
  busy,
  submit,
}: {
  close: () => void;
  busy: boolean;
  submit: (body: any) => void;
}) {
  const [name, setName] = useState(''),
    [root, setRoot] = useState(''),
    [mode, setMode] = useState('work'),
    [baseline, setBaseline] = useState('HEAD');
  return (
    <Modal title="注册本机项目" subtitle="指定资料目录，或选择已有提交的 Git 项目" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit({ name, workspaceRoot: root, mode, baseline });
        }}
      >
        <div className="form-body">
          <label>
            项目名称
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：我的研究项目"
            />
          </label>
          <div className="mode-picker">
            {['work', 'code'].map((m) => (
              <button type="button" className={mode === m ? 'active' : ''} onClick={() => setMode(m)} key={m}>
                <Icon name={m} size={20} />
                <strong>{m === 'code' ? 'Code' : 'Work'}</strong>
                <span>{m === 'code' ? 'Git 项目与独立 worktree' : '资料分析、报告与附件'}</span>
              </button>
            ))}
          </div>
          <label>
            本机目录的绝对路径
            <input
              required
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="D:\项目或资料目录"
            />
          </label>
          {mode === 'code' && (
            <label>
              工作区基线
              <input required value={baseline} onChange={(e) => setBaseline(e.target.value)} />
              <span className="field-help">解析并保存具体 commit，不复制主目录的未提交改动。</span>
            </label>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            注册项目
            <Icon name="arrow" size={15} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function RunModal({
  project,
  providers,
  objective,
  close,
  busy,
  submit,
  settings,
}: {
  project: Project;
  providers: Provider[];
  objective: string;
  close: () => void;
  busy: boolean;
  submit: (body: any) => void;
  settings: () => void;
}) {
  const [providerId, setProviderId] = useState(
      providers.find((p) => p.checkedRevision === p.revision)?.id || providers[0]?.id || '',
    ),
    [write, setWrite] = useState(true),
    [exec, setExec] = useState(project.mode === 'code'),
    [urls, setUrls] = useState(''),
    [inputs, setInputs] = useState(''),
    [writePaths, setWritePaths] = useState('.'),
    [maxRequests, setMaxRequests] = useState(80),
    [maxTokens, setMaxTokens] = useState(500000),
    [concurrency, setConcurrency] = useState(4);
  const selected = providers.find((p) => p.id === providerId);
  const lines = (s: string) =>
    s
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  return (
    <Modal title="设定本次协作" subtitle={objective.slice(0, 100)} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit({
            providerId,
            inputs: lines(inputs),
            permissionProfile: { read: true, write, exec, urls: lines(urls), writePaths: lines(writePaths) },
            budget: { maxRequests, maxTokens, maxCost: null },
            limits: {
              maxDepth: 2,
              maxAgents: 12,
              concurrency,
              toolConcurrency: 4,
              maxSteps: 20,
              maxMinutes: 30,
            },
          });
        }}
      >
        <div className="form-body">
          <label>
            总代理
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.model} {p.checkedRevision !== p.revision ? '（待验证）' : ''}
                </option>
              ))}
            </select>
          </label>
          {selected?.checkedRevision !== selected?.revision && (
            <div className="inline-warning">
              模型尚未完成连通性验证。
              <button type="button" onClick={settings}>
                前往模型设置
              </button>
            </div>
          )}
          <label>
            指定资料路径（每行一项）
            <textarea
              value={inputs}
              onChange={(e) => setInputs(e.target.value)}
              placeholder="使用项目目录内文件的绝对路径"
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
          </div>
          <p className="field-help">
            先生成约定和计划，你接受具体版本后再执行。每次最多 12 个 Agent，递归深度 2，最长 30 分钟。
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={close}>
            返回
          </button>
          <button className="primary" disabled={busy || selected?.checkedRevision !== selected?.revision}>
            生成约定与计划
            <Icon name="arrow" size={15} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function SettingsModal({
  providers,
  close,
  busy,
  submit,
}: {
  providers: Provider[];
  close: () => void;
  busy: boolean;
  submit: (p: Provider, check: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState(providers[0]?.id || ''),
    [config, setConfig] = useState<Provider>(providers[0]);
  const current = providers.find((p) => p.id === selectedId)!;
  useEffect(() => {
    if (current) setConfig(current);
  }, [current]);
  const change = (key: string, value: unknown) => setConfig((p) => ({ ...p, [key]: value }));
  const [advanced, setAdvanced] = useState('');
  return (
    <Modal title="模型与设置" subtitle="配置保存在本机；密钥只从服务端环境读取" close={close} wide>
      <div className="settings-layout">
        <nav>
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={selectedId === p.id ? 'active' : ''}
            >
              <span>{p.label}</span>
              <small>
                {p.keyConfigured
                  ? p.checkedRevision === p.revision
                    ? '可用于新任务'
                    : '待验证'
                  : '未配置密钥'}
              </small>
            </button>
          ))}
        </nav>
        <div className="settings-form">
          {config && (
            <>
              <div className="settings-status">
                <span
                  className={
                    'status-dot ' + (current.checkedRevision === current.revision ? 'done' : 'waiting')
                  }
                />
                {current.checkedRevision === current.revision
                  ? '连通性已验证'
                  : current.keyConfigured
                    ? '需要显式连通性验证'
                    : '服务端密钥未配置'}
              </div>
              <label>
                显示名称
                <input value={config.label} onChange={(e) => change('label', e.target.value)} />
              </label>
              <label>
                模型 ID
                <input value={config.model} onChange={(e) => change('model', e.target.value)} />
                <span className="field-help">示例值需按账号可用模型调整。</span>
              </label>
              <label>
                API Base URL
                <input value={config.baseUrl} onChange={(e) => change('baseUrl', e.target.value)} />
              </label>
              <div className="form-columns">
                <label>
                  密钥环境变量名称
                  <input value={config.apiKeyEnv} onChange={(e) => change('apiKeyEnv', e.target.value)} />
                </label>
                <label>
                  账号额度作用域
                  <input value={config.account} onChange={(e) => change('account', e.target.value)} />
                </label>
              </div>
              <div className="form-columns">
                <label>
                  上下文上限
                  <input
                    type="number"
                    value={config.contextLimit}
                    onChange={(e) => change('contextLimit', Number(e.target.value))}
                  />
                </label>
                <label>
                  输出上限
                  <input
                    type="number"
                    value={config.outputLimit}
                    onChange={(e) => change('outputLimit', Number(e.target.value))}
                  />
                </label>
                <label>
                  账号并发
                  <input
                    type="number"
                    min={1}
                    max={2}
                    value={config.concurrency}
                    onChange={(e) => change('concurrency', Number(e.target.value))}
                  />
                </label>
              </div>
              <div className="form-columns">
                <label>
                  账号 RPM
                  <input
                    type="number"
                    value={config.rpm}
                    onChange={(e) => change('rpm', Number(e.target.value))}
                  />
                </label>
                <label>
                  账号 TPM
                  <input
                    type="number"
                    value={config.tpm}
                    onChange={(e) => change('tpm', Number(e.target.value))}
                  />
                </label>
              </div>
              <details
                onToggle={(e) => {
                  if (e.currentTarget.open)
                    setAdvanced(JSON.stringify({ cache: config.cache, prices: config.prices }, null, 2));
                }}
              >
                <summary>缓存能力与每百万 Token 价格</summary>
                <textarea
                  className="code-input"
                  rows={12}
                  value={advanced}
                  onChange={(e) => setAdvanced(e.target.value)}
                />
                <button
                  className="secondary"
                  onClick={() => {
                    try {
                      const data = JSON.parse(advanced);
                      setConfig((p) => ({ ...p, cache: data.cache, prices: data.prices }));
                    } catch {}
                  }}
                >
                  应用配置到表单
                </button>
                <p className="field-help">未知价格保持 null。仅配置该模型明确支持的缓存参数。</p>
              </details>
              <div className="info-note">
                保存变更后需重新验证，新任务使用已验证配置。运行中的实例保留原有模型绑定。验证会发起一次短模型请求。
              </div>
              <div className="settings-actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => submit({ ...config, revision: current.revision }, false)}
                >
                  保存配置
                </button>
                <button
                  className="primary"
                  disabled={busy || !current.keyConfigured}
                  onClick={() => submit(current, true)}
                >
                  <Icon name="check" size={15} />
                  验证已保存配置
                </button>
              </div>
            </>
          )}
        </div>
      </div>
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
            请求上限 {contract.budget.maxRequests} · Token 上限 {contract.budget.maxTokens} · 模式{' '}
            {contract.mode.toUpperCase()}
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={close}>
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
    <Modal title="核验副作用结果" subtitle="请先检查本机文件或进程证据，再提交决定" close={close}>
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
          <button type="button" className="secondary" onClick={close}>
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
