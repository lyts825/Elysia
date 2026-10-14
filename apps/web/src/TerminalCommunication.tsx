import { useEffect, useRef, useState } from 'react';
import type { Run } from '../../../packages/contracts/src/index';
import type {
  TerminalCommunicationDraft,
  TerminalCommunicationItem,
  TerminalCommunicationPage,
  TerminalPeerPage,
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
};
const reasonLabels: Record<string, string> = {
  paused: '已暂停',
  terminal_review: '等待交付验收',
  terminal_verification: '需要核验上次操作',
  terminal_unavailable: '终端暂不可用',
  rate_limit: '等待速率限制解除',
  user: '等待用户输入',
};

function useCommunicationRead<T>(path: string, revision: number, refresh: number) {
  const { api } = useSurfaceClient();
  const [state, setState] = useState<{ path: string; value?: T; loading: boolean; issue: string }>({
    path,
    loading: true,
    issue: '',
  });
  useEffect(() => {
    const controller = new AbortController();
    setState((old) => ({ path, value: old.path === path ? old.value : undefined, loading: true, issue: '' }));
    void api<T>(path, undefined, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setState({ path, value, loading: false, issue: '' });
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
  }, [api, path, revision, refresh]);
  return state.path === path ? state : { path, loading: true, issue: '', value: undefined };
}

export function TerminalCommunication({
  run,
  disabled,
  draft,
  changeDraft,
  submitted,
  onNavigate,
  messageRevision = 0,
}: {
  run: Run;
  disabled: boolean;
  draft: TerminalCommunicationDraft;
  changeDraft: (draft: TerminalCommunicationDraft) => void;
  submitted: (draft: TerminalCommunicationDraft) => void;
  onNavigate: (runId: string) => void;
  messageRevision?: number;
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
  const textArea = useRef<HTMLTextAreaElement>(null);
  const sendLock = useRef(false);
  const currentRun = useRef(run.id);
  const currentDraft = useRef(draft);
  const mounted = useRef(true);
  currentRun.current = run.id;
  currentDraft.current = draft;
  const base = `/runs/${encodeURIComponent(run.id)}/terminal`;
  const peerBefore = peerCursors.at(-1);
  const messageBefore = messageCursors.at(-1);
  const peers = useCommunicationRead<TerminalPeerPage>(
    `${base}/peers?limit=20&query=${encodeURIComponent(search)}${peerBefore ? `&before=${encodeURIComponent(peerBefore)}` : ''}`,
    run.revision,
    refresh,
  );
  const messages = useCommunicationRead<TerminalCommunicationPage>(
    `${base}/messages?limit=20${messageBefore ? `&before=${encodeURIComponent(messageBefore)}` : ''}`,
    run.revision + messageRevision,
    refresh,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setQuery('');
    setSearch('');
    setPeerCursors([]);
    setMessageCursors([]);
    setSendIssue('');
    setNotice('');
  }, [run.id]);
  useEffect(() => {
    if (!open) return;
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

  return (
    <details
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
        {messages.issue && (
          <p className="inline-warning" role="alert">
            {messages.issue} 请点击“刷新通信”重试。
          </p>
        )}
        {messages.loading && !messages.value && (
          <p className="field-help" role="status">
            正在读取消息…
          </p>
        )}
        {messages.value && !messages.value.items.length && <p className="field-help">当前没有往来消息。</p>}
        {!!messages.value?.items.length && (
          <ol className="terminal-message-list" aria-label="终端往来消息">
            {messages.value.items.map((message) => (
              <li key={message.id}>
                <div className="terminal-message-meta">
                  <span>
                    {message.direction === 'outgoing' ? '发送给' : message.peer ? '来自' : '用户补充'}
                  </span>
                  {message.peer &&
                    (message.peer.available ? (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onNavigate(message.peer!.runId)}
                      >
                        {message.peer.title} · {message.peer.agent}
                      </button>
                    ) : (
                      <span>{message.peer.title}（已不可用）</span>
                    ))}
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  </time>
                </div>
                <p className="terminal-message-text">{message.text}</p>
                <div className="terminal-message-footer">
                  <span className={`terminal-message-status ${message.status}`}>
                    {deliveryLabels[message.status]}
                  </span>
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
              </li>
            ))}
          </ol>
        )}
        <div className="terminal-communication-pages">
          <span>{messages.value ? `共 ${messages.value.page.total} 条` : ''}</span>
          {!!messageCursors.length && (
            <button
              type="button"
              className="text-button"
              disabled={messages.loading}
              onClick={() => setMessageCursors((value) => value.slice(0, -1))}
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
                if (next) setMessageCursors((value) => [...value, next]);
              }}
            >
              更早消息
            </button>
          )}
        </div>
        <p className="field-help">
          “已加入终端上下文”只表示内容已保存到任务上下文，不代表 CLI 已读或工作已完成。
        </p>

        <div className="terminal-communication-compose">
          <h4>发送协作消息</h4>
          <form
            className="terminal-peer-search"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(query.trim());
              setPeerCursors([]);
              setRefresh((value) => value + 1);
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
          {peers.issue && (
            <p className="inline-warning" role="alert">
              {peers.issue} 请点击“刷新通信”重试。
            </p>
          )}
          {peers.loading && !peers.value && (
            <p className="field-help" role="status">
              正在读取同项目终端…
            </p>
          )}
          {peers.value && !peers.value.items.length && (
            <p className="field-help">{search ? '没有匹配的同项目终端。' : '当前项目还没有其他终端。'}</p>
          )}
          {!!peers.value?.items.length && (
            <div className="terminal-peer-list" role="group" aria-label="接收终端列表">
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
            <span>{peers.value ? `共 ${peers.value.page.total} 个终端` : ''}</span>
            {!!peerCursors.length && (
              <button
                type="button"
                className="text-button"
                disabled={peers.loading}
                onClick={() => setPeerCursors((value) => value.slice(0, -1))}
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
                  if (next) setPeerCursors((value) => [...value, next]);
                }}
              >
                下一页终端
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
              {selection?.issue && <p className="inline-warning">{selection.issue}</p>}
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
            <p className="inline-warning" role="alert">
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
