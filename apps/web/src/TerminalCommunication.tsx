/* 提供终端任务之间的通信界面。 */
import { useEffect, useRef, useState } from 'react';
import type { Run } from '../../../packages/contracts/src/index';
import type {
  TerminalCommunicationDraft,
  TerminalCommunicationItem,
  TerminalCommunicationPage,
  TerminalPeerPage,
  TerminalResolutionDraft,
} from '../../../packages/contracts/src/terminal-communication';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import './terminal-communication.css';

type Peer = TerminalPeerPage['items'][number];
const statusLabels: Record<string, string> = {
  DRAFT: '待准备',
  READY: '待执行',
  RUNNING: '执行中',
  WAITING: '等待中',
  VERIFYING: '待验收',
  DONE: '已完成',
  FAILED: '执行失败',
  CANCELLED: '已取消',
};
const deliveryLabels: Record<TerminalCommunicationItem['status'], string> = {
  queued: '待下一轮处理',
  included: '已加入终端上下文',
  unavailable: '接收记录已不可用',
  dismissed: '已不再处理',
};
const reasonLabels: Record<string, string> = {
  paused: '已暂停',
  terminal_review: '等待交付验收',
  terminal_verification: '需要核验上次操作',
  terminal_unavailable: '终端暂不可用',
  rate_limit: '等待速率限制解除',
  user: '等待用户输入',
};

type PagePosition = { cursors: string[]; query?: string };
/**
 * 按路径、作用域和游标读取一页通信数据。刷新期间保留同作用域的旧结果，
 * 请求取消或作用域改变时不把旧结果显示为新任务的数据。
 */
function useCommunicationRead<T>(
  path: string,
  scope: string,
  revision: number,
  refresh: number,
  position: PagePosition,
) {
  const { api } = useSurfaceClient();
  const { cursors, query } = position;
  const reader = useRef<AbortController | null>(null);
  const [state, setState] = useState<{
    scope: string;
    path: string;
    position?: PagePosition;
    value?: T;
    loading: boolean;
    issue: string;
    refresh?: number;
  }>({
    scope,
    path,
    loading: true,
    issue: '',
  });
  useEffect(() => {
    const controller = new AbortController();
    reader.current = controller;
    setState((old) => ({
      ...(old.scope === scope ? old : {}),
      scope,
      path,
      loading: true,
      issue: '',
      refresh,
    }));
    void api<T>(path, undefined, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setState({ scope, path, position: { cursors, query }, value, loading: false, issue: '', refresh });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState((old) => ({
            ...old,
            loading: false,
            issue: error instanceof Error ? error.message : '暂时无法读取，请重试。',
          }));
      });
    return () => controller.abort();
  }, [api, path, scope, revision, refresh, cursors, query]);
  const visible =
    state.scope === scope
      ? state
      : {
          scope,
          path,
          loading: true,
          issue: '',
          refresh: undefined,
          value: undefined,
          position: undefined,
        };
  return {
    ...visible,
    loading: state.path !== path || visible.loading,
    cancel: () => {
      reader.current?.abort();
      setState((old) => ({ ...old, loading: false, issue: '读取已取消。' }));
    },
  };
}

/**
 * 展示终端之间的接收方和消息，提供发送、分页与人工处理入口。
 * 草稿由调用方持有，运行或消息版本变化触发读取，不自动发送草稿。
 */
export function TerminalCommunication({
  run,
  disabled,
  draft,
  changeDraft,
  submitted,
  onNavigate,
  messageRevision = 0,
  resolutionDraft,
  changeResolutionDraft,
  resolutionSubmitted,
}: {
  run: Run;
  disabled: boolean;
  draft: TerminalCommunicationDraft;
  changeDraft: (draft: TerminalCommunicationDraft) => void;
  submitted: (draft: TerminalCommunicationDraft) => void;
  onNavigate: (runId: string) => void;
  messageRevision?: number;
  resolutionDraft: TerminalResolutionDraft | null;
  changeResolutionDraft: (draft: TerminalResolutionDraft | null) => void;
  resolutionSubmitted: (draft: TerminalResolutionDraft) => void;
}) {
  const { api, mutation } = useSurfaceClient();
  const [open, setOpen] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [peerCursors, setPeerCursors] = useState<string[]>([]);
  const [messageCursors, setMessageCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<{
    source: string;
    id: string;
    peer?: Peer;
    loading: boolean;
    issue: string;
  }>();
  const [sending, setSending] = useState(false);
  const [sendIssue, setSendIssue] = useState('');
  const [notice, setNotice] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolutionIssue, setResolutionIssue] = useState('');
  const [resolutionRejected, setResolutionRejected] = useState(false);
  const resolutionLock = useRef(false);
  const resolutionEditor = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLDetailsElement>(null);
  const resolutionOrigin = useRef<HTMLElement | null>(null);
  const messageList = useRef<HTMLOListElement>(null);
  const peerList = useRef<HTMLDivElement>(null);
  const messageEmpty = useRef<HTMLParagraphElement>(null);
  const peerEmpty = useRef<HTMLParagraphElement>(null);
  const messageError = useRef<HTMLParagraphElement>(null);
  const peerError = useRef<HTMLParagraphElement>(null);
  const readFeedback = useRef<{ kind: 'messages' | 'peers'; refresh: number; origin: Element | null } | null>(
    null,
  );
  const currentResolutionDraft = useRef(resolutionDraft);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const sendLock = useRef(false);
  const currentRun = useRef(run.id);
  const currentDraft = useRef(draft);
  const mounted = useRef(true);
  currentRun.current = run.id;
  currentDraft.current = draft;
  currentResolutionDraft.current = resolutionDraft;
  const base = `/runs/${encodeURIComponent(run.id)}/terminal`;
  const peerBefore = peerCursors.at(-1);
  const messageBefore = messageCursors.at(-1);
  const peers = useCommunicationRead<TerminalPeerPage>(
    `${base}/peers?limit=20&query=${encodeURIComponent(search)}${peerBefore ? `&before=${encodeURIComponent(peerBefore)}` : ''}`,
    base,
    run.revision,
    refresh,
    { cursors: peerCursors, query: search },
  );
  const messages = useCommunicationRead<TerminalCommunicationPage>(
    `${base}/messages?limit=20${messageBefore ? `&before=${encodeURIComponent(messageBefore)}` : ''}`,
    base,
    run.revision + messageRevision,
    refresh,
    { cursors: messageCursors },
  );
  /** 记住触发刷新的焦点位置，以便结果到达后在用户未转移焦点时提示结果。 */
  function refreshRead(kind: 'messages' | 'peers') {
    readFeedback.current = { kind, refresh: refresh + 1, origin: document.activeElement };
    setRefresh((value) => value + 1);
  }
  useEffect(() => {
    const releaseFeedback = (event: FocusEvent) => {
      if (readFeedback.current && event.target !== readFeedback.current.origin) readFeedback.current = null;
    };
    const releasePointerFeedback = (event: PointerEvent) => {
      if (readFeedback.current && !readFeedback.current.origin?.contains(event.target as Node))
        readFeedback.current = null;
    };
    const releaseWindowFeedback = () => {
      readFeedback.current = null;
    };
    document.addEventListener('focusin', releaseFeedback);
    document.addEventListener('pointerdown', releasePointerFeedback);
    window.addEventListener('blur', releaseWindowFeedback);
    return () => {
      document.removeEventListener('focusin', releaseFeedback);
      document.removeEventListener('pointerdown', releasePointerFeedback);
      window.removeEventListener('blur', releaseWindowFeedback);
    };
  }, []);
  useEffect(() => {
    const feedback = readFeedback.current;
    if (!feedback) return;
    const read = feedback.kind === 'messages' ? messages : peers;
    if (read.refresh !== feedback.refresh || read.loading) return;
    readFeedback.current = null;
    if (
      !panel.current?.open ||
      (document.activeElement !== document.body && document.activeElement !== feedback.origin)
    )
      return;
    const target = read.issue
      ? feedback.kind === 'messages'
        ? messageError.current
        : peerError.current
      : feedback.kind === 'messages'
        ? (messageList.current ?? messageEmpty.current)
        : (peerList.current ?? peerEmpty.current);
    const destination = target ?? panel.current.querySelector('summary');
    destination?.focus({ preventScroll: true });
    destination?.scrollIntoView({ block: 'nearest' });
  }, [
    messages.refresh,
    messages.loading,
    messages.issue,
    messages.value,
    peers.refresh,
    peers.loading,
    peers.issue,
    peers.value,
  ]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    readFeedback.current = null;
    resolutionOrigin.current = null;
    setQuery('');
    setSearch('');
    setPeerCursors([]);
    setMessageCursors([]);
    setSendIssue('');
    setNotice('');
    setResolutionIssue('');
    setResolutionRejected(false);
  }, [run.id]);
  useEffect(() => {
    resolutionEditor.current?.focus();
  }, [resolutionDraft?.item.id]);
  useEffect(() => {
    if (!open) return;
    // 仅在面板展开且页面可见时轮询，减少隐藏界面的读取。
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setRefresh((value) => value + 1);
    }, 15000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (!draft.targetRunId) {
      setSelected(undefined);
      return;
    }
    const id = draft.targetRunId;
    const controller = new AbortController();
    setSelected((old) => ({
      source: base,
      id,
      peer: old?.source === base && old.id === id ? old.peer : undefined,
      loading: true,
      issue: '',
    }));
    void api<TerminalPeerPage>(
      `${base}/peers?limit=20&query=${encodeURIComponent(id)}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted)
          setSelected({
            source: base,
            id,
            peer: value.items.find((peer) => peer.runId === id),
            loading: false,
            issue: '',
          });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setSelected({
            source: base,
            id,
            loading: false,
            issue: error instanceof Error ? error.message : '无法核对接收终端。',
          });
      });
    return () => controller.abort();
  }, [api, base, draft.targetRunId, run.revision, refresh]);

  const selection = selected?.source === base && selected.id === draft.targetRunId ? selected : undefined;
  const peer = selection?.peer;
  const retrying = !!draft.commandId && Number.isSafeInteger(draft.expectedRevision);
  const canSend =
    !!draft.targetRunId && !!draft.text.trim() && (retrying || (!!peer?.canReceive && !selection?.issue));
  const edit = (next: Pick<TerminalCommunicationDraft, 'targetRunId' | 'text'>) => {
    if (next.targetRunId === draft.targetRunId && next.text === draft.text) return;
    changeDraft(next);
    setSendIssue('');
    setNotice('');
  };
  const send = async () => {
    if (disabled || sendLock.current || !canSend) return;
    const sent = {
      ...draft,
      commandId: retrying ? draft.commandId! : crypto.randomUUID(),
      expectedRevision: retrying ? draft.expectedRevision! : run.revision,
    };
    const source = run.id;
    if (!retrying) changeDraft(sent);
    sendLock.current = true;
    setSending(true);
    setSendIssue('');
    setNotice('');
    try {
      await mutation(`${base}/messages`, {
        commandId: sent.commandId,
        expectedRevision: sent.expectedRevision,
        targetRunId: sent.targetRunId,
        text: sent.text.trim(),
      });
      submitted(sent);
      if (mounted.current && currentRun.current === source) {
        setNotice('发送记录已确认，可在往来消息中查看是否已加入终端上下文。');
        setMessageCursors([]);
        setRefresh((value) => value + 1);
      }
    } catch (error) {
      const sameDraft =
        currentDraft.current.targetRunId === sent.targetRunId &&
        currentDraft.current.text === sent.text &&
        currentDraft.current.commandId === sent.commandId &&
        currentDraft.current.expectedRevision === sent.expectedRevision;
      if (
        mounted.current &&
        error instanceof ApiError &&
        error.kind === 'http' &&
        error.code === 'REVISION_CONFLICT' &&
        currentRun.current === source &&
        sameDraft
      ) {
        changeDraft({ targetRunId: sent.targetRunId, text: sent.text });
      }
      if (mounted.current && currentRun.current === source)
        setSendIssue(
          `${error instanceof Error ? error.message : '暂时无法发送消息。'} ${sameDraft ? '草稿已保留，可重试。' : '这是先前提交的消息；当前草稿已包含你之后的编辑，请核对往来消息。'}`,
        );
    } finally {
      sendLock.current = false;
      if (mounted.current) setSending(false);
    }
  };
  const beginResolution = (item: TerminalCommunicationItem) => {
    if (disabled || resolutionLock.current || item.status !== 'queued') return;
    if (
      resolutionDraft &&
      resolutionDraft.item.id !== item.id &&
      (resolutionDraft.note.trim() || resolutionDraft.commandId)
    ) {
      setResolutionIssue('已有待确认的处置草稿，请先完成或明确关闭当前草稿，再选择其他消息。');
      resolutionEditor.current?.scrollIntoView({ block: 'center' });
      return;
    }
    if (resolutionDraft?.item.id === item.id) {
      resolutionEditor.current?.focus();
      return;
    }
    resolutionOrigin.current = document.activeElement as HTMLElement | null;
    changeResolutionDraft({ item, note: '' });
    setResolutionIssue('');
    setResolutionRejected(false);
    resolutionEditor.current?.focus();
  };
  const resolveMessage = async () => {
    if (disabled || resolutionLock.current || !resolutionDraft?.note.trim() || resolutionRejected) return;
    const sent = { ...resolutionDraft, commandId: resolutionDraft.commandId || crypto.randomUUID() };
    const source = run.id;
    if (!resolutionDraft.commandId) {
      currentResolutionDraft.current = sent;
      changeResolutionDraft(sent);
    }
    resolutionLock.current = true;
    setResolving(true);
    setResolutionIssue('');
    try {
      await mutation(`${base}/messages/${encodeURIComponent(sent.item.id)}/resolve`, {
        commandId: sent.commandId,
        expectedMessageRevision: sent.item.revision,
        note: sent.note.trim(),
      });
      resolutionSubmitted(sent);
      if (mounted.current && currentRun.current === source) {
        setNotice('消息处置记录已确认，原文和理由已保留。');
        setRefresh((value) => value + 1);
      }
    } catch (error) {
      if (
        mounted.current &&
        currentRun.current === source &&
        currentResolutionDraft.current?.commandId === sent.commandId
      ) {
        const rejected =
          error instanceof ApiError &&
          error.kind === 'http' &&
          (error.status || 0) >= 400 &&
          (error.status || 0) < 500;
        setResolutionRejected(rejected);
        setResolutionIssue(
          `${error instanceof Error ? error.message : '无法确认处置结果。'} ${rejected ? '请重新核对消息，当前原文和理由已保留。' : '原请求和理由已保留，重试将核对同一次处置。'}`,
        );
      }
    } finally {
      resolutionLock.current = false;
      if (mounted.current && currentRun.current === source) setResolving(false);
    }
  };
  const visibleMessageCursors = messages.position?.cursors || [];
  const visiblePeerCursors = peers.position?.cursors || [];

  return (
    <details
      ref={panel}
      className="terminal-communication"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        终端通信{messages.value?.pendingCount ? ` · ${messages.value.pendingCount} 条待处理` : ''}
      </summary>
      <div className="terminal-communication-body">
        <p className="field-help">
          向同项目的其他终端发送协作需求或交接内容。运行中的任务会排队接收；暂停的任务保持暂停，由你在继续时选择待处理消息。
        </p>
        <div className="terminal-communication-heading">
          <h4>往来消息</h4>
          <button
            type="button"
            className="text-button"
            disabled={messages.loading || peers.loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            刷新通信
          </button>
        </div>
        {(messages.loading || messages.issue) && (
          <div className="terminal-communication-read-state">
            <p
              ref={messageError}
              tabIndex={messages.issue ? 0 : undefined}
              aria-label={messages.issue ? '往来消息读取提示' : undefined}
              className={messages.issue ? 'inline-warning' : 'field-help'}
              role={messages.issue ? 'alert' : 'status'}
            >
              {messages.issue || `正在读取第 ${messageCursors.length + 1} 页消息…`}
              {messages.value && ' 当前保留上次成功读取的消息。'}
            </p>
            {messages.loading ? (
              <button type="button" className="text-button" onClick={messages.cancel}>
                取消读取消息
              </button>
            ) : (
              <button type="button" className="secondary" onClick={() => refreshRead('messages')}>
                重试第 {messageCursors.length + 1} 页消息
              </button>
            )}
          </div>
        )}
        {messages.value && !messages.value.items.length && (
          <p ref={messageEmpty} tabIndex={-1} className="field-help terminal-communication-empty">
            当前没有往来消息。
          </p>
        )}
        {!!messages.value?.items.length && (
          <ol ref={messageList} tabIndex={-1} className="terminal-message-list" aria-label="终端往来消息">
            {messages.value.items.map((message) => (
              <li key={message.id}>
                <div className="terminal-message-meta">
                  <span>
                    {message.direction === 'outgoing' ? '发送给' : message.peer ? '来自' : '用户补充'}
                  </span>
                  {message.peer && (
                    <div className="terminal-message-source">
                      <strong>{message.peer.title}</strong>
                      <span>
                        {message.peer.agent}
                        {!message.peer.available && ' · 已不可用'}
                      </span>
                    </div>
                  )}
                  {message.peer?.available && (
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`打开终端：${message.peer.title}`}
                      onClick={() => onNavigate(message.peer!.runId)}
                    >
                      打开终端
                    </button>
                  )}
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  </time>
                </div>
                <p className="terminal-message-text">{message.text}</p>
                <div className="terminal-message-footer">
                  <span className={`terminal-message-status ${message.status}`}>
                    {message.resolution?.kind === 'withdrawn' ? '已撤回' : deliveryLabels[message.status]}
                  </span>
                  {message.status === 'queued' && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={disabled || resolving}
                      onClick={() => beginResolution(message)}
                    >
                      {message.direction === 'incoming' ? '不再处理' : '撤回'}
                    </button>
                  )}
                  {message.direction === 'incoming' && message.peer?.available && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={disabled}
                      onClick={() => {
                        edit({ targetRunId: message.peer!.runId, text: draft.text });
                        textArea.current?.focus();
                      }}
                    >
                      回信
                    </button>
                  )}
                </div>
                {message.resolution && (
                  <div className="terminal-message-resolution">
                    <p>理由：{message.resolution.note}</p>
                    <time dateTime={message.resolution.at}>
                      {new Date(message.resolution.at).toLocaleString('zh-CN', { hour12: false })}
                    </time>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        <div className="terminal-communication-pages">
          <span>
            {messages.value
              ? `第 ${visibleMessageCursors.length + 1} 页 · 共 ${messages.value.page.total} 条`
              : ''}
          </span>
          {!!visibleMessageCursors.length && (
            <button
              type="button"
              className="text-button"
              disabled={messages.loading}
              onClick={() => {
                setMessageCursors(visibleMessageCursors.slice(0, -1));
                refreshRead('messages');
              }}
            >
              更新消息
            </button>
          )}
          {messages.value?.page.hasMore && (
            <button
              type="button"
              className="text-button"
              disabled={messages.loading}
              onClick={() => {
                const next = messages.value?.page.nextBefore;
                if (next) {
                  setMessageCursors([...visibleMessageCursors, next]);
                  refreshRead('messages');
                }
              }}
            >
              更早消息
            </button>
          )}
          {(messageCursors.length > 0 || visibleMessageCursors.length > 0) && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setMessageCursors([]);
                refreshRead('messages');
              }}
            >
              返回最新消息
            </button>
          )}
        </div>
        <p className="field-help">
          “已加入终端上下文”只表示内容已保存到任务上下文，不代表 CLI 已读或工作已完成。
        </p>

        {resolutionDraft && (
          <section className="terminal-resolution-editor" aria-label="消息处置草稿">
            <h4>{resolutionDraft.item.direction === 'incoming' ? '不再处理这条消息' : '撤回这条消息'}</h4>
            <p
              className="terminal-resolution-original"
              role="region"
              aria-label="待处置消息原文"
              tabIndex={0}
            >
              {resolutionDraft.item.text}
            </p>
            <label>
              处置理由
              <textarea
                ref={resolutionEditor}
                rows={3}
                maxLength={2000}
                value={resolutionDraft.note}
                disabled={disabled || resolving || !!resolutionDraft.commandId}
                onChange={(event) => {
                  const next = { item: resolutionDraft.item, note: event.target.value };
                  currentResolutionDraft.current = next;
                  changeResolutionDraft(next);
                  setResolutionIssue('');
                }}
                placeholder="说明为什么这条消息不再需要处理…"
              />
            </label>
            <p className="field-help">
              确认后保留消息原文和处置理由，从待处理队列移除；此操作不会启动或恢复任务。
            </p>
            {resolutionDraft.commandId && !resolving && (
              <p className="field-help">已有提交记录，重试将使用原文版本和原理由核对同一次处置。</p>
            )}
            {resolutionIssue && (
              <p className="inline-warning" role="alert" tabIndex={0} aria-label="消息处置提示">
                {resolutionIssue}
              </p>
            )}
            <div className="terminal-resolution-actions">
              <button
                type="button"
                className="secondary"
                disabled={disabled || resolving || resolutionRejected || !resolutionDraft.note.trim()}
                onClick={() => void resolveMessage()}
              >
                {resolving
                  ? '正在确认…'
                  : resolutionDraft.commandId
                    ? '重试核对处置'
                    : resolutionDraft.item.direction === 'incoming'
                      ? '确认不再处理'
                      : '确认撤回'}
              </button>
              {resolutionRejected && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setMessageCursors([]);
                    setRefresh((value) => value + 1);
                    setResolutionIssue('请核对最新消息。如仍需处置，请关闭当前草稿后重新选择待处理记录。');
                  }}
                >
                  重新核对消息
                </button>
              )}
              <button
                type="button"
                className="text-button"
                disabled={resolving}
                onClick={() => {
                  currentResolutionDraft.current = null;
                  changeResolutionDraft(null);
                  setResolutionIssue('');
                  setResolutionRejected(false);
                  const target = resolutionOrigin.current?.isConnected
                    ? resolutionOrigin.current
                    : panel.current?.querySelector('summary');
                  target?.focus({ preventScroll: true });
                  target?.scrollIntoView({ block: 'nearest' });
                }}
              >
                关闭此处置草稿
              </button>
            </div>
            {resolutionDraft.commandId && <p className="field-help">关闭草稿不会撤销已提交的请求。</p>}
          </section>
        )}

        <div className="terminal-communication-compose">
          <h4>发送协作消息</h4>
          <form
            className="terminal-peer-search"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(query.trim());
              setPeerCursors([]);
              refreshRead('peers');
            }}
          >
            <label>
              查找接收终端
              <input
                value={query}
                maxLength={200}
                placeholder="搜索任务标题或终端名称"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button type="submit" className="secondary" disabled={peers.loading}>
              搜索
            </button>
          </form>
          {(peers.loading || peers.issue) && (
            <div className="terminal-communication-read-state">
              <p
                ref={peerError}
                tabIndex={peers.issue ? 0 : undefined}
                aria-label={peers.issue ? '接收终端读取提示' : undefined}
                className={peers.issue ? 'inline-warning' : 'field-help'}
                role={peers.issue ? 'alert' : 'status'}
              >
                {peers.issue ||
                  `正在读取${search ? `“${search}”的` : ''}第 ${peerCursors.length + 1} 页终端…`}
                {peers.value && ' 当前保留上次成功读取的终端。'}
              </p>
              {peers.loading ? (
                <button type="button" className="text-button" onClick={peers.cancel}>
                  取消读取终端
                </button>
              ) : (
                <button type="button" className="secondary" onClick={() => refreshRead('peers')}>
                  重试第 {peerCursors.length + 1} 页终端
                </button>
              )}
            </div>
          )}
          {peers.value && !peers.value.items.length && (
            <p ref={peerEmpty} tabIndex={-1} className="field-help terminal-communication-empty">
              {peers.position?.query ? '没有匹配的同项目终端。' : '当前项目还没有其他终端。'}
            </p>
          )}
          {!!peers.value?.items.length && (
            <div
              ref={peerList}
              tabIndex={-1}
              className="terminal-peer-list"
              role="group"
              aria-label="接收终端列表"
            >
              {peers.value.items.map((item) => (
                <div className="terminal-peer-row" key={item.runId}>
                  <button
                    type="button"
                    className="terminal-peer-select"
                    disabled={disabled || !item.canReceive}
                    aria-pressed={draft.targetRunId === item.runId}
                    onClick={() => edit({ targetRunId: item.runId, text: draft.text })}
                  >
                    <strong>{item.title}</strong>
                    <span>
                      {item.agent} · {statusLabels[item.status] || item.status}
                    </span>
                    {item.reason && reasonLabels[item.reason] && <small>{reasonLabels[item.reason]}</small>}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`打开终端：${item.title}`}
                    onClick={() => onNavigate(item.runId)}
                  >
                    打开
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="terminal-communication-pages">
            <span>
              {peers.value
                ? `第 ${visiblePeerCursors.length + 1} 页 · 共 ${peers.value.page.total} 个终端`
                : ''}
            </span>
            {!!visiblePeerCursors.length && (
              <button
                type="button"
                className="text-button"
                disabled={peers.loading}
                onClick={() => {
                  setPeerCursors(visiblePeerCursors.slice(0, -1));
                  refreshRead('peers');
                }}
              >
                上一页终端
              </button>
            )}
            {peers.value?.page.hasMore && (
              <button
                type="button"
                className="text-button"
                disabled={peers.loading}
                onClick={() => {
                  const next = peers.value?.page.nextBefore;
                  if (next) {
                    setPeerCursors([...visiblePeerCursors, next]);
                    refreshRead('peers');
                  }
                }}
              >
                下一页终端
              </button>
            )}
            {(peerCursors.length > 0 || visiblePeerCursors.length > 0 || search) && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setPeerCursors([]);
                  setSearch('');
                  setQuery('');
                  refreshRead('peers');
                }}
              >
                返回终端首页
              </button>
            )}
          </div>
          {!!draft.targetRunId && (
            <div className="terminal-selected-peer" aria-live="polite">
              <span>接收终端：{peer?.title || (selection?.loading ? '正在核对…' : draft.targetRunId)}</span>
              {peer && (
                <button type="button" className="text-button" onClick={() => onNavigate(peer.runId)}>
                  打开接收终端
                </button>
              )}
              {selection?.issue && (
                <p className="inline-warning" role="region" aria-label="接收终端核对提示" tabIndex={0}>
                  {selection.issue}
                </p>
              )}
              {!selection?.loading && !selection?.issue && !peer && (
                <p className="field-help">目标已不可用或不在当前项目，请重新选择。</p>
              )}
              {peer && !peer.canReceive && (
                <p className="field-help">该终端当前不能接收消息，请选择其他终端。</p>
              )}
            </div>
          )}
          <label>
            消息内容
            <textarea
              ref={textArea}
              rows={4}
              value={draft.text}
              maxLength={20000}
              disabled={disabled}
              onChange={(event) => edit({ targetRunId: draft.targetRunId, text: event.target.value })}
              placeholder="填写需要对方执行的工作、相关背景和验收要求…"
            />
          </label>
          <p className="field-help">
            点击“授权发送”将这条消息交给所选终端。发送后不会自动唤醒或启动新的 CLI 操作。
          </p>
          {retrying && !sending && (
            <p className="field-help">上次发送结果待确认；重试会核对同一条消息，避免重复投递。</p>
          )}
          {sendIssue && (
            <p className="inline-warning" role="alert" tabIndex={0} aria-label="消息发送提示">
              {sendIssue}
            </p>
          )}
          {notice && (
            <p className="terminal-communication-notice" role="status">
              {notice}
            </p>
          )}
          <button
            type="button"
            className="secondary"
            disabled={disabled || sending || !canSend}
            onClick={() => void send()}
          >
            {sending ? '正在发送…' : retrying ? '重试发送' : '授权发送'}
          </button>
        </div>
      </div>
    </details>
  );
}
