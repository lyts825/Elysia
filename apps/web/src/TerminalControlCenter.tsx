import { Activity, useEffect, useId, useRef, useState } from 'react';
import {
  SurfaceTerminalSettings,
  TerminalConnectionWrite,
  type Project,
  type TerminalAppId,
  type TerminalConnectionProtocol,
  type TerminalConnectionView,
  type TerminalControlOverview,
  type TerminalControlApps,
  type TerminalProjectPreferences,
  type TerminalCliInstallationJob,
} from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { TerminalSettings } from './TerminalSettings';
import './terminal-control.css';

type CliStatus = { available: boolean; installed: boolean | null; version?: string; message: string };
type ConnectionDraft = {
  id: string;
  revision: number;
  name: string;
  protocol: TerminalConnectionProtocol;
  baseUrl: string;
  model: string;
  credentialMode: 'environment' | 'vault';
  apiKeyEnv: string;
  apiKey: string;
};
const presets = [
  {
    name: 'OpenAI',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  {
    name: 'DeepSeek · DSH',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  {
    name: 'Anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    model: '',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  {
    name: 'Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: '',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  {
    name: '自定义',
    protocol: 'openai-responses',
    baseUrl: '',
    model: '',
    apiKeyEnv: 'ELYSIA_TERMINAL_API_KEY',
  },
] as const;
const protocolLabels: Record<TerminalConnectionProtocol, string> = {
  'openai-responses': 'OpenAI Responses',
  'openai-chat': 'OpenAI Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
  gemini: 'Gemini API',
};
const message = (error: unknown) => (error instanceof Error ? error.message : '操作未完成，请重试。');
const newConnection = (index = 0): ConnectionDraft => ({
  id: crypto.randomUUID(),
  revision: 0,
  ...presets[index],
  credentialMode: 'vault',
  apiKey: '',
});
const connectionDraft = (item: TerminalConnectionView): ConnectionDraft => ({
  id: item.id,
  revision: item.revision,
  name: item.name,
  protocol: item.protocol,
  baseUrl: item.baseUrl,
  model: item.model,
  credentialMode: item.auth.kind,
  apiKeyEnv: item.auth.kind === 'environment' ? item.auth.env : 'ELYSIA_TERMINAL_API_KEY',
  apiKey: '',
});
const connectionValues = (draft: ConnectionDraft | null) =>
  draft &&
  JSON.stringify({
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    model: draft.model,
    credentialMode: draft.credentialMode,
    apiKeyEnv: draft.credentialMode === 'environment' ? draft.apiKeyEnv : '',
    apiKey: draft.apiKey.trim(),
  });
const preferenceValues = (value: TerminalProjectPreferences | null) =>
  value && JSON.stringify({ defaultProfileId: value.defaultProfileId, connectionId: value.connectionId });
const appProfile = (settings: SurfaceTerminalSettings, appId: TerminalAppId) =>
  settings.profiles.find((profile) => profile.id === settings.defaultProfileId && profile.agent === appId) ||
  settings.profiles.find((profile) => profile.agent === appId);

export function TerminalControlCenter({
  initial,
  project,
  close,
  updated,
  activity,
  controlUpdated,
}: {
  initial: SurfaceTerminalSettings;
  project?: Project;
  close: () => void;
  updated: (settings: SurfaceTerminalSettings) => void;
  activity: (busy: boolean) => void;
  controlUpdated: (overview: TerminalControlOverview, preferences?: TerminalProjectPreferences) => void;
}) {
  const { api, mutation } = useSurfaceClient();
  const [tab, setTab] = useState<'apps' | 'connections' | 'project' | 'templates'>('apps');
  const [overview, setOverview] = useState<TerminalControlOverview | null>(null);
  const [settings, setSettings] = useState(initial);
  const [preferences, setPreferences] = useState<TerminalProjectPreferences | null>(null);
  const [projectDraft, setProjectDraft] = useState<TerminalProjectPreferences | null>(null);
  const [projectBaseline, setProjectBaseline] = useState<TerminalProjectPreferences | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [connectionBaseline, setConnectionBaseline] = useState<ConnectionDraft | null>(null);
  const [templateVisited, setTemplateVisited] = useState(false);
  const [templateDirty, setTemplateDirty] = useState(false);
  const [pending, setPending] = useState<
    { kind: 'close' } | { kind: 'connection'; next: ConnectionDraft } | null
  >(null);
  const [applyTargets, setApplyTargets] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<TerminalCliInstallationJob[]>([]);
  const [statuses, setStatuses] = useState<
    Partial<Record<TerminalAppId, { key: string; result: CliStatus }>>
  >({});
  const [checking, setChecking] = useState<TerminalAppId | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [versions, setVersions] = useState<Partial<Record<TerminalAppId, string>>>({});
  const submitting = useRef(false);
  const drafts = useRef({ projectDraft, projectBaseline });
  drafts.current = { projectDraft, projectBaseline };
  const profileKeys = useRef<Partial<Record<TerminalAppId, string>>>({});
  profileKeys.current = Object.fromEntries(
    (overview?.catalog || []).map((item) => {
      const binding = overview?.apps.entries.find((entry) => entry.id === item.id)?.connectionId;
      return [
        item.id,
        JSON.stringify([
          appProfile(settings, item.id) || item.preset,
          binding,
          overview?.connections.find((connection) => connection.id === binding)?.revision,
        ]),
      ];
    }),
  );
  const panelId = useId(),
    tabPrefix = useId();
  async function load(signal?: AbortSignal) {
    const [control, installs, prefs, latestSettings] = await Promise.all([
      api<TerminalControlOverview>('/terminal/control', undefined, undefined, signal),
      api<TerminalCliInstallationJob[]>('/terminal/control/installations', undefined, undefined, signal),
      project
        ? api<TerminalProjectPreferences>(
            `/terminal/control/projects/${project.id}/preferences`,
            undefined,
            undefined,
            signal,
          )
        : Promise.resolve(null),
      api<SurfaceTerminalSettings>('/terminal/settings', undefined, undefined, signal),
    ]);
    if (signal?.aborted) return;
    setOverview(control);
    setJobs(installs);
    setSettings(latestSettings);
    setPreferences(prefs);
    if (
      !drafts.current.projectDraft ||
      preferenceValues(drafts.current.projectDraft) === preferenceValues(drafts.current.projectBaseline)
    ) {
      setProjectDraft(prefs);
      setProjectBaseline(prefs);
    }
    updated(latestSettings);
    controlUpdated(control, prefs ?? undefined);
    return prefs;
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((issue) => {
      if (!controller.signal.aborted) setError(message(issue));
    });
    return () => controller.abort();
  }, [project?.id]);
  const running = jobs.some((job) => job.status === 'running');
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        setJobs(await api('/terminal/control/installations', undefined, undefined, controller.signal));
      } catch (issue) {
        if (!controller.signal.aborted) setError(message(issue));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1800);
    };
    timer = setTimeout(poll, 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [running, api]);
  async function perform(action: () => Promise<unknown>) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    activity(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (issue) {
      setError(message(issue));
    } finally {
      submitting.current = false;
      setBusy(false);
      activity(false);
    }
  }
  async function saveApps(next: TerminalControlApps) {
    if (!overview) return;
    const apps = await mutation<TerminalControlApps>(
      '/terminal/control/apps',
      {
        expectedRevision: overview.apps.revision,
        defaultAppId: next.defaultAppId,
        entries: next.entries,
      },
      'PUT',
    );
    const control = { ...overview, apps };
    setOverview(control);
    savedSettings(await api<SurfaceTerminalSettings>('/terminal/settings'));
    controlUpdated(control);
  }
  function savedSettings(next: SurfaceTerminalSettings) {
    setSettings(next);
    updated(next);
  }
  const selectedConnection = overview?.connections.find((item) => item.id === draft?.id);
  const connectionDirty = connectionValues(draft) !== connectionValues(connectionBaseline);
  const projectDirty = preferenceValues(projectDraft) !== preferenceValues(projectBaseline);
  useEffect(() => {
    if (pending?.kind === 'close' && !connectionDirty && !projectDirty && !templateDirty) setPending(null);
  }, [pending, connectionDirty, projectDirty, templateDirty]);
  function replaceConnection(next: ConnectionDraft) {
    setDraft(next);
    setConnectionBaseline(next);
    setDeleting(null);
    setPending(null);
  }
  function selectConnection(next: ConnectionDraft) {
    if (busy) return;
    if (next.id === draft?.id) return;
    if (connectionDirty) setPending({ kind: 'connection', next });
    else replaceConnection(next);
  }
  function requestClose() {
    if (busy) return;
    if (connectionDirty || projectDirty || templateDirty) setPending({ kind: 'close' });
    else close();
  }
  function selectTab(next: typeof tab) {
    if (next === 'templates') setTemplateVisited(true);
    setTab(next);
    setError('');
    setNotice('');
  }
  useEffect(() => {
    if (selectedConnection && !connectionDirty && draft?.revision !== selectedConnection.revision)
      replaceConnection(connectionDraft(selectedConnection));
  }, [selectedConnection, connectionDirty, draft?.revision]);
  const draftBody = draft
    ? {
        expectedRevision: draft.revision,
        connection: {
          name: draft.name,
          protocol: draft.protocol,
          baseUrl: draft.baseUrl,
          model: draft.model,
          credentialMode: draft.credentialMode,
          apiKeyEnv: draft.apiKeyEnv,
        },
        ...(draft.credentialMode === 'vault' && draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      }
    : null;
  const validConnection =
    !!draftBody &&
    TerminalConnectionWrite.safeParse({ ...draftBody, commandId: crypto.randomUUID() }).success &&
    (draft?.credentialMode !== 'vault' || !!draft.apiKey.trim() || selectedConnection?.auth.kind === 'vault');
  const projectProfile =
    settings.profiles.find((entry) => entry.id === projectDraft?.defaultProfileId) ||
    settings.profiles.find((entry) => entry.id === settings.defaultProfileId) ||
    settings.profiles.find((entry) => entry.agent === overview?.apps.defaultAppId);
  const projectProtocols =
    overview?.catalog.find((entry) => entry.id === projectProfile?.agent)?.protocols || [];
  return (
    <Modal
      title="终端管理"
      subtitle="应用、API 连接与项目默认配置"
      close={requestClose}
      busy={busy}
      wide
      className="terminal-control-center"
    >
      <div className="terminal-control-tabs" role="tablist" aria-label="终端管理分类">
        {(
          [
            ['apps', '应用'],
            ['connections', 'API 连接'],
            ['project', '项目默认'],
            ['templates', '终端模板'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            id={`${tabPrefix}-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={panelId}
            tabIndex={tab === id ? 0 : -1}
            disabled={busy}
            onClick={() => {
              selectTab(id);
            }}
            onKeyDown={(event) => {
              const tabs = ['apps', 'connections', 'project', 'templates'] as const;
              const index = tabs.indexOf(tab);
              const target =
                event.key === 'ArrowRight'
                  ? tabs[(index + 1) % 4]
                  : event.key === 'ArrowLeft'
                    ? tabs[(index + 3) % 4]
                    : event.key === 'Home'
                      ? tabs[0]
                      : event.key === 'End'
                        ? tabs[3]
                        : undefined;
              if (target) {
                event.preventDefault();
                selectTab(target);
                document.getElementById(`${tabPrefix}-${target}`)?.focus();
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {pending && (
        <div className="terminal-control-confirm" role="group" aria-label="未保存修改确认">
          <span>有未保存的修改。</span>
          <button className="secondary" disabled={busy} onClick={() => setPending(null)}>
            继续编辑
          </button>
          <button
            className="secondary danger"
            disabled={busy}
            onClick={() => {
              if (pending.kind === 'close') close();
              else replaceConnection(pending.next);
            }}
          >
            {pending.kind === 'close' ? '放弃并关闭' : '放弃并切换'}
          </button>
        </div>
      )}
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${tabPrefix}-${tab}`}
        className={`terminal-control-content ${tab === 'templates' ? 'with-templates' : ''}`}
      >
        {error && (
          <div className="terminal-control-read-error">
            <p className="inline-warning" role="alert">
              {error}
            </p>
            <button className="secondary" disabled={busy} onClick={() => void perform(() => load())}>
              刷新配置
            </button>
          </div>
        )}
        {notice && (
          <p className="terminal-control-notice" role="status">
            <Icon name="check" size={16} />
            {notice}
          </p>
        )}
        {!overview ? (
          <div className="terminal-control-loading">
            {error ? (
              <button className="secondary" onClick={() => void perform(() => load())}>
                重新加载
              </button>
            ) : (
              '正在读取终端管理…'
            )}
          </div>
        ) : tab === 'apps' ? (
          <>
            <div className="terminal-control-heading">
              <div>
                <h3>Agent 应用</h3>
                <p>Codex CLI 和 DSH 已预设。在项目 Docker 环境中安装与运行。</p>
              </div>
              <span className="terminal-control-tag">独立工作台</span>
            </div>
            <div className="cli-app-list">
              {overview.catalog.map((item) => {
                const entry = overview.apps.entries.find((value) => value.id === item.id)!;
                const profile = appProfile(settings, item.id);
                const statusKey = profileKeys.current[item.id]!;
                const status = statuses[item.id]?.key === statusKey ? statuses[item.id]!.result : undefined;
                const job = jobs.find((value) => value.appId === item.id);
                const target = job?.profileId
                  ? settings.profiles.find((value) => value.id === job.profileId && value.agent === item.id)
                  : settings.profiles.find(
                      (value) => value.id === applyTargets[job?.id || ''] && value.agent === item.id,
                    ) || profile;
                const defaultApp =
                  settings.profiles.find((value) => value.id === settings.defaultProfileId)?.agent ===
                  item.id;
                const applied = !!job?.result && target?.image === job.result.image;
                return (
                  <article key={item.id} className="cli-app-row" data-app={item.id}>
                    <span className={`cli-app-glyph ${item.id}`} aria-hidden="true">
                      {item.id === 'codex'
                        ? '⌘'
                        : item.id === 'dsh'
                          ? 'D'
                          : item.id === 'claude'
                            ? '✳'
                            : item.id === 'gemini'
                              ? '✦'
                              : '>_'}
                    </span>
                    <div className="cli-app-info">
                      <div className="cli-app-title">
                        <h4>{item.label}</h4>
                        {defaultApp && <span className="terminal-control-tag">默认</span>}
                      </div>
                      <p>{item.description}</p>
                      <label className="cli-api-binding">
                        <span>API 连接</span>
                        <select
                          aria-label={`${item.label} API 连接`}
                          value={entry.connectionId || ''}
                          disabled={busy}
                          onChange={(event) =>
                            void perform(() =>
                              saveApps({
                                ...overview.apps,
                                entries: overview.apps.entries.map((value) =>
                                  value.id === item.id
                                    ? { ...value, connectionId: event.target.value || null }
                                    : value,
                                ),
                              }),
                            )
                          }
                        >
                          <option value="">模板环境变量</option>
                          {overview.connections
                            .filter((connection) => item.protocols.includes(connection.protocol))
                            .map((connection) => (
                              <option key={connection.id} value={connection.id}>
                                {connection.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                    <div className="cli-app-version">
                      <span className={status?.available ? 'connected' : ''}>
                        {job?.status === 'running'
                          ? '安装中…'
                          : status?.version ||
                            (job?.status === 'completed' && job.result
                              ? `已构建 ${job.result.version}`
                              : '尚未检查')}
                      </span>
                      {status && <small>{status.message}</small>}
                      {job?.status === 'cancelled' && <small>安装已取消</small>}
                      {job?.status === 'failed' && <small className="cli-app-error">{job.message}</small>}
                      {job?.status === 'completed' && !applied && (
                        <>
                          {!job.profileId && (
                            <select
                              aria-label={`${item.label} 镜像目标模板`}
                              value={target?.id || ''}
                              disabled={busy}
                              onChange={(event) =>
                                setApplyTargets((current) => ({ ...current, [job.id]: event.target.value }))
                              }
                            >
                              <option value="">先启用应用并选择模板</option>
                              {settings.profiles
                                .filter((value) => value.agent === item.id)
                                .map((value) => (
                                  <option key={value.id} value={value.id}>
                                    {value.label}
                                  </option>
                                ))}
                            </select>
                          )}
                          {job.profileId && !target && <small>原模板已删除，请重新安装。</small>}
                          <button
                            className="text-button"
                            disabled={busy || !target}
                            onClick={() =>
                              void perform(async () => {
                                const next = await mutation<SurfaceTerminalSettings>(
                                  `/terminal/control/installations/${job.id}/apply`,
                                  {
                                    profileId: target!.id,
                                    expectedRevision: settings.revision,
                                  },
                                );
                                savedSettings(next);
                                setNotice('镜像已保存，供新任务使用。');
                              })
                            }
                          >
                            应用已安装镜像
                          </button>
                        </>
                      )}
                    </div>
                    <div className="cli-app-actions">
                      <button
                        className="secondary"
                        disabled={busy || !!checking || job?.status === 'running'}
                        onClick={async () => {
                          setChecking(item.id);
                          setError('');
                          try {
                            const result = await api<CliStatus>(
                              `/terminal/control/apps/${item.id}/check`,
                              profile ? { profileId: profile.id } : {},
                            );
                            if (profileKeys.current[item.id] === statusKey)
                              setStatuses((current) => ({
                                ...current,
                                [item.id]: { key: statusKey, result },
                              }));
                          } catch (issue) {
                            if (profileKeys.current[item.id] === statusKey) setError(message(issue));
                          } finally {
                            setChecking(null);
                          }
                        }}
                      >
                        {checking === item.id ? '检查中…' : '检查'}
                      </button>
                      {item.id !== 'custom' && (
                        <button
                          className="secondary"
                          disabled={busy || running}
                          onClick={() =>
                            void perform(async () => {
                              const installed = await mutation<TerminalCliInstallationJob>(
                                `/terminal/control/apps/${item.id}/install`,
                                {
                                  ...(profile ? { profileId: profile.id } : {}),
                                  ...(versions[item.id]?.trim()
                                    ? { version: versions[item.id]!.trim() }
                                    : {}),
                                },
                              );
                              setJobs((current) => [
                                installed,
                                ...current.filter((value) => value.id !== installed.id),
                              ]);
                              setNotice('安装已开始，可继续使用工作台。完成后应用新镜像。');
                            })
                          }
                        >
                          {job?.status === 'running'
                            ? '安装中…'
                            : status?.installed || applied
                              ? '更新'
                              : '安装'}
                        </button>
                      )}
                      {job?.status === 'running' && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              const cancelled = await mutation<TerminalCliInstallationJob>(
                                `/terminal/control/installations/${job.id}/cancel`,
                                { expectedRevision: job.revision },
                              );
                              setJobs((current) =>
                                current.map((value) => (value.id === job.id ? cancelled : value)),
                              );
                              setNotice('安装已取消。');
                            })
                          }
                        >
                          取消安装
                        </button>
                      )}
                      <button
                        className="text-button"
                        disabled={busy || defaultApp}
                        onClick={() =>
                          void perform(async () => {
                            await saveApps({
                              ...overview.apps,
                              defaultAppId: item.id,
                              entries: overview.apps.entries.map((value) =>
                                value.id === item.id ? { ...value, visible: true } : value,
                              ),
                            });
                          })
                        }
                      >
                        {defaultApp ? '默认应用' : '设为默认'}
                      </button>
                    </div>
                    <label className="cli-visibility">
                      <span>显示</span>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`显示 ${item.label}`}
                        checked={entry.visible}
                        disabled={busy || defaultApp}
                        onChange={(event) => {
                          const visible = event.target.checked;
                          void perform(async () => {
                            await saveApps({
                              ...overview.apps,
                              entries: overview.apps.entries.map((value) =>
                                value.id === item.id ? { ...value, visible } : value,
                              ),
                            });
                          });
                        }}
                      />
                    </label>
                  </article>
                );
              })}
            </div>
            <details className="cli-install-options">
              <summary>安装选项</summary>
              <p className="field-help">留空使用内置固定版本；更新也创建新镜像。</p>
              <div className="form-columns">
                {overview.catalog
                  .filter((item) => item.id !== 'custom')
                  .map((item) => (
                    <label key={item.id}>
                      {item.label} 版本
                      <input
                        placeholder="内置版本"
                        value={versions[item.id] || ''}
                        disabled={busy || running}
                        onChange={(event) =>
                          setVersions((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                      />
                    </label>
                  ))}
              </div>
            </details>
          </>
        ) : tab === 'connections' ? (
          <div className="terminal-connection-layout">
            <aside className="terminal-connection-list">
              <div className="terminal-control-heading">
                <h3>API 连接</h3>
                <button
                  className="icon-button"
                  aria-label="新增 API 连接"
                  disabled={busy}
                  onClick={() => {
                    selectConnection(newConnection());
                  }}
                >
                  <Icon name="plus" />
                </button>
              </div>
              {overview.connections.map((connection) => (
                <button
                  type="button"
                  key={connection.id}
                  aria-current={draft?.id === connection.id ? 'true' : undefined}
                  disabled={busy}
                  onClick={() => {
                    selectConnection(connectionDraft(connection));
                  }}
                >
                  <strong>{connection.name}</strong>
                  <small>
                    {connection.keyConfigured ? '凭据已配置' : '待配置凭据'} ·{' '}
                    {protocolLabels[connection.protocol]}
                  </small>
                </button>
              ))}
              {!overview.connections.length && (
                <p className="field-help">添加连接后，可为各 CLI 单独选择。</p>
              )}
            </aside>
            {!draft ? (
              <div className="terminal-connection-empty">
                <Icon name="settings" size={32} />
                <h3>连接你的模型服务</h3>
                <p>端点、模型和凭据集中管理。</p>
                <button className="primary" onClick={() => selectConnection(newConnection())}>
                  添加 API 连接
                </button>
              </div>
            ) : (
              <form
                className="terminal-connection-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!validConnection) return;
                  void perform(async () => {
                    const saved = await mutation<TerminalConnectionView>(
                      `/terminal/control/connections/${draft.id}`,
                      draftBody!,
                      'PUT',
                    );
                    const next = {
                      ...overview,
                      connections: [...overview.connections.filter((item) => item.id !== saved.id), saved],
                    };
                    setOverview(next);
                    replaceConnection(connectionDraft(saved));
                    controlUpdated(next);
                    setNotice('API 连接已保存。');
                  });
                }}
              >
                {selectedConnection && draft.revision !== selectedConnection.revision && (
                  <div className="terminal-control-conflict" role="status">
                    <span>连接已更新，当前修改已保留。</span>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => replaceConnection(connectionDraft(selectedConnection))}
                    >
                      载入最新连接
                    </button>
                  </div>
                )}
                <label>
                  快速预设
                  <select
                    aria-label="API 快速预设"
                    defaultValue=""
                    disabled={busy}
                    onChange={(event) => {
                      if (event.target.value !== '')
                        setDraft((current) => ({
                          ...current!,
                          ...presets[Number(event.target.value)],
                          apiKey: '',
                        }));
                    }}
                  >
                    <option value="">选择服务…</option>
                    {presets.map((preset, index) => (
                      <option key={preset.name} value={index}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  连接名称
                  <input
                    value={draft.name}
                    disabled={busy}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    maxLength={80}
                  />
                </label>
                <div className="form-columns">
                  <label>
                    协议
                    <select
                      value={draft.protocol}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft({ ...draft, protocol: event.target.value as TerminalConnectionProtocol })
                      }
                    >
                      {Object.entries(protocolLabels).map(([protocol, label]) => (
                        <option key={protocol} value={protocol}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    模型 ID
                    <input
                      value={draft.model}
                      placeholder="服务商的模型 ID"
                      disabled={busy}
                      onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                      maxLength={200}
                    />
                  </label>
                </div>
                <label>
                  API 地址
                  <input
                    value={draft.baseUrl}
                    placeholder="https://api.example.com/v1"
                    disabled={busy}
                    onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                  />
                </label>
                <label>
                  凭据方式
                  <select
                    value={draft.credentialMode}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        credentialMode: event.target.value as 'vault' | 'environment',
                        apiKey: '',
                      })
                    }
                  >
                    <option value="vault">加密保存 API Key</option>
                    <option value="environment">读取环境变量</option>
                  </select>
                </label>
                {draft.credentialMode === 'vault' ? (
                  <label>
                    API Key
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={draft.apiKey}
                      placeholder={
                        selectedConnection?.auth.kind === 'vault' ? '已保存，留空保留原密钥' : '输入 API Key'
                      }
                      disabled={busy}
                      onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                    />
                  </label>
                ) : (
                  <label>
                    环境变量名称
                    <input
                      value={draft.apiKeyEnv}
                      placeholder="OPENAI_API_KEY"
                      disabled={busy}
                      onChange={(event) => setDraft({ ...draft, apiKeyEnv: event.target.value })}
                    />
                  </label>
                )}
                <p className="field-help">
                  Codex 使用 Responses，DSH 与 Claude 使用 Messages。现有任务保留创建时的连接。
                </p>
                <div className="terminal-control-form-actions">
                  <button className="primary" disabled={busy || !validConnection}>
                    {busy ? '保存中…' : '保存连接'}
                  </button>
                  {selectedConnection && (
                    <button
                      type="button"
                      className="text-button danger"
                      disabled={busy}
                      onClick={() => setDeleting(draft.id)}
                    >
                      删除连接
                    </button>
                  )}
                </div>
                {deleting === draft.id && (
                  <div className="terminal-delete-confirm" role="group" aria-label="删除连接确认">
                    <span>删除“{draft.name}”？已有任务保留原连接。</span>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => setDeleting(null)}
                    >
                      返回
                    </button>
                    <button
                      type="button"
                      className="secondary danger"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await mutation(
                            `/terminal/control/connections/${draft.id}`,
                            { expectedRevision: draft.revision },
                            'DELETE',
                          );
                          const editedProject = projectDirty ? projectDraft : null;
                          setDraft(null);
                          setConnectionBaseline(null);
                          setDeleting(null);
                          if (!projectDirty) {
                            setProjectDraft(null);
                            setProjectBaseline(null);
                          }
                          const prefs = await load();
                          if (editedProject && prefs) {
                            setProjectDraft({
                              ...editedProject,
                              revision: prefs.revision,
                              connectionId:
                                editedProject.connectionId === draft.id ? null : editedProject.connectionId,
                            });
                            setProjectBaseline(prefs);
                          }
                          setNotice('连接已删除。');
                        })
                      }
                    >
                      确认删除
                    </button>
                  </div>
                )}
              </form>
            )}
          </div>
        ) : tab === 'project' ? (
          project && projectDraft ? (
            <form
              className="terminal-project-defaults"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  const saved = await mutation<TerminalProjectPreferences>(
                    `/terminal/control/projects/${project.id}/preferences`,
                    {
                      expectedRevision: projectDraft.revision,
                      defaultProfileId: projectDraft.defaultProfileId,
                      connectionId: projectDraft.connectionId,
                    },
                    'PUT',
                  );
                  setPreferences(saved);
                  setProjectDraft(saved);
                  setProjectBaseline(saved);
                  setPending(null);
                  controlUpdated(overview, saved);
                  setNotice('项目默认配置已保存。');
                });
              }}
            >
              {preferences && projectDraft.revision !== preferences.revision && (
                <div className="terminal-control-conflict" role="status">
                  <span>项目默认已更新，当前修改已保留。</span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setProjectDraft(preferences);
                      setProjectBaseline(preferences);
                    }}
                  >
                    载入最新项目默认
                  </button>
                </div>
              )}
              <div className="terminal-control-heading">
                <div>
                  <h3>{project.name}</h3>
                  <p>仅作用于此项目的新任务。</p>
                </div>
              </div>
              <label>
                默认 CLI 模板
                <select
                  value={projectDraft.defaultProfileId || ''}
                  disabled={busy}
                  onChange={(event) =>
                    setProjectDraft({
                      ...projectDraft,
                      defaultProfileId: event.target.value || null,
                      connectionId: null,
                    })
                  }
                >
                  <option value="">跟随默认应用</option>
                  {settings.profiles
                    .filter((profile) =>
                      overview.apps.entries.some((entry) => entry.id === profile.agent && entry.visible),
                    )
                    .map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                默认 API 连接
                <select
                  value={projectDraft.connectionId || ''}
                  disabled={busy}
                  onChange={(event) =>
                    setProjectDraft({ ...projectDraft, connectionId: event.target.value || null })
                  }
                >
                  <option value="">跟随应用连接</option>
                  {overview.connections
                    .filter((connection) => projectProtocols.includes(connection.protocol))
                    .map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name}
                      </option>
                    ))}
                </select>
              </label>
              <button className="primary" disabled={busy || !projectDirty}>
                保存项目默认
              </button>
            </form>
          ) : (
            <div className="terminal-connection-empty">
              <Icon name="folder" size={32} />
              <h3>先选择一个项目</h3>
              <p>在工作台打开项目后，可在此设置独立的 CLI 与 API 连接。</p>
            </div>
          )
        ) : null}
        {(templateVisited || tab === 'templates') && (
          <Activity mode={tab === 'templates' ? 'visible' : 'hidden'}>
            <TerminalSettings
              initial={settings}
              embedded
              close={() => setTab('apps')}
              dirtyChanged={setTemplateDirty}
              updated={async (next) => {
                savedSettings(next);
                try {
                  await load();
                } catch (issue) {
                  setError(message(issue));
                }
                setNotice('模板已保存。');
              }}
              activity={(value) => {
                setBusy(value);
                activity(value);
              }}
            />
          </Activity>
        )}
      </div>
      {tab !== 'templates' && (
        <footer className="modal-footer">
          <span className="field-help">CLI 在 Docker 中运行</span>
          <button className="secondary" disabled={busy} onClick={requestClose}>
            完成
          </button>
        </footer>
      )}
    </Modal>
  );
}
