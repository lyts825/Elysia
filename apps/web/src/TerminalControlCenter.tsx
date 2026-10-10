import { useEffect, useId, useRef, useState } from 'react';
import {
  AgentTerminalProfile,
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
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [jobs, setJobs] = useState<TerminalCliInstallationJob[]>([]);
  const [statuses, setStatuses] = useState<Partial<Record<TerminalAppId, CliStatus>>>({});
  const [checking, setChecking] = useState<TerminalAppId | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [versions, setVersions] = useState<Partial<Record<TerminalAppId, string>>>({});
  const submitting = useRef(false);
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
    setProjectDraft((current) => current || prefs);
    updated(latestSettings);
    controlUpdated(control, prefs ?? undefined);
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
  async function perform(action: () => Promise<void>) {
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
    controlUpdated(control);
  }
  function savedSettings(next: SurfaceTerminalSettings) {
    setSettings(next);
    updated(next);
  }
  async function ensureProfile(appId: TerminalAppId, image?: string) {
    const item = overview!.catalog.find((entry) => entry.id === appId)!;
    let profile = settings.profiles.find((entry) => entry.agent === appId);
    if (profile && !image) return profile;
    profile = profile
      ? { ...profile, image: image! }
      : AgentTerminalProfile.parse({ ...item.preset, ...(image ? { image } : {}) });
    const profiles = settings.profiles.some((entry) => entry.id === profile!.id)
      ? settings.profiles.map((entry) => (entry.id === profile!.id ? profile! : entry))
      : [...settings.profiles, profile];
    const next = await mutation<SurfaceTerminalSettings>(
      '/terminal/settings',
      {
        expectedRevision: settings.revision,
        profiles,
        defaultProfileId: settings.defaultProfileId,
      },
      'PUT',
    );
    savedSettings(next);
    return profile;
  }
  const selectedConnection = overview?.connections.find((item) => item.id === draft?.id);
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
    settings.profiles.find((entry) => entry.agent === overview?.apps.defaultAppId) ||
    settings.profiles.find((entry) => entry.id === settings.defaultProfileId);
  const projectProtocols =
    overview?.catalog.find((entry) => entry.id === projectProfile?.agent)?.protocols || [];
  return (
    <Modal
      title="终端管理"
      subtitle="应用、API 连接与项目默认配置"
      close={close}
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
              setTab(id);
              setError('');
              setNotice('');
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
                setTab(target);
                document.getElementById(`${tabPrefix}-${target}`)?.focus();
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>
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
                const profile = settings.profiles.find((value) => value.agent === item.id);
                const status = statuses[item.id];
                const job = jobs.find((value) => value.appId === item.id);
                const defaultApp = overview.apps.defaultAppId === item.id;
                const applied = !!job?.result && profile?.image === job.result.image;
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
                      {job?.status === 'failed' && <small className="cli-app-error">{job.message}</small>}
                      {job?.status === 'completed' && !applied && (
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await ensureProfile(item.id, job.result!.image);
                              setStatuses((current) => ({
                                ...current,
                                [item.id]: {
                                  available: true,
                                  installed: true,
                                  version: job.result!.version,
                                  message: '已应用于新任务',
                                },
                              }));
                              setNotice('镜像已保存，供新任务使用。');
                            })
                          }
                        >
                          应用已安装镜像
                        </button>
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
                            setStatuses((current) => ({ ...current, [item.id]: result }));
                          } catch (issue) {
                            setError(message(issue));
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
                      <button
                        className="text-button"
                        disabled={busy || defaultApp}
                        onClick={() =>
                          void perform(async () => {
                            await ensureProfile(item.id);
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
                            if (visible) await ensureProfile(item.id);
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
                    setDraft(newConnection());
                    setDeleting(null);
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
                    setDraft(connectionDraft(connection));
                    setDeleting(null);
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
                <button className="primary" onClick={() => setDraft(newConnection())}>
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
                    setDraft(connectionDraft(saved));
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
                      onClick={() => setDraft(connectionDraft(selectedConnection))}
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
                          setDraft(null);
                          setDeleting(null);
                          setProjectDraft(null);
                          await load();
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
                    onClick={() => setProjectDraft(preferences)}
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
              <button
                className="primary"
                disabled={busy || JSON.stringify(projectDraft) === JSON.stringify(preferences)}
              >
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
        ) : (
          <TerminalSettings
            key={settings.revision}
            initial={settings}
            embedded
            close={() => setTab('apps')}
            updated={(next) => {
              savedSettings(next);
              setNotice('模板已保存。');
            }}
            activity={(value) => {
              setBusy(value);
              activity(value);
            }}
          />
        )}
      </div>
      {tab !== 'templates' && (
        <footer className="modal-footer">
          <span className="field-help">CLI 在 Docker 中运行</span>
          <button className="secondary" disabled={busy} onClick={close}>
            完成
          </button>
        </footer>
      )}
    </Modal>
  );
}
