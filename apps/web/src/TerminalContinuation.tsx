import { useEffect, useRef, useState } from 'react';
import type { Run } from '../../../packages/contracts/src/index';
import type { TerminalCommunicationPage } from '../../../packages/contracts/src/terminal-communication';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import './terminal-communication.css';

type Session = {
  supported: boolean;
  canResume: boolean;
  canStartNew: boolean;
  reason: string;
  revision: number;
  sessionId?: string;
};
import type { ContinuationDraft } from './ContinuationDraft';
export { readContinuationDraft, type ContinuationDraft } from './ContinuationDraft';
export function TerminalContinuation({
  run,
  messageRevision = 0,
  disabled,
  act,
  draft,
  changeDraft,
  submitted,
}: {
  run: Run;
  messageRevision?: number;
  disabled: boolean;
  act: (action: () => Promise<unknown>) => Promise<unknown>;
  draft: ContinuationDraft;
  changeDraft: (draft: ContinuationDraft) => void;
  submitted: (draft: ContinuationDraft) => void;
}) {
  const { api, mutation } = useSurfaceClient();
  const [session, setSession] = useState<Session | null>(null),
    [issue, setIssue] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const [pending, setPending] = useState<TerminalCommunicationPage | null>(null);
  const [pendingIssue, setPendingIssue] = useState('');
  const { text, mode } = draft;
  const current = useRef(draft);
  current.current = draft;
  const inboxIds = draft.inboxIds ?? [];
  const staleSelection = pending && inboxIds.some((id) => !pending.items.some((item) => item.id === id));
  const change = (patch: Partial<ContinuationDraft>) =>
    changeDraft({ text, mode, inboxIds, ...patch, commandId: undefined, expectedRevision: undefined });
  useEffect(() => {
    const controller = new AbortController();
    setPending(null);
    setPendingIssue('');
    void api<TerminalCommunicationPage>(
      `/runs/${run.id}/terminal/messages?pending=true&limit=100`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setPending(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setPendingIssue(error instanceof Error ? error.message : '待处理消息读取失败');
      });
    return () => controller.abort();
  }, [run.id, run.revision, messageRevision, api, readAttempt]);
  useEffect(() => {
    const controller = new AbortController();
    setSession(null);
    setIssue('');
    void api<Session>(`/runs/${run.id}/terminal/session`, undefined, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && value.revision === run.revision) {
          setSession(value);
        } else if (!controller.signal.aborted) setIssue('会话已更新，请重新检查。');
      })
      .catch((error) => {
        if (!controller.signal.aborted) setIssue(error instanceof Error ? error.message : '无法读取会话状态');
      });
    return () => controller.abort();
  }, [run.id, run.revision, api, readAttempt]);
  return (
    <details className="terminal-continuation">
      <summary>补充需求并继续</summary>
      <p className="field-help">{issue || session?.reason || '正在检查会话能力…'}</p>
      <button
        type="button"
        className="text-button"
        disabled={disabled}
        onClick={() => setReadAttempt((value) => value + 1)}
      >
        刷新会话与待处理消息
      </button>
      {(session || draft.commandId) && (
        <>
          <label>
            继续方式
            <select
              aria-label="终端继续方式"
              value={mode}
              disabled={disabled}
              onChange={(event) => change({ mode: event.target.value as typeof mode })}
            >
              <option value="resume" disabled={!session?.canResume}>
                继续原 CLI 会话{!session?.canResume ? '（不可用）' : ''}
              </option>
              <option value="new-session" disabled={!session?.canStartNew}>
                新 CLI 会话处理补充需求
              </option>
            </select>
          </label>
          <label>
            补充需求
            <textarea
              aria-label="终端补充需求"
              rows={3}
              value={text}
              maxLength={60000}
              disabled={disabled}
              onChange={(event) => change({ text: event.target.value })}
              placeholder="描述下一步需要完成的工作…"
            />
          </label>
          <fieldset className="terminal-pending-messages" disabled={disabled}>
            <legend>选择本轮处理的消息{pending ? `（待处理 ${pending.pendingCount} 条）` : ''}</legend>
            <p className="field-help">
              {pendingIssue ||
                (!pending ? '正在读取待处理消息…' : '仅所选消息进入本轮续接；未选和后来收到的消息继续保留。')}
            </p>
            {pending && pending.items.length > 0 && (
              <>
                <div className="terminal-pending-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => change({ inboxIds: pending.items.map((item) => item.id) })}
                  >
                    全选待处理消息
                  </button>
                  <button type="button" className="text-button" onClick={() => change({ inboxIds: [] })}>
                    清空选择
                  </button>
                </div>
                {pending.items.map((item) => (
                  <label key={item.id} className="terminal-pending-item">
                    <input
                      type="checkbox"
                      checked={inboxIds.includes(item.id)}
                      onChange={(event) =>
                        change({
                          inboxIds: event.target.checked
                            ? [...inboxIds, item.id]
                            : inboxIds.filter((id) => id !== item.id),
                        })
                      }
                    />
                    <span>
                      <strong>{item.peer ? `${item.peer.title} · 用户转交` : '用户补充'}</strong>
                      <span>{item.text}</span>
                    </span>
                  </label>
                ))}
              </>
            )}
            {staleSelection && <p role="alert">部分已选消息已发生变化，请清空选择后重新核对。</p>}
            {staleSelection && !pending?.items.length && (
              <button type="button" onClick={() => change({ inboxIds: [] })}>
                清空选择
              </button>
            )}
          </fieldset>
          <p className="field-help">
            继续使用当前工作区、创建时权限和累计运行限制。中断后的未知副作用须先核验。
          </p>
          <button
            type="button"
            className="secondary"
            disabled={
              disabled ||
              (!draft.commandId &&
                (!pending ||
                  !!pendingIssue ||
                  !!staleSelection ||
                  (!text.trim() && !inboxIds.length) ||
                  (mode === 'resume' ? !session?.canResume : !session?.canStartNew)))
            }
            onClick={() =>
              void act(async () => {
                const sent = {
                  ...draft,
                  inboxIds,
                  commandId: draft.commandId ?? crypto.randomUUID(),
                  expectedRevision: draft.expectedRevision ?? run.revision,
                };
                changeDraft(sent);
                try {
                  await mutation(`/runs/${run.id}/terminal/continue`, {
                    commandId: sent.commandId,
                    expectedRevision: sent.expectedRevision,
                    mode: sent.mode,
                    text: sent.text.trim(),
                    inboxIds: sent.inboxIds,
                  });
                  submitted(sent);
                } catch (error) {
                  if (error instanceof ApiError && error.kind === 'http' && (error.status ?? 500) < 500) {
                    if (current.current.commandId === sent.commandId)
                      changeDraft({ ...current.current, commandId: undefined, expectedRevision: undefined });
                    setReadAttempt((value) => value + 1);
                  }
                  throw error;
                }
              })
            }
          >
            {draft.commandId ? '重试上次继续请求' : '继续执行'}
          </button>
        </>
      )}
    </details>
  );
}
