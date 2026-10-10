import { useEffect, useRef, useState } from 'react';
import { useSurfaceClient } from './SurfaceClientContext';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { MarkdownDocument } from './MarkdownDocument';
import './local-agents.css';
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
  return (
    <Modal
      title="Skills、记忆与 MCP"
      subtitle="同步本机 Agent 的能力与经验"
      close={close}
      wide
      className="local-agent-modal"
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
        <p className="field-help">
          {tab === 'skill'
            ? '仅加载技能名称和说明；模型按任务需要读取正文与参考文件。'
            : tab === 'memory'
              ? '选中的记忆作为参考资料保存，按需搜索和回查，不整份塞入对话。'
              : '同步配置后默认关闭。启用后可检查连接，调用遵守任务的命令、写入与 URL 权限。'}
        </p>
        <details className="local-agent-sync">
          <summary>
            <Icon name="plus" size={16} />
            同步本机 Agent
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
              <small className="local-agent-path">{scan.source.root}</small>
              {scan.warnings.map((warning, index) => (
                <p className="field-help" key={index}>
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
                  <div className="local-agent-candidate-list">
                    {scan.candidates.map((entry) => (
                      <label key={entry.id}>
                        <input
                          type="checkbox"
                          disabled={!!busy}
                          checked={selected.includes(entry.id)}
                          onChange={(event) =>
                            setSelected((old) =>
                              event.target.checked ? [...old, entry.id] : old.filter((id) => id !== entry.id),
                            )
                          }
                        />
                        <span>
                          <strong>{entry.name}</strong>
                          <small>
                            {tabs.find(([key]) => key === entry.kind)?.[1]} · {entry.path}
                          </small>
                          {entry.description && <small>{entry.description}</small>}
                        </span>
                      </label>
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
            </div>
          )}
        </details>
        <div className="local-agent-toolbar">
          <label>
            <Icon name="search" size={16} />
            <input
              aria-label="搜索本机能力"
              placeholder="搜索名称或说明…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button
            className="quiet-button"
            disabled={!!busy}
            aria-label="刷新本机能力"
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
          <p className="inline-warning" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="field-help" role="status">
            {notice}
          </p>
        )}
        {!overview && !error && <p role="status">正在读取本机能力…</p>}
        {overview && !rows.length && (
          <div className="local-agent-empty">
            {search ? '没有匹配的条目。' : `尚未同步${tabs.find(([key]) => key === tab)?.[1]}。`}
          </div>
        )}
        <ul className="local-agent-list">
          {rows.map((entry) => (
            <li key={entry.id}>
              <div className="local-agent-entry">
                <Icon name={tabs.find(([key]) => key === entry.kind)?.[2] || 'file'} size={19} />
                <button className="local-agent-title" disabled={!!busy} onClick={() => inspect(entry)}>
                  <strong>{entry.name}</strong>
                  <span>{entry.description || entry.path || ''}</span>
                  <small>
                    {sources.find(([key]) => key === entry.sourceKind)?.[1] || '本机'} ·{' '}
                    {entry.enabled ? '已启用' : '已关闭'}
                    {entry.kind === 'skill' && entry.modelInvocable === false && ' · 禁止模型调用'}
                  </small>
                </button>
              </div>
              <div className="local-agent-actions">
                <button
                  className="secondary"
                  disabled={!!busy}
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
                  disabled={!!busy}
                  onClick={() => setRemove(remove === entry.id ? '' : entry.id)}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
              {remove === entry.id && (
                <div className="local-agent-confirm" role="status">
                  <span>从 Elysia 移除该条目？来源文件会保留。</span>
                  <button className="secondary" disabled={!!busy} onClick={() => setRemove('')}>
                    取消
                  </button>
                  <button
                    className="danger"
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
                  <p className="field-help">
                    envNames、headerEnv 与 bearerTokenEnv 只填写环境变量名称，不填写密钥。核对命令或 URL
                    后，将 needsConfiguration 改为 false。此修改只保存到 Elysia。
                  </p>
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
          <section className="local-agent-preview" aria-label="同步内容预览">
            <header>
              <strong>{view.item.name}</strong>
              <button
                className="quiet-button"
                aria-label="关闭内容预览"
                disabled={!!busy}
                onClick={() => setView(undefined)}
              >
                <Icon name="close" size={16} />
              </button>
            </header>
            {view.item.kind === 'skill' ? (
              <>
                <p className="field-help">{view.item.description}</p>
                <MarkdownDocument text={view.pages.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')} />
              </>
            ) : (
              <pre>{view.pages}</pre>
            )}
            {view.nextOffset != null && (
              <button className="secondary" disabled={!!busy} onClick={() => inspect(view.item, true)}>
                读取下一段
              </button>
            )}
          </section>
        )}
        {tools && (
          <section className="local-agent-preview" aria-label="MCP 工具目录">
            <header>
              <strong>可用工具（{tools.tools.length}）</strong>
              <button className="quiet-button" aria-label="关闭工具目录" onClick={() => setTools(undefined)}>
                <Icon name="close" size={16} />
              </button>
            </header>
            {tools.tools.map((tool) => (
              <div key={tool.name}>
                <strong>{tool.name}</strong>
                <p className="field-help">{tool.description}</p>
              </div>
            ))}
          </section>
        )}
      </div>
      <footer className="modal-footer">
        <span className="field-help">{busy ? `${busy}中…` : '同步不会修改来源配置或已有对话。'}</span>
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
