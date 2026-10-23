import { useEffect, useId, useRef, useState } from 'react';
import { useSurfaceClient } from './SurfaceClientContext';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { MarkdownDocument } from './MarkdownDocument';
import './local-agents.css';
import './local-agent-settings.css';
import type {
  LocalAgentKind,
  LocalAgentCandidate,
  LocalAgentOverview,
  LocalAgentScan,
  LocalContentPage,
  LocalItemKind,
  LocalMcpConfig,
} from '../../../packages/contracts/src/local-integrations';

type Kind = LocalItemKind;
type SourceKind = LocalAgentKind;
type Entry = LocalAgentCandidate & { enabled?: boolean };
type Overview = LocalAgentOverview & { builtinSkills?: { id: string; name: string; description: string }[] };
type Scan = LocalAgentScan;
type Preview = LocalContentPage;
const sources: [SourceKind, string][] = [
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['dsh', 'DSH'],
];
const tabs: [Kind, string, string][] = [
  ['skill', 'Skills', 'spark'],
  ['memory', '记忆', 'history'],
  ['mcp', 'MCP', 'tree'],
];

export function LocalAgentSettings({ close }: { close: () => void }) {
  const { api } = useSurfaceClient();
  const identity = useId();
  const mutate = <T,>(path: string, body: Record<string, unknown>, signal: AbortSignal) =>
    api<T>(path, { commandId: crypto.randomUUID(), ...body }, 'POST', signal);
  const [overview, setOverview] = useState<Overview>();
  const [tab, setTab] = useState<Kind>('skill');
  const [kind, setKind] = useState<SourceKind>('codex');
  const [root, setRoot] = useState('');
  const [scan, setScan] = useState<Scan>();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState('读取');
  const [error, setError] = useState('');
  const [errorFeedback, setErrorFeedback] = useState(0);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<{ item: Entry; pages: string; nextOffset?: number | null }>();
  const [tools, setTools] = useState<{ id: string; tools: { name: string; description?: string }[] }>();
  const [remove, setRemove] = useState('');
  const [configEdit, setConfigEdit] = useState<{ id: string; json: string; revision: number }>();
  const alive = useRef(true);
  const pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  const viewSequence = useRef(0);
  const preview = useRef<HTMLElement | null>(null);
  const operationError = useRef<HTMLParagraphElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const contentTriggers = useRef(new Map<string, HTMLButtonElement>());
  const toolTriggers = useRef(new Map<string, HTMLButtonElement>());
  const restorePreviewFocus = (trigger?: HTMLButtonElement) => {
    if (trigger?.isConnected && !trigger.disabled) trigger.focus();
    else searchInput.current?.focus();
  };
  const reload = async (signal?: AbortSignal) => {
    const value = await api<Overview>('/local-agents', undefined, undefined, signal);
    if (alive.current && !signal?.aborted) setOverview(value);
    return value;
  };
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy('读取');
    reload(controller.signal)
      .catch((error: Error) => {
        if (!controller.signal.aborted && alive.current) setError(error.message);
      })
      .finally(() => {
        if (alive.current && request.current === controller) setBusy('');
      });
    return () => {
      alive.current = false;
      request.current?.abort();
      viewSequence.current++;
    };
  }, []);
  useEffect(() => {
    if (view || tools) preview.current?.scrollIntoView({ block: 'nearest' });
  }, [view?.item.id, tools?.id]);
  useEffect(() => {
    if (!errorFeedback) return;
    operationError.current?.focus();
    operationError.current?.scrollIntoView({ block: 'nearest' });
  }, [errorFeedback]);
  const act = async (label: string, operation: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await operation(controller.signal);
    } catch (error) {
      if (alive.current && !controller.signal.aborted) {
        setError(error instanceof Error ? error.message : '操作失败，请重试。');
        setErrorFeedback((value) => value + 1);
        try {
          await reload(controller.signal);
        } catch {
          /* Preserve the original error and current selection. */
        }
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy('');
    }
  };
  const inspect = (item: Entry, append = false) =>
    void act('读取内容', async (signal) => {
      const sequence = ++viewSequence.current;
      const offset = append && view?.item.id === item.id ? (view.nextOffset ?? 0) : 0;
      const page = await api<Preview>(
        `/local-agents/items/${encodeURIComponent(item.id)}?offset=${offset}&limit=16000`,
        undefined,
        undefined,
        signal,
      );
      if (!alive.current || sequence !== viewSequence.current) return;
      setView({
        item,
        pages: append ? `${view?.pages || ''}${page.text}`.slice(-64000) : page.text,
        nextOffset: page.nextOffset,
      });
      setTools(undefined);
    });
  const rows = (overview?.items || []).filter(
    (item) =>
      item.kind === tab &&
      `${item.name} ${item.description || ''} ${item.sourceKind || ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const currentTab = tabs.find(([key]) => key === tab)!;
  const total = overview?.items.filter((item) => item.kind === tab).length ?? 0;
  return (
    <Modal
      title="Skills、记忆与 MCP"
      subtitle="同步本机 Agent 的能力与经验"
      close={close}
      wide
      className="local-agent-modal local-capability-settings"
      busy={!!busy && busy !== '读取'}
    >
      <div className="local-agent-body">
        <div className="local-agent-tabs" role="tablist" aria-label="本机能力分类">
          {tabs.map(([key, label, icon]) => (
            <button
              type="button"
              key={key}
              role="tab"
              aria-selected={tab === key}
              disabled={!!busy}
              onClick={() => {
                setTab(key);
                setView(undefined);
                setTools(undefined);
                setRemove('');
              }}
            >
              <Icon name={icon} size={16} />
              {label}
            </button>
          ))}
        </div>
        <div className="local-agent-intro">
          <p className="field-help">
            {tab === 'skill'
              ? '技能按任务需要加载。'
              : tab === 'memory'
                ? '记忆按需搜索与回查。'
                : '连接同步后默认关闭。'}
          </p>
          <details className="local-agent-guidance">
            <summary>使用说明</summary>
            <p className="field-help">
              {tab === 'skill'
                ? '目录只加载名称和说明；模型按任务需要读取技能正文与参考文件。'
                : tab === 'memory'
                  ? '选中的记忆作为参考资料保存，按需搜索和回查，不整份加入对话。'
                  : '启用后可检查连接。调用遵守任务的命令、写入与 URL 权限。'}
            </p>
          </details>
        </div>
        <details className="local-agent-sync">
          <summary>
            <span className="local-agent-summary-label">
              <Icon name="plus" size={16} />
              同步本机 Agent
            </span>
            <Icon name="chevron" size={15} />
          </summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act('扫描', async (signal) => {
                const result = await api<Scan>(
                  '/local-agents/scan',
                  { kind, ...(root.trim() ? { root: root.trim() } : {}) },
                  'POST',
                  signal,
                );
                if (alive.current) {
                  setScan(result);
                  setSelected([]);
                  setNotice(
                    result.candidates.length
                      ? '选择需要同步的条目。'
                      : '未发现可同步条目，可修改来源目录后重试。',
                  );
                }
              });
            }}
          >
            <label>
              来源
              <select
                value={kind}
                disabled={!!busy}
                onChange={(event) => {
                  setKind(event.target.value as SourceKind);
                  setRoot('');
                  setScan(undefined);
                  setSelected([]);
                }}
              >
                {sources.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="local-agent-root">
              来源目录
              <input
                value={root}
                disabled={!!busy}
                placeholder="留空使用该 Agent 的默认目录"
                onChange={(event) => {
                  setRoot(event.target.value);
                  setScan(undefined);
                  setSelected([]);
                }}
              />
            </label>
            <button className="secondary" disabled={!!busy || !overview} type="submit">
              {busy === '扫描' ? '正在扫描…' : '扫描'}
            </button>
          </form>
          {!!overview?.defaults && (
            <div className="local-agent-source-paths">
              <small>默认目录</small>
              {overview.defaults
                .find((source) => source.kind === kind)
                ?.roots.map((directory) => (
                  <button
                    className="text-button"
                    type="button"
                    disabled={!!busy}
                    key={directory}
                    title={directory}
                    onClick={() => {
                      setRoot(directory);
                      setScan(undefined);
                      setSelected([]);
                    }}
                  >
                    {directory}
                  </button>
                ))}
            </div>
          )}
          {!!overview?.sources.length && (
            <div className="local-agent-source-paths">
              <small>已同步来源</small>
              {overview.sources.map((source) => (
                <button
                  className="text-button"
                  type="button"
                  disabled={!!busy}
                  key={source.id}
                  title={`${source.name} · ${source.root}`}
                  onClick={() => {
                    setKind(source.kind);
                    setRoot(source.root);
                    setScan(undefined);
                    setSelected([]);
                  }}
                >
                  {source.name} · {source.root}
                </button>
              ))}
            </div>
          )}
          {scan && (
            <div className="local-agent-candidates">
              <div className="local-agent-scan-heading">
                <strong>扫描结果</strong>
                <small>
                  {scan.candidates.length} 个条目 · 已选 {selected.length} 项
                </small>
              </div>
              <small
                className="local-agent-path local-capability-reading"
                role="region"
                tabIndex={0}
                aria-label="本次扫描完整来源目录"
              >
                {scan.source.root}
              </small>
              {scan.warnings.map((warning, index) => (
                <p className="field-help local-agent-scan-warning" key={index}>
                  {warning}
                </p>
              ))}
              {!!scan.candidates.length && (
                <>
                  <label className="local-agent-select-all">
                    <input
                      type="checkbox"
                      disabled={!!busy}
                      checked={selected.length === scan.candidates.length}
                      onChange={(event) =>
                        setSelected(event.target.checked ? scan.candidates.map((entry) => entry.id) : [])
                      }
                    />
                    选择全部（{scan.candidates.length}）
                  </label>
                  <div
                    className="local-agent-candidate-list"
                    role="region"
                    aria-label="待同步条目列表"
                    tabIndex={0}
                  >
                    {scan.candidates.map((entry, index) => (
                      <article className="local-capability-candidate" key={entry.id}>
                        <h4
                          className="local-capability-reading"
                          tabIndex={0}
                          aria-label={`第 ${index + 1} 个候选完整名称`}
                          id={`${identity}-candidate-${index}`}
                        >
                          {entry.name}
                        </h4>
                        <label>
                          <input
                            type="checkbox"
                            disabled={!!busy}
                            checked={selected.includes(entry.id)}
                            aria-describedby={`${identity}-candidate-${index}`}
                            onChange={(event) =>
                              setSelected((old) =>
                                event.target.checked
                                  ? [...old, entry.id]
                                  : old.filter((id) => id !== entry.id),
                              )
                            }
                          />
                          同步此条目
                        </label>
                        <dl
                          className="local-capability-identity local-capability-reading"
                          role="region"
                          tabIndex={0}
                          aria-label={`第 ${index + 1} 个候选完整来源与说明`}
                        >
                          <div>
                            <dt>类型</dt>
                            <dd>{tabs.find(([key]) => key === entry.kind)?.[1]}</dd>
                          </div>
                          <div>
                            <dt>完整路径</dt>
                            <dd>{entry.path}</dd>
                          </div>
                          {entry.description && (
                            <div>
                              <dt>说明</dt>
                              <dd>{entry.description}</dd>
                            </div>
                          )}
                        </dl>
                      </article>
                    ))}
                  </div>
                  <button
                    className="primary"
                    disabled={!!busy || !selected.length}
                    onClick={() =>
                      void act('同步', async (signal) => {
                        const value = await mutate<Overview>(
                          '/local-agents/sync',
                          { scanId: scan.scanId, ids: selected, expectedRevision: overview!.revision },
                          signal,
                        );
                        if (alive.current) {
                          setOverview(value);
                          setScan(undefined);
                          setSelected([]);
                          setNotice('已同步选中的条目。再次扫描同一来源即可更新。');
                        }
                      })
                    }
                  >
                    {busy === '同步' ? '正在同步…' : `同步选中（${selected.length}）`}
                  </button>
                </>
              )}
              {!scan.candidates.length && (
                <p className="field-help local-agent-scan-empty">未发现条目，可调整来源目录后重新扫描。</p>
              )}
            </div>
          )}
        </details>
        <div className="local-agent-toolbar">
          <label>
            <Icon name="search" size={16} />
            <input
              ref={searchInput}
              aria-label="搜索本机能力"
              placeholder="搜索名称或说明…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {search && (
            <button
              type="button"
              className="secondary local-capability-clear-search"
              onClick={() => {
                setSearch('');
                searchInput.current?.focus();
              }}
            >
              清除筛选
            </button>
          )}
          <button
            className="quiet-button"
            disabled={!!busy}
            aria-label="刷新本机能力"
            title="刷新目录"
            onClick={() =>
              void act('读取', async (signal) => {
                await reload(signal);
              })
            }
          >
            <Icon name="refresh" size={16} />
          </button>
        </div>
        {error && (
          <p
            ref={operationError}
            className="inline-warning local-agent-error local-capability-reading"
            role="alert"
            tabIndex={0}
            aria-label="本机能力操作失败全文"
          >
            {error}
          </p>
        )}
        {notice && (
          <p className="field-help" role="status">
            {notice}
          </p>
        )}
        {!overview && !error && <p role="status">正在读取本机能力…</p>}
        {overview && busy === '读取' && (
          <p className="local-capability-read-status" role="status">
            正在重新读取，以下保留上次目录。
          </p>
        )}
        {overview && (
          <>
            <dl className="local-capability-summary" aria-label="已读本机能力目录状态">
              <div>
                <dt>已读目录版本</dt>
                <dd>{overview.revision}</dd>
              </div>
              <div>
                <dt>当前分类</dt>
                <dd>
                  {currentTab[1]} · 已显示 {rows.length} / {total} 项
                </dd>
              </div>
              <div>
                <dt>来源文件</dt>
                <dd>只读同步，修改保存在 Elysia</dd>
              </div>
            </dl>
            <div className="local-agent-section-heading">
              <h3>已同步{currentTab[1] === 'Skills' ? ' Skills' : currentTab[1]}</h3>
              <span>{search ? `${rows.length} / ${total}` : total}</span>
            </div>
          </>
        )}
        {overview && !rows.length && (
          <div className="local-agent-empty">
            <span className="local-agent-empty-icon">
              <Icon name={search ? 'search' : currentTab[2]} size={21} />
            </span>
            <strong>{search ? '没有匹配的条目' : `尚未同步${currentTab[1]}`}</strong>
            <p>{search ? '试试其他名称或说明。' : '展开上方同步入口，选择本机 Agent 的条目。'}</p>
          </div>
        )}
        <ul className="local-agent-list">
          {rows.map((entry, index) => (
            <li
              key={entry.id}
              data-previewing={view?.item.id === entry.id || tools?.id === entry.id || undefined}
            >
              <div className="local-agent-entry">
                <span className="local-agent-entry-icon">
                  <Icon name={tabs.find(([key]) => key === entry.kind)?.[2] || 'file'} size={18} />
                </span>
                <div className="local-capability-entry-content">
                  <h4
                    id={`${identity}-entry-${index}`}
                    className="local-capability-reading"
                    tabIndex={0}
                    aria-label={`已同步第 ${index + 1} 项完整名称`}
                  >
                    {entry.name}
                  </h4>
                  <p className="local-capability-entry-state">
                    <span>{sources.find(([key]) => key === entry.sourceKind)?.[1] || '本机'}</span>
                    <span className="local-agent-state" data-enabled={!!entry.enabled}>
                      {entry.enabled ? '已启用' : '已关闭'}
                    </span>
                    {entry.kind === 'skill' && entry.modelInvocable === false && <span>禁止模型调用</span>}
                  </p>
                  <details className="local-capability-source">
                    <summary>说明与完整来源</summary>
                    <dl
                      className="local-capability-identity local-capability-reading"
                      role="region"
                      tabIndex={0}
                      aria-label={`已同步第 ${index + 1} 项完整来源与说明`}
                    >
                      <div>
                        <dt>条目标识</dt>
                        <dd>{entry.id}</dd>
                      </div>
                      <div>
                        <dt>来源</dt>
                        <dd>{sources.find(([key]) => key === entry.sourceKind)?.[1] || '本机'}</dd>
                      </div>
                      <div>
                        <dt>完整路径</dt>
                        <dd>{entry.path}</dd>
                      </div>
                      <div>
                        <dt>说明</dt>
                        <dd>{entry.description || '未提供说明'}</dd>
                      </div>
                    </dl>
                  </details>
                  <button
                    ref={(node) => {
                      if (node) contentTriggers.current.set(entry.id, node);
                      else contentTriggers.current.delete(entry.id);
                    }}
                    className="text-button local-capability-preview"
                    disabled={!!busy}
                    title={entry.path}
                    aria-expanded={view?.item.id === entry.id}
                    aria-describedby={`${identity}-entry-${index}`}
                    onClick={() => inspect(entry)}
                  >
                    读取内容
                  </button>
                </div>
              </div>
              <div className="local-agent-actions">
                <button
                  className="secondary"
                  disabled={!!busy}
                  aria-describedby={`${identity}-entry-${index}`}
                  onClick={() =>
                    void act('保存', async (signal) => {
                      const value = await mutate<Overview>(
                        `/local-agents/items/${encodeURIComponent(entry.id)}`,
                        { enabled: !entry.enabled, expectedRevision: overview!.revision },
                        signal,
                      );
                      if (alive.current) {
                        setOverview(value);
                        setTools(undefined);
                      }
                    })
                  }
                >
                  {entry.enabled ? '关闭' : '启用'}
                </button>
                {entry.kind === 'mcp' && (
                  <button
                    className="secondary"
                    disabled={!!busy}
                    aria-expanded={configEdit?.id === entry.id}
                    onClick={() =>
                      setConfigEdit({
                        id: entry.id,
                        json: JSON.stringify(entry.config, null, 2),
                        revision: overview!.revision,
                      })
                    }
                  >
                    配置
                  </button>
                )}
                {entry.kind === 'mcp' && (
                  <button
                    ref={(node) => {
                      if (node) toolTriggers.current.set(entry.id, node);
                      else toolTriggers.current.delete(entry.id);
                    }}
                    className="secondary"
                    disabled={!!busy || !entry.enabled}
                    onClick={() =>
                      void act('检查连接', async (signal) => {
                        const value = await api<{ tools: { name: string; description?: string }[] }>(
                          `/local-agents/mcp/${encodeURIComponent(entry.id)}/check`,
                          {},
                          'POST',
                          signal,
                        );
                        if (alive.current) {
                          setTools({ id: entry.id, tools: value.tools });
                          setView(undefined);
                          setNotice(`连接可用，发现 ${value.tools.length} 个工具。`);
                        }
                      })
                    }
                  >
                    检查连接
                  </button>
                )}
                <button
                  className="quiet-button"
                  aria-label={`移除 ${entry.name}`}
                  aria-expanded={remove === entry.id}
                  disabled={!!busy}
                  onClick={() => setRemove(remove === entry.id ? '' : entry.id)}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
              {remove === entry.id && (
                <div className="local-agent-confirm" role="status">
                  <div className="local-agent-confirm-copy">
                    <strong>移除 {entry.name}？</strong>
                    <span>仅从 Elysia 移除，来源文件会保留。</span>
                  </div>
                  <button className="secondary" disabled={!!busy} onClick={() => setRemove('')}>
                    取消
                  </button>
                  <button
                    className="primary danger-confirm"
                    disabled={!!busy}
                    onClick={() =>
                      void act('移除', async (signal) => {
                        const value = await mutate<Overview>(
                          `/local-agents/items/${encodeURIComponent(entry.id)}`,
                          { remove: true, expectedRevision: overview!.revision },
                          signal,
                        );
                        if (alive.current) {
                          setOverview(value);
                          setRemove('');
                          if (view?.item.id === entry.id) setView(undefined);
                          if (configEdit?.id === entry.id) setConfigEdit(undefined);
                          setTools(undefined);
                        }
                      })
                    }
                  >
                    移除
                  </button>
                </div>
              )}
              {configEdit?.id === entry.id && (
                <form
                  className="local-agent-config"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act('保存配置', async (signal) => {
                      const config: LocalMcpConfig = JSON.parse(configEdit.json);
                      const value = await mutate<Overview>(
                        `/local-agents/items/${encodeURIComponent(entry.id)}`,
                        { config, expectedRevision: configEdit.revision },
                        signal,
                      );
                      if (alive.current) {
                        setOverview(value);
                        setConfigEdit(undefined);
                        setTools(undefined);
                        setNotice('已保存此 MCP 的本机配置。');
                      }
                    });
                  }}
                >
                  <label htmlFor="local-mcp-config">连接配置</label>
                  <p className="field-help">仅填写环境变量名称来引用密钥。</p>
                  <details className="local-agent-config-help">
                    <summary>配置字段说明</summary>
                    <p className="field-help">
                      envNames、headerEnv 与 bearerTokenEnv 使用环境变量名称。核对命令或 URL 后，将
                      needsConfiguration 改为 false。修改仅保存到 Elysia。
                    </p>
                  </details>
                  <textarea
                    id="local-mcp-config"
                    spellCheck={false}
                    value={configEdit.json}
                    disabled={!!busy}
                    onChange={(event) => setConfigEdit({ ...configEdit, json: event.target.value })}
                  />
                  {configEdit.revision !== overview?.revision && (
                    <p className="inline-warning">目录已变化。重新打开配置后再保存，当前编辑文本已保留。</p>
                  )}
                  <div className="local-agent-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={!!busy}
                      onClick={() => setConfigEdit(undefined)}
                    >
                      取消编辑
                    </button>
                    <button
                      className="primary"
                      type="submit"
                      disabled={!!busy || configEdit.revision !== overview?.revision}
                    >
                      保存配置
                    </button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
        {tab === 'skill' && !!overview?.builtinSkills?.length && (
          <details className="local-agent-builtins">
            <summary>内置技能（{overview.builtinSkills.length}）</summary>
            {overview.builtinSkills.map((entry) => (
              <div key={entry.id}>
                <strong>{entry.name}</strong>
                <p className="field-help">{entry.description}</p>
              </div>
            ))}
          </details>
        )}
        {view && (
          <section ref={preview} className="local-agent-preview" aria-label="同步内容预览">
            <header>
              <div>
                <small>内容预览</small>
                <strong className="local-capability-reading" tabIndex={0} aria-label="内容预览完整条目名称">
                  {view.item.name}
                </strong>
              </div>
              <button
                className="quiet-button"
                aria-label="关闭内容预览"
                disabled={!!busy}
                onClick={() => {
                  setView(undefined);
                  restorePreviewFocus(contentTriggers.current.get(view.item.id));
                }}
              >
                <Icon name="close" size={16} />
              </button>
            </header>
            <p className="local-agent-preview-source" title={view.item.path}>
              {sources.find(([key]) => key === view.item.sourceKind)?.[1] || '本机'} · {view.item.path}
            </p>
            <div
              className="local-agent-preview-content"
              role="region"
              aria-label={`${view.item.name}的预览正文`}
              tabIndex={0}
            >
              {view.item.kind === 'skill' ? (
                <>
                  <p className="field-help">{view.item.description}</p>
                  <MarkdownDocument text={view.pages.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')} />
                </>
              ) : (
                <pre>{view.pages}</pre>
              )}
            </div>
            {view.nextOffset != null && (
              <div className="local-agent-preview-more">
                <span>分段加载</span>
                <button className="secondary" disabled={!!busy} onClick={() => inspect(view.item, true)}>
                  读取下一段
                </button>
              </div>
            )}
          </section>
        )}
        {tools && (
          <section ref={preview} className="local-agent-preview local-agent-tools" aria-label="MCP 工具目录">
            <header>
              <div>
                <small>MCP 工具目录</small>
                <strong>可用工具（{tools.tools.length}）</strong>
              </div>
              <button
                className="quiet-button"
                aria-label="关闭工具目录"
                onClick={() => {
                  setTools(undefined);
                  restorePreviewFocus(toolTriggers.current.get(tools.id));
                }}
              >
                <Icon name="close" size={16} />
              </button>
            </header>
            <div
              className="local-agent-preview-content local-agent-tool-list"
              role="region"
              aria-label="MCP 可用工具列表"
              tabIndex={0}
            >
              {tools.tools.map((tool) => (
                <div className="local-agent-tool" key={tool.name}>
                  <strong>{tool.name}</strong>
                  <p className="field-help">{tool.description}</p>
                </div>
              ))}
              {!tools.tools.length && <p className="field-help">此连接暂未提供工具。</p>}
            </div>
          </section>
        )}
      </div>
      <footer className="modal-footer">
        <span className="field-help" role="status">
          {busy ? `${busy}中…` : '同步不会修改来源配置或已有对话。'}
        </span>
        {busy === '扫描' && (
          <button
            className="secondary"
            onClick={() => {
              request.current?.abort();
              setNotice('已取消扫描。');
            }}
          >
            取消扫描
          </button>
        )}
        <button className="secondary" disabled={!!busy && busy !== '读取'} onClick={close}>
          关闭
        </button>
      </footer>
    </Modal>
  );
}
