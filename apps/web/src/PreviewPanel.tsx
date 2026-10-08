import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { api } from './api';
import type { Agent, Artifact, Message, Operation, Task } from '../../../packages/contracts/src/index';
import type { PreviewFile, PreviewSnapshot } from '../../../packages/contracts/src/preview';
import { Icon } from './Icon';
import { EmptyArtwork } from './Brand';
import { MotionContent, MotionTabs, usePresenceMotion } from './Motion';
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
  const panel = useRef<HTMLElement>(null);
  const present = usePresenceMotion(panel, 'panel');
  const task = tasks.find((t) => t.id === selectedTaskId) || tasks[0];
  const taskId = task?.id || '',
    agent = agents.find((a) => a.taskId === taskId);
  const [snapshot, setSnapshot] = useState<(PreviewSnapshot & { runId: string }) | null>(null);
  const [filesByTask, setFilesByTask] = useState<Record<string, string>>({});
  const [content, setContent] = useState<(PreviewFile & { context: string }) | null>(null);
  const [view, setView] = useState('page'),
    [auto, setAuto] = useState(true),
    [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState(''),
    [snapshotError, setSnapshotError] = useState(''),
    [fileError, setFileError] = useState(''),
    [updated, setUpdated] = useState('');
  const [viewport, setViewport] = useState('desktop'),
    [wide, setWide] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fileRetryCount, setFileRetryCount] = useState(0),
    [fileRetryPending, setFileRetryPending] = useState(false);
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const fileRetries = useRef<{ cancel: () => void; resume: () => void } | null>(null);
  const selected = filesByTask[taskId] || '';
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const current = snapshot?.runId === runId && snapshot.taskId === taskId ? snapshot : null;
  const selectedEntry = current?.files.find((file) => file.path === selected);
  const context = JSON.stringify([
    runId,
    taskId,
    selected,
    current?.workspace,
    current?.baseline,
    current?.renderBase,
  ]);
  const selectedVersion = JSON.stringify(
    selectedEntry ? [selectedEntry.size, selectedEntry.modifiedAt, selectedEntry.change] : null,
  );
  useEffect(() => {
    setSnapshot(null);
    setContent(null);
    setSnapshotError('');
    setFileError('');
    setUpdated('');
  }, [runId, taskId]);
  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<PreviewSnapshot>(
          `/runs/${runId}/tasks/${taskId}/preview${selectedRef.current ? '?path=' + encodeURIComponent(selectedRef.current) : ''}`,
          undefined,
          undefined,
          controller.signal,
        );
        if (disposed) return;
        setSnapshot((old) =>
          old?.runId === runId &&
          old.taskId === taskId &&
          old.revision === next.revision &&
          old.renderBase === next.renderBase &&
          old.workspace === next.workspace &&
          old.baseline === next.baseline &&
          old.truncated === next.truncated
            ? old
            : { ...next, runId },
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
        setSnapshotError('');
      } catch (e) {
        if (!disposed) setSnapshotError((e as Error).message);
      } finally {
        if (!disposed && auto) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, taskId, auto, refresh]);
  useEffect(() => {
    setContent((old) => (old?.context === context ? old : null));
    setFileError('');
    setFileRetryCount(0);
    setFileRetryPending(false);
    setLoading(false);
    if (!selected || !current?.workspace || !selectedEntry) {
      setContent(null);
      return;
    }
    const controller = new AbortController();
    let disposed = false,
      attempts = 0,
      inFlight = false,
      failed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!disposed) setFileRetryPending(false);
    };
    const resume = () => {
      if (disposed || !autoRef.current || timer || inFlight || !failed || attempts >= 3) return;
      setFileRetryPending(true);
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed || !autoRef.current) return;
        setFileRetryPending(false);
        void read();
      }, 1000);
    };
    const read = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      failed = false;
      attempts++;
      setFileRetryCount(attempts - 1);
      setLoading(true);
      try {
        const result = await api<PreviewFile>(
          `/runs/${runId}/tasks/${taskId}/preview/file?path=${encodeURIComponent(selected)}`,
          undefined,
          undefined,
          controller.signal,
        );
        if (!disposed) {
          setContent({ ...result, context });
          setFileError('');
        }
      } catch (e) {
        if (!disposed) {
          failed = true;
          setFileError((e as Error).message);
        }
      } finally {
        inFlight = false;
        if (!disposed) {
          setLoading(false);
          resume();
        }
      }
    };
    const controls = { cancel, resume };
    fileRetries.current = controls;
    void read();
    return () => {
      disposed = true;
      controller.abort();
      cancel();
      if (fileRetries.current === controls) fileRetries.current = null;
    };
  }, [context, selectedVersion, refresh]);
  useEffect(() => {
    if (auto) fileRetries.current?.resume();
    else fileRetries.current?.cancel();
  }, [auto]);
  const visible = current?.files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())) || [];
  const selectedFile =
    selectedEntry && content?.context === context && content.path === selected ? content : null;
  const resourceUrl =
    current?.renderBase && selected
      ? current.renderBase + selected.split('/').map(encodeURIComponent).join('/')
      : '';
  const liveMessages = messages.filter((m) => m.sessionId === agent?.sessionId && m.role !== 'tool');
  const agentOperations = operations
    .filter((o) => o.taskId === taskId)
    .slice(-30)
    .reverse();
  const taskError =
    task?.status === 'FAILED' && task.result && typeof task.result === 'object' && 'error' in task.result
      ? typeof task.result.error === 'string'
        ? task.result.error
        : ''
      : '';
  return (
    <aside
      ref={panel}
      className={'preview-panel' + (wide ? ' preview-expanded' : '')}
      aria-label="代理工作预览"
      data-leaving={!present || undefined}
      inert={!present}
    >
      <header className="preview-heading">
        <div>
          <span className="preview-glyph">
            <Icon name="panel" size={19} />
          </span>
          <strong>工作预览</strong>
          <span className="preview-label">{tasks.length} 个代理</span>
        </div>
        <div>
          <button
            className="icon-button"
            onClick={() => setWide(!wide)}
            aria-label={wide ? '收起预览' : '展开预览'}
          >
            <Icon name={wide ? 'collapse' : 'expand'} size={17} />
          </button>
          <button
            className="icon-button"
            onClick={() => {
              document.querySelector<HTMLElement>('.preview-toggle')?.focus({ preventScroll: true });
              close();
            }}
            aria-label="关闭预览"
          >
            <Icon name="close" size={18} />
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
        <span>深度 {task?.depth ?? 0}</span>
        <strong>{labels[task?.status || '']}</strong>
      </div>
      <MotionTabs className="preview-tabs" label="预览视图" value={view}>
        {[
          ['page', '页面'],
          ['diff', '更改'],
          ['source', '源文件'],
          ['activity', '代理动态'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            aria-pressed={view === key}
            className={view === key ? 'active' : ''}
          >
            <Icon
              name={{ page: 'panel', diff: 'code', source: 'file', activity: 'tree' }[key] || 'file'}
              size={14}
            />
            {label}
            {key === 'diff' && <small>{current?.files.filter((f) => f.change).length || 0}</small>}
          </button>
        ))}
      </MotionTabs>
      <div className="preview-tools">
        <label>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          自动更新
        </label>
        <span className="preview-timestamp">
          {loading && selectedFile ? '正在更新当前文件…' : updated ? `${updated} 已同步` : '正在连接…'}
        </span>
        <button onClick={() => setRefresh((n) => n + 1)} aria-label="刷新预览">
          <Icon name="refresh" size={16} />
        </button>
      </div>
      {snapshotError && (
        <div role="alert" className="preview-error">
          <span>工作区同步失败：{snapshotError}</span>
          <button onClick={() => setRefresh((n) => n + 1)}>重试</button>
        </div>
      )}
      {fileError && (
        <div role="alert" className="preview-error">
          <span>
            文件读取失败：{fileError}
            <small>
              {fileRetryPending && auto
                ? `将自动重试（${fileRetryCount + 1}/2）…`
                : loading
                  ? `正在重试（${fileRetryCount}/2）…`
                  : fileRetryCount >= 2
                    ? '自动重试 2 次仍未成功，请手动重试。'
                    : '自动更新已关闭，请手动重试。'}
            </small>
          </span>
          <button disabled={loading} onClick={() => setRefresh((n) => n + 1)}>
            重试
          </button>
        </div>
      )}
      {view === 'activity' ? (
        <MotionContent className="preview-activity" motionKey={`${taskId}:activity:${wide}`}>
          <h3>{task?.spec.title}</h3>
          <p className="preview-objective">{task?.spec.objective}</p>
          {task?.waitReason && <div className="preview-wait">等待原因：{task.waitReason}</div>}
          {taskError && (
            <div className="preview-task-error" role="alert">
              <strong>执行失败</strong>
              <p>{taskError}</p>
            </div>
          )}
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
                <span>
                  <Icon name="file" size={15} /> {a.name}
                </span>
                <small>
                  v{a.version} · {a.verified ? '已核验' : '待核验'}
                </small>
              </div>
            ))}
        </MotionContent>
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
          {selectedEntry?.renderTruncated && (
            <p className="preview-limit">页面引用的本地资源超过 1,500 项，部分资源更新需手动刷新。</p>
          )}
          <MotionContent className="preview-canvas" motionKey={`${taskId}:${view}:${wide}`}>
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
            ) : loading && !selectedFile ? (
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
                        aria-pressed={viewport === 'desktop'}
                        onClick={() => setViewport('desktop')}
                      >
                        桌面
                      </button>
                      <button
                        className={viewport === 'mobile' ? 'active' : ''}
                        aria-pressed={viewport === 'mobile'}
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
                    key={JSON.stringify([
                      runId,
                      taskId,
                      selected,
                      selectedFile.hash,
                      selectedFile.renderUrl || resourceUrl,
                      selectedEntry?.renderRevision || 0,
                      refresh,
                    ])}
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
                text={
                  loading || fileRetryPending
                    ? '文件可能正在被写入，正在尝试重新读取。'
                    : '请点击上方“重试”或选择其他文件。'
                }
              />
            )}
          </MotionContent>
        </>
      )}
      <footer className="preview-footer">
        <span title={current?.workspace || ''}>
          {current?.workspace ? '⌑ ' + current.workspace : '独立工作区'}
        </span>
        <small>{current?.baseline ? '基线 ' + current.baseline.slice(0, 8) : '任务文件'}</small>
      </footer>
    </aside>
  );
}
function PreviewEmpty({ title, text }: { title: string; text: string }) {
  return (
    <div className="preview-empty">
      <EmptyArtwork kind="workspace" />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
