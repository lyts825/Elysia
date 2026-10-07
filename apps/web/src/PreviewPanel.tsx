import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { api } from './api';
import type { Agent, Artifact, Message, Operation, Task } from '../../../packages/contracts/src/index';
import type { PreviewFile, PreviewSnapshot } from '../../../packages/contracts/src/preview';
import './preview.css';

const labels: Record<string, string> = {
  READY: '就绪',
  RUNNING: '执行中',
  WAITING: '等待',
  VERIFYING: '待验收',
  DONE: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  DRAFT: '待开始',
};
type Props = {
  runId: string;
  tasks: Task[];
  agents: Agent[];
  messages: Message[];
  operations: Operation[];
  artifacts: Artifact[];
  streaming: Record<string, string>;
  selectedTaskId: string;
  selectTask: (id: string) => void;
  close: () => void;
};
export function PreviewPanel({
  runId,
  tasks,
  agents,
  messages,
  operations,
  artifacts,
  streaming,
  selectedTaskId,
  selectTask,
  close,
}: Props) {
  const task = tasks.find((t) => t.id === selectedTaskId) || tasks[0];
  const taskId = task?.id || '',
    agent = agents.find((a) => a.taskId === taskId);
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null);
  const [filesByTask, setFilesByTask] = useState<Record<string, string>>({});
  const [content, setContent] = useState<PreviewFile | null>(null);
  const [view, setView] = useState('page'),
    [auto, setAuto] = useState(true),
    [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState(''),
    [error, setError] = useState(''),
    [updated, setUpdated] = useState('');
  const [viewport, setViewport] = useState('desktop'),
    [wide, setWide] = useState(false);
  const [loading, setLoading] = useState(false);
  const selected = filesByTask[taskId] || '';
  useEffect(() => {
    setSnapshot(null);
    setContent(null);
    setError('');
    setUpdated('');
  }, [taskId]);
  useEffect(() => {
    if (!taskId) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<PreviewSnapshot>(`/runs/${runId}/tasks/${taskId}/preview`);
        if (disposed) return;
        setSnapshot((old) =>
          old?.taskId === taskId && old.revision === next.revision && old.renderBase === next.renderBase
            ? old
            : next,
        );
        setFilesByTask((old) => {
          if (next.files.some((f) => f.path === old[taskId])) return old;
          const first =
            next.files.find((f) => f.change !== 'D' && /(?:dist|build|out)\/index\.html?$/.test(f.path)) ||
            next.files.find((f) => f.change !== 'D' && /(^|\/)index\.html?$/.test(f.path)) ||
            next.files.find((f) => f.change !== 'D' && /\.(html?|md|markdown)$/i.test(f.path)) ||
            next.files[0];
          return { ...old, [taskId]: first?.path || '' };
        });
        setUpdated(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
        setError('');
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        if (!disposed && auto) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [runId, taskId, auto, refresh]);
  useEffect(() => {
    setContent(null);
    if (!selected) return;
    let disposed = false;
    setLoading(true);
    api<PreviewFile>(`/runs/${runId}/tasks/${taskId}/preview/file?path=${encodeURIComponent(selected)}`)
      .then((result) => {
        if (!disposed) {
          setContent(result);
          setError('');
        }
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [runId, taskId, selected, snapshot?.revision, refresh]);
  const current = snapshot?.taskId === taskId ? snapshot : null;
  const visible = current?.files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())) || [];
  const selectedFile = content?.path === selected ? content : null;
  const resourceUrl =
    current?.renderBase && selected
      ? current.renderBase + selected.split('/').map(encodeURIComponent).join('/')
      : '';
  const liveMessages = messages.filter((m) => m.sessionId === agent?.sessionId && m.role !== 'tool');
  const agentOperations = operations
    .filter((o) => o.taskId === taskId)
    .slice(-30)
    .reverse();
  return (
    <aside className={'preview-panel' + (wide ? ' preview-expanded' : '')} aria-label="代理工作预览">
      <header className="preview-heading">
        <div>
          <span className="preview-glyph">▧</span>
          <strong>工作预览</strong>
          <span className="preview-label">LIVE WORKSPACE</span>
        </div>
        <div>
          <button
            className="icon-button"
            onClick={() => setWide(!wide)}
            aria-label={wide ? '收起预览' : '展开预览'}
          >
            {wide ? '↙' : '↗'}
          </button>
          <button className="icon-button" onClick={close} aria-label="关闭预览">
            ×
          </button>
        </div>
      </header>
      <div className="preview-agent-picker">
        <label htmlFor="preview-agent">查看代理</label>
        <select id="preview-agent" value={taskId} onChange={(e) => selectTask(e.target.value)}>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {'　'.repeat(t.depth)}
              {t.spec.role === 'coordinator' ? '总代理' : t.spec.title} · {labels[t.status]}
            </option>
          ))}
        </select>
        <span className={'status-dot ' + (task?.status.toLowerCase() || '')} />
      </div>
      <div className="preview-agent-info">
        <span>{agent?.providerBinding.model || task?.spec.providerId}</span>
        <span>
          {task?.spec.mode.toUpperCase()} · 深度 {task?.depth ?? 0}
        </span>
        <strong>{labels[task?.status || '']}</strong>
      </div>
      <nav className="preview-tabs" aria-label="预览视图">
        {[
          ['page', '页面'],
          ['diff', '更改'],
          ['source', '源文件'],
          ['activity', '代理动态'],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setView(key)} className={view === key ? 'active' : ''}>
            {label}
            {key === 'diff' && <small>{current?.files.filter((f) => f.change).length || 0}</small>}
          </button>
        ))}
      </nav>
      <div className="preview-tools">
        <label>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          自动更新
        </label>
        <span className="preview-timestamp">{updated ? `${updated} 已同步` : '正在连接…'}</span>
        <button onClick={() => setRefresh((n) => n + 1)} aria-label="刷新预览">
          ↻
        </button>
      </div>
      {error && (
        <div role="alert" className="preview-error">
          {error}
          <button onClick={() => setRefresh((n) => n + 1)}>重试</button>
        </div>
      )}
      {view === 'activity' ? (
        <div className="preview-activity">
          <h3>{task?.spec.title}</h3>
          <p className="preview-objective">{task?.spec.objective}</p>
          {task?.waitReason && <div className="preview-wait">等待原因：{task.waitReason}</div>}
          {streaming[taskId] && (
            <article className="preview-stream">
              <small>
                <i />
                正在生成
              </small>
              <p>{streaming[taskId]}</p>
            </article>
          )}
          <h4>
            会话记录 <span>{liveMessages.length}</span>
          </h4>
          {liveMessages
            .slice(-12)
            .reverse()
            .map((m) => (
              <article key={m.id}>
                <small>
                  {m.role === 'user' ? '用户 / 交接' : '代理'} · #{m.ordinal}
                </small>
                <p>{m.text || m.calls?.map((c) => c.name).join(' · ')}</p>
              </article>
            ))}
          {!liveMessages.length && <p className="preview-muted">此代理还没有会话记录。</p>}
          <h4>
            工具操作 <span>{agentOperations.length}</span>
          </h4>
          {agentOperations.map((o) => (
            <details key={o.id}>
              <summary>
                <code>{o.name}</code>
                <span className={'op-status ' + o.status.toLowerCase()}>{o.status}</span>
              </summary>
              <pre>{JSON.stringify({ arguments: o.args, result: o.result, error: o.error }, null, 2)}</pre>
            </details>
          ))}
          <h4>产物</h4>
          {artifacts
            .filter((a) => a.taskId === taskId)
            .map((a) => (
              <div className="preview-artifact" key={a.id}>
                <span>▤ {a.name}</span>
                <small>
                  v{a.version} · {a.verified ? '已核验' : '待核验'}
                </small>
              </div>
            ))}
        </div>
      ) : (
        <>
          <div className="preview-file-bar">
            <input
              aria-label="筛选预览文件"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索文件…"
            />
            <select
              aria-label="预览文件"
              value={visible.some((f) => f.path === selected) ? selected : ''}
              onChange={(e) => setFilesByTask((old) => ({ ...old, [taskId]: e.target.value }))}
            >
              <option value="" disabled>
                {visible.length ? '选择文件' : '暂无文件'}
              </option>
              {visible.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.change ? f.change + ' · ' : ''}
                  {f.path}
                </option>
              ))}
            </select>
          </div>
          {current?.truncated && (
            <p className="preview-limit">文件列表最多展示 1,500 项；部分目录或文件不可读取。</p>
          )}
          <div className="preview-canvas">
            {!current?.workspace ? (
              <PreviewEmpty
                title="代理工作区尚未就绪"
                text="代理开始执行后，将在这里展示其文件、差异和页面。现在可查看“代理动态”。"
              />
            ) : !selected ? (
              <PreviewEmpty
                title="等待第一个文件"
                text="代理创建文件后会自动显示，也可以切换到其他代理查看进展。"
              />
            ) : loading ? (
              <div className="preview-loading">正在读取文件…</div>
            ) : selectedFile ? (
              view === 'diff' ? (
                <div className="preview-diff">
                  {selectedFile.diff ? (
                    <pre>
                      {selectedFile.diff.split('\n').map((line, i) => (
                        <div
                          key={i}
                          className={
                            line.startsWith('+')
                              ? 'addition'
                              : line.startsWith('-')
                                ? 'deletion'
                                : line.startsWith('@@')
                                  ? 'hunk'
                                  : ''
                          }
                        >
                          <span>{line || ' '}</span>
                        </div>
                      ))}
                    </pre>
                  ) : (
                    <PreviewEmpty
                      title="此文件没有文本差异"
                      text={
                        selectedFile.kind === 'image' || selectedFile.kind === 'binary'
                          ? '二进制文件请通过页面视图检查。'
                          : '文件与任务基线一致。'
                      }
                    />
                  )}
                  {selectedFile.diffTruncated && (
                    <p className="preview-limit">差异超过 1 MiB 或 12,000 行，已截断。</p>
                  )}
                </div>
              ) : view === 'source' ? (
                selectedFile.text !== null ? (
                  <pre className="preview-source">{selectedFile.text}</pre>
                ) : (
                  <PreviewEmpty
                    title={selectedFile.deleted ? '文件已删除' : '二进制文件'}
                    text="切换到更改或页面视图查看。"
                  />
                )
              ) : selectedFile.deleted ? (
                <PreviewEmpty title="文件已删除" text="切换到“更改”查看删除内容。" />
              ) : selectedFile.kind === 'html' ? (
                <div className={'preview-page ' + viewport}>
                  {/(?:src|href)\s*=\s*["'][^"']+\.(?:tsx?|jsx)(?:\?[^"']*)?["']/i.test(
                    selectedFile.text || '',
                  ) && (
                    <div className="preview-format-note">
                      此入口引用未编译的源码。请先构建项目，再选择 dist、build 或 out 中的 HTML 入口。
                    </div>
                  )}
                  <div className="preview-address">
                    <span title={selected}>◉ {selected}</span>
                    <div>
                      <button
                        className={viewport === 'desktop' ? 'active' : ''}
                        onClick={() => setViewport('desktop')}
                      >
                        桌面
                      </button>
                      <button
                        className={viewport === 'mobile' ? 'active' : ''}
                        onClick={() => setViewport('mobile')}
                      >
                        手机
                      </button>
                    </div>
                  </div>
                  <iframe
                    title={`${task?.spec.title} · ${selected}`}
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    key={taskId + selected + current.revision + refresh}
                    src={selectedFile.renderUrl || resourceUrl}
                  />
                </div>
              ) : selectedFile.kind === 'markdown' ? (
                <article className="preview-markdown">
                  <Markdown
                    skipHtml
                    components={{
                      a: ({ children }) => <span className="preview-link">{children}</span>,
                      img: () => <em>［图片请从文件列表打开］</em>,
                    }}
                  >
                    {selectedFile.text || ''}
                  </Markdown>
                </article>
              ) : selectedFile.kind === 'image' ? (
                <div className="preview-image">
                  <img src={resourceUrl + '?v=' + selectedFile.hash} alt={selected} />
                </div>
              ) : (
                <>
                  <div className="preview-format-note">
                    {selectedFile.kind === 'binary'
                      ? '此格式支持文件查看，暂不提供渲染。'
                      : '此文件以源代码显示；选择 HTML、Markdown 或图片可查看渲染结果。'}
                  </div>
                  <pre className="preview-source">{selectedFile.text}</pre>
                </>
              )
            ) : (
              <PreviewEmpty
                title="无法读取当前文件"
                text="文件可能正在被写入；稍后自动重试或选择其他文件。"
              />
            )}
          </div>
        </>
      )}
      <footer className="preview-footer">
        <span title={current?.workspace || ''}>
          {current?.workspace ? '⌑ ' + current.workspace : '独立工作区'}
        </span>
        <small>{current?.baseline ? '基线 ' + current.baseline.slice(0, 8) : 'Work 文件'}</small>
      </footer>
    </aside>
  );
}
function PreviewEmpty({ title, text }: { title: string; text: string }) {
  return (
    <div className="preview-empty">
      <span>▧</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
