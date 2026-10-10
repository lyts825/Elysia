import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { useSurfaceClient, useSurfaceRoot } from './SurfaceClientContext';
import type { Agent, Artifact, Message, Operation, Task } from '../../../packages/contracts/src/index';
import type {
  PreviewFile,
  PreviewResourceIssue,
  PreviewSnapshot,
} from '../../../packages/contracts/src/preview';
import { Icon } from './Icon';
import { textFileEncodings, type TextFileEncoding } from '../../../packages/contracts/src/files';
import { MarkdownDocument } from './MarkdownDocument';
import { FilePageControls, formatFileBytes } from './FilePageControls';
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
const resourceReasons: Record<PreviewResourceIssue['reason'], string> = {
  missing: '文件不存在',
  'too-large': '资源超过预览上限',
  unreadable: '文件无法读取',
  restricted: '路径不允许预览',
  'not-file': '路径不是文件',
};
export interface PreviewFileTarget {
  taskId: string;
  path: string;
  anchor?: string;
  requestId: string;
}
type Props = {
  embedded?: boolean;
  runId: string;
  tasks: Task[];
  agents: Agent[];
  messages: Message[];
  operations: Operation[];
  artifacts: Artifact[];
  streaming: Record<string, string>;
  selectedTaskId: string;
  fileTarget?: PreviewFileTarget;
  selectTask: (id: string) => void;
  close: () => void;
};
export function PreviewPanel({
  embedded = false,
  runId,
  tasks,
  agents,
  messages,
  operations,
  artifacts,
  streaming,
  selectedTaskId,
  fileTarget,
  selectTask,
  close,
}: Props) {
  const { api, surface } = useSurfaceClient();
  const surfaceRoot = useSurfaceRoot();
  const panel = useRef<HTMLElement>(null);
  const present = usePresenceMotion(panel, 'panel');
  const task = tasks.find((t) => t.id === selectedTaskId) || tasks[0];
  const taskId = task?.id || '',
    agent = agents.find((a) => a.taskId === taskId);
  const [snapshot, setSnapshot] = useState<(PreviewSnapshot & { runId: string }) | null>(null);
  const [filesByTask, setFilesByTask] = useState<Record<string, string>>({});
  const requestedFile = useRef<(PreviewFileTarget & { runId: string }) | null>(null);
  const handledTarget = useRef('');
  const [content, setContent] = useState<
    | (PreviewFile & {
        context: string;
        selectionContext: string;
        requestedOffset: number;
        requestedEncoding: TextFileEncoding;
      })
    | null
  >(null);
  const [readPosition, setReadPosition] = useState<{
    scope: string;
    offset: number;
    history: number[];
    version?: string;
    encoding: TextFileEncoding;
  }>({ scope: '', offset: 0, history: [], encoding: 'auto' });
  const [fileNotice, setFileNotice] = useState('');
  const [pendingAnchor, setPendingAnchor] = useState<{
    taskId: string;
    path: string;
    anchor: string;
    requestId: string;
  } | null>(null);
  const [htmlPermission, setHtmlPermission] = useState('');
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
  const resourceIssues = selectedEntry?.renderIssues?.slice(0, 10) || [];
  const resourceIssueCount = selectedEntry?.renderIssueCount ?? selectedEntry?.renderIssues?.length ?? 0;
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
  const readScope = JSON.stringify([context, selectedVersion]);
  const position =
    readPosition.scope === readScope
      ? readPosition
      : { scope: readScope, offset: 0, history: [], encoding: 'auto' as TextFileEncoding };
  const readKey = JSON.stringify([readScope, position.offset, position.encoding]);
  const pageLimit = /\.(md|markdown)$/i.test(selected) ? 64 * 1024 : 256 * 1024;
  const moveTo = (
    offset: number,
    history = [...position.history, content?.page?.offset ?? position.offset],
  ) => {
    setReadPosition({
      ...position,
      offset,
      history: history.slice(-128),
      version: content?.page?.version || position.version,
    });
    setFileNotice('');
  };
  const chooseFile = useCallback(
    (path: string, anchor = '') => {
      requestedFile.current = null;
      selectedRef.current = path;
      setFilesByTask((old) => ({ ...old, [taskId]: path }));
      setPendingAnchor(anchor ? { taskId, path, anchor, requestId: crypto.randomUUID() } : null);
      setHtmlPermission('');
    },
    [taskId],
  );
  const followLocalLink = useCallback(
    (path: string) => {
      const hash = path.indexOf('#');
      const filePath = hash < 0 ? path : path.slice(0, hash);
      if (filePath) {
        setFilter('');
        chooseFile(filePath, hash < 0 ? '' : path.slice(hash + 1));
      }
    },
    [chooseFile],
  );
  const permissionContext = useRef(context);
  useEffect(() => {
    if (permissionContext.current === context) return;
    permissionContext.current = context;
    setHtmlPermission('');
  }, [context]);
  const previewScope = JSON.stringify([runId, taskId]);
  const resetScope = useRef(previewScope);
  useEffect(() => {
    if (resetScope.current === previewScope) return;
    resetScope.current = previewScope;
    setSnapshot(null);
    setContent(null);
    setSnapshotError('');
    setFileError('');
    setUpdated('');
    setFileNotice('');
  }, [previewScope]);
  useEffect(() => {
    if (!fileTarget || fileTarget.taskId !== taskId || handledTarget.current === fileTarget.requestId) return;
    handledTarget.current = fileTarget.requestId;
    chooseFile(fileTarget.path, fileTarget.anchor);
    requestedFile.current = { ...fileTarget, runId };
    setReadPosition({ scope: '', offset: 0, history: [], encoding: 'auto' });
    setFilter('');
    setView('page');
    setFileNotice('');
    setRefresh((value) => value + 1);
  }, [fileTarget?.requestId, taskId, runId, chooseFile]);
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
          const requested = requestedFile.current;
          if (requested?.runId === runId && requested.taskId === taskId && requested.path === old[taskId])
            return old;
          const first =
            next.files.find((f) => f.change !== 'D' && /(?:dist|build|out)\/index\.html?$/.test(f.path)) ||
            next.files.find((f) => f.change !== 'D' && /(^|\/)index\.html?$/.test(f.path)) ||
            next.files.find((f) => f.change !== 'D' && /\.(html?|md|markdown)$/i.test(f.path)) ||
            next.files[0];
          return { ...old, [taskId]: first?.path || '' };
        });
        const requested = requestedFile.current;
        if (
          requested?.runId === runId &&
          requested.taskId === taskId &&
          !next.files.some((file) => file.path === requested.path)
        )
          setFileNotice('链接文件未找到：' + requested.path);
        else setFileNotice((old) => (old.startsWith('链接文件未找到：') ? '' : old));
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
    setContent((old) =>
      old?.selectionContext === context &&
      old.requestedOffset === position.offset &&
      old.requestedEncoding === position.encoding
        ? old
        : null,
    );
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
          `/runs/${runId}/tasks/${taskId}/preview/file?` +
            new URLSearchParams({
              path: selected,
              offset: String(position.offset),
              limit: String(pageLimit),
              encoding: position.encoding,
              ...(position.version ? { version: position.version } : {}),
            }),
          undefined,
          undefined,
          controller.signal,
        );
        if (!disposed) {
          setContent({
            ...result,
            context: readKey,
            selectionContext: context,
            requestedOffset: position.offset,
            requestedEncoding: position.encoding,
          });
          setFileError('');
        }
      } catch (e) {
        if (!disposed) {
          if (e instanceof ApiError && e.code === 'FILE_CHANGED') {
            setReadPosition({ ...position, offset: 0, history: [], version: undefined });
            setContent(null);
            setFileNotice('文件已更新，已回到开头重新读取。');
            setRefresh((n) => n + 1);
            return;
          }
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
  }, [readKey, refresh]);
  useEffect(() => {
    if (auto) fileRetries.current?.resume();
    else fileRetries.current?.cancel();
  }, [auto]);
  const visible = current?.files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())) || [];
  const selectedIndex = visible.findIndex((file) => file.path === selected);
  const selectedFile =
    selectedEntry &&
    content?.selectionContext === context &&
    content.path === selected &&
    content.requestedOffset === position.offset &&
    content.requestedEncoding === position.encoding
      ? content
      : null;
  const resourceUrl =
    selectedFile?.resourceUrl ||
    (current?.renderBase && selected
      ? current.renderBase + selected.split('/').map(encodeURIComponent).join('/')
      : '');
  const markdownBase = current?.renderBase
    ? current.renderBase +
      selected.split('/').slice(0, -1).map(encodeURIComponent).join('/') +
      (selected.includes('/') ? '/' : '')
    : null;
  const htmlPermissionKey = JSON.stringify([context, selectedVersion, selectedFile?.page?.version]);
  const htmlBytes = Math.max(selectedEntry?.size || 0, selectedFile?.page?.totalBytes || 0);
  const largeHtmlBlocked =
    selectedFile?.kind === 'html' && htmlBytes > 8 * 1024 * 1024 && htmlPermission !== htmlPermissionKey;
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
      ref={embedded ? undefined : panel}
      className={'preview-panel' + (embedded ? ' preview-embedded' : wide ? ' preview-expanded' : '')}
      aria-label="代理工作预览"
      data-leaving={!present || undefined}
      inert={!present}
    >
      {!embedded && (
        <header className="preview-heading">
          <div>
            <span className="preview-glyph">
              <Icon name="panel" size={19} />
            </span>
            <strong>预览</strong>
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
                surfaceRoot?.current
                  ?.querySelector<HTMLElement>('.preview-toggle')
                  ?.focus({ preventScroll: true });
                close();
              }}
              aria-label="关闭预览"
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        </header>
      )}
      <div className="preview-agent-picker">
        <label htmlFor={surface + '-preview-agent'}>代理</label>
        <select id={surface + '-preview-agent'} value={taskId} onChange={(e) => selectTask(e.target.value)}>
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
        <strong>{labels[task?.status || '']}</strong>
      </div>
      <MotionTabs className="preview-tabs" label="预览视图" value={view}>
        {[
          ['page', '文档'],
          ['source', '源码'],
          ['diff', '变更'],
          ['activity', '动态'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => {
              if (key === 'diff' && position.offset > 0) moveTo(0, []);
              setView(key);
            }}
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
      {fileNotice && (
        <p className="preview-notice" role="status">
          {fileNotice}
        </p>
      )}
      {view === 'page' && selectedFile?.kind === 'html' && resourceIssueCount > 0 && (
        <div role="status" className="preview-error">
          <span>
            页面资源加载不完整，部分内容可能无法显示或交互。
            {resourceIssues.map((issue, index) => (
              <small key={issue.path || index}>
                {issue.path || '受限资源路径'}：{resourceReasons[issue.reason]}
              </small>
            ))}
            {resourceIssueCount > resourceIssues.length && (
              <small>另有 {resourceIssueCount - resourceIssues.length} 项资源未加载。</small>
            )}
            <small>修复本地文件后可刷新页面；开启自动更新时会检查文件变化。</small>
          </span>
          <button disabled={loading} onClick={() => setRefresh((n) => n + 1)}>
            刷新页面
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
            <label className="preview-file-search">
              <Icon name="search" size={14} />
              <input
                aria-label="筛选预览文件"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="搜索文件…"
              />
            </label>
            <select
              aria-label="预览文件"
              value={visible.some((f) => f.path === selected) ? selected : ''}
              onChange={(e) => chooseFile(e.target.value)}
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
            <div className="preview-file-step">
              <button
                aria-label="上一个文件"
                disabled={selectedIndex <= 0}
                onClick={() => chooseFile(visible[selectedIndex - 1].path)}
              >
                <Icon name="chevron" size={13} />
              </button>
              <button
                aria-label="下一个文件"
                disabled={selectedIndex < 0 || selectedIndex >= visible.length - 1}
                onClick={() => chooseFile(visible[selectedIndex + 1].path)}
              >
                <Icon name="chevron" size={13} />
              </button>
            </div>
          </div>
          {selectedEntry && (
            <div className="preview-file-meta">
              <span title={selected}>
                <Icon name="file" size={13} />
                <code>{selected}</code>
              </span>
              <small>{formatFileBytes(selectedEntry.size)}</small>
              {(!selectedFile || selectedFile.text !== null) && (
                <select
                  aria-label="预览文本编码"
                  value={position.encoding}
                  disabled={loading}
                  onChange={(event) => {
                    setReadPosition({
                      ...position,
                      encoding: event.target.value as TextFileEncoding,
                      offset: 0,
                      history: [],
                      version: undefined,
                    });
                    setFileNotice('');
                  }}
                >
                  {textFileEncodings.map((name) => (
                    <option key={name} value={name}>
                      {name === 'auto'
                        ? selectedFile?.encoding
                          ? `自动 · ${selectedFile.encoding.toUpperCase()}`
                          : '自动'
                        : name.toUpperCase()}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {current?.truncated && (
            <p className="preview-limit">文件列表最多展示 1,500 项；部分目录或文件不可读取。</p>
          )}
          {selectedEntry?.renderTruncated && (
            <p className="preview-limit">页面引用的本地资源超过 1,500 项，部分资源更新需手动刷新。</p>
          )}
          {view !== 'diff' &&
            selectedFile?.page?.paged &&
            !(view === 'page' && selectedFile.kind === 'html' && !largeHtmlBlocked) && (
              <FilePageControls
                page={selectedFile.page}
                loading={loading}
                hasPrevious={position.offset > 0}
                previous={() => moveTo(position.history.at(-1) ?? 0, position.history.slice(0, -1))}
                next={() => selectedFile.page?.nextOffset !== null && moveTo(selectedFile.page!.nextOffset!)}
                jump={moveTo}
                restart={() => moveTo(0, [])}
              />
            )}
          {selectedFile?.page?.paged && view === 'page' && selectedFile.kind === 'markdown' && (
            <div className="preview-format-note">
              仅渲染当前页片段。跨页代码块、表格或公式可能不完整。
              <button onClick={() => setView('source')}>查看源码</button>
            </div>
          )}
          <MotionContent
            className="preview-canvas"
            motionKey={`${taskId}:${view}:${wide}:${position.offset}:${position.encoding}`}
          >
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
              <div className="preview-loading" role="status">
                正在读取文件…
              </div>
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
                      title={selectedFile.diffTruncated ? '大文件差异未完整生成' : '此文件没有文本差异'}
                      text={
                        selectedFile.diffTruncated
                          ? '可通过源码分页检查文件，或在项目目录中查看完整差异。'
                          : selectedFile.kind === 'image' || selectedFile.kind === 'binary'
                            ? '二进制文件请通过文档视图检查。'
                            : '文件与任务基线一致。'
                      }
                    />
                  )}
                  {selectedFile.diffTruncated && (
                    <p className="preview-limit">
                      {selectedFile.diff
                        ? '仅显示部分差异，最多 1 MiB 或 12,000 行。可通过源码分页继续查看文件。'
                        : '大文件跳过自动生成完整差异，以保持预览可用。'}
                    </p>
                  )}
                </div>
              ) : view === 'source' ? (
                selectedFile.text !== null ? (
                  <pre className="preview-source">{selectedFile.text}</pre>
                ) : (
                  <PreviewEmpty
                    title={selectedFile.deleted ? '文件已删除' : '二进制文件'}
                    text="切换到变更或文档视图查看。"
                  />
                )
              ) : selectedFile.deleted ? (
                <PreviewEmpty title="文件已删除" text="切换到“变更”查看删除内容。" />
              ) : selectedFile.kind === 'html' && largeHtmlBlocked ? (
                <>
                  <div className="preview-format-note">
                    此 HTML 为 {formatFileBytes(htmlBytes)}，默认按片段显示源码。加载页面会读取整份文档。
                    <button onClick={() => setHtmlPermission(htmlPermissionKey)}>加载页面</button>
                  </div>
                  <pre className="preview-source">{selectedFile.text}</pre>
                </>
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
                <MarkdownDocument
                  className="preview-markdown"
                  text={selectedFile.text || ''}
                  sourcePath={selected}
                  resourceBase={markdownBase}
                  anchor={
                    pendingAnchor?.taskId === taskId && pendingAnchor.path === selected
                      ? pendingAnchor.anchor
                      : undefined
                  }
                  anchorRequestId={
                    pendingAnchor?.taskId === taskId && pendingAnchor.path === selected
                      ? pendingAnchor.requestId
                      : undefined
                  }
                  onLocalLink={followLocalLink}
                />
              ) : selectedFile.kind === 'image' ? (
                <div className="preview-image">
                  <img
                    src={
                      resourceUrl +
                      (resourceUrl.includes('?') ? '&' : '?') +
                      'v=' +
                      encodeURIComponent(selectedFile.hash || String(selectedEntry?.modifiedAt || ''))
                    }
                    alt={selected}
                  />
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
      <Icon name="file" size={24} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
