/**
 * 配置终端任务的继续执行。
 *
 * EN: Configures terminal-task continuation.
 *
 * 本模块读取终端会话续接能力及待处理消息，并编辑父层持有的续接模式、正文和消息选择；过期或不完整读取限制可提交性，真正续接由外层命令完成。
 * EN: Reads session-continuation capabilities/pending messages and edits parent-held mode, body, and selection. Stale/incomplete reads constrain submission; outer commands perform continuation.
 */
import { useEffect, useRef, useState } from 'react';
import type { Run } from '../../../packages/contracts/src/index';
import type { TerminalCommunicationPage } from '../../../packages/contracts/src/terminal-communication';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import './terminal-continuation.css';

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
/**
 * 检查终端会话的续接能力并选择待处理消息；正文、模式和选择保存在调用方草稿中。
 * 会话或消息读取过期时保留草稿，但新请求需等待重新核对。
 *
 * EN: Checks session continuation capabilities and selects pending messages; parent drafts retain text/mode/selection. Stale reads preserve drafts but require fresh validation for a new request.
 */
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
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionReadKey, setSessionReadKey] = useState('');
  const [pending, setPending] = useState<TerminalCommunicationPage | null>(null);
  const [pendingIssue, setPendingIssue] = useState('');
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingReadKey, setPendingReadKey] = useState('');
  const sessionKey = `${run.id}:${run.revision}:${readAttempt}`;
  /**
   * 能力和待处理列表分别绑定读取版本；保留旧显示不等于旧结果仍可用于新提交。
   *
   * EN: Capabilities and pending lists bind separate read versions; retaining old display does not authorize new submissions with it.
   */
  const pendingKey = `${sessionKey}:${messageRevision}`;
  const sessionReady = !!session && !sessionLoading && !issue && sessionReadKey === sessionKey;
  const pendingReady = !!pending && !pendingLoading && !pendingIssue && pendingReadKey === pendingKey;
  const { text, mode } = draft;
  const current = useRef(draft);
  const submitting = useRef(false);
  current.current = draft;
  const inboxIds = draft.inboxIds ?? [];
  const visibleIds = new Set(pending?.items.map((item) => item.id));
  /**
   * 只有读到了完整待处理列表，才能认定已选但未出现的消息已经失效。
   *
   * EN: Only a fully read pending list can prove a selected missing message is stale.
   */
  const staleIds =
    pendingReady && pending && !pending.page.hasMore ? inboxIds.filter((id) => !visibleIds.has(id)) : [];
  const staleSelection = staleIds.length > 0;
  const allSelectedIds = [...new Set([...inboxIds, ...(pending?.items.map((item) => item.id) ?? [])])];
  /**
   * 编辑草稿后清除旧命令身份；未修改的待确认请求仍可用原身份重试。
   *
   * EN: Editing clears old command identity; an unchanged pending request can retry with its original identity.
   */
  const change = (patch: Partial<ContinuationDraft>) =>
    changeDraft({ text, mode, inboxIds, ...patch, commandId: undefined, expectedRevision: undefined });
  useEffect(() => {
    /**
     * 每次重新读取都绑定当前运行与消息版本，旧响应在取消后不会覆盖新状态。
     *
     * EN: Each read binds current run/message revisions; cancellation prevents stale responses overwriting newer state.
     */
    const controller = new AbortController();
    setPendingLoading(true);
    setPendingIssue('');
    void api<TerminalCommunicationPage>(
      `/runs/${run.id}/terminal/messages?pending=true&limit=100`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setPending(value);
          setPendingReadKey(pendingKey);
          setPendingLoading(false);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setPendingIssue(error instanceof Error ? error.message : '待处理消息读取失败');
          setPendingLoading(false);
        }
      });
    return () => controller.abort();
  }, [run.id, pendingKey, api]);
  useEffect(() => {
    const controller = new AbortController();
    setSessionLoading(true);
    /**
     * 能力响应还必须携带当前运行 revision，否则提示重新检查而不启用继续按钮。
     *
     * EN: Capability results must carry the current run revision or continuation stays disabled pending recheck.
     */
    setIssue('');
    void api<Session>(`/runs/${run.id}/terminal/session`, undefined, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && value.revision === run.revision) {
          setSession(value);
          setSessionReadKey(sessionKey);
          setSessionLoading(false);
        } else if (!controller.signal.aborted) {
          setIssue('会话已更新，请重新检查。');
          setSessionLoading(false);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setIssue(error instanceof Error ? error.message : '无法读取会话状态');
          setSessionLoading(false);
        }
      });
    return () => controller.abort();
  }, [run.id, run.revision, sessionKey, api]);
  return (
    <details className="terminal-continuation">
      <summary>补充需求并继续</summary>
      <p
        className={`terminal-continuation-status${issue ? ' has-error' : ''}`}
        role={issue ? 'alert' : 'status'}
        aria-label="会话能力检查结果"
        tabIndex={0}
      >
        {issue || (sessionLoading ? '正在检查会话能力…' : session?.reason || '尚未确认会话能力。')}
        {session && !sessionReady ? ' 上次结果和草稿保留，检查成功后才能发起新的继续请求。' : ''}
      </p>
      <button
        type="button"
        className="secondary"
        disabled={disabled}
        onClick={() => setReadAttempt((value) => value + 1)}
      >
        刷新会话与待处理消息
      </button>
      <>
        <label className="terminal-continuation-field">
          继续方式
          <select
            aria-label="终端继续方式"
            value={mode}
            disabled={disabled}
            onChange={(event) => change({ mode: event.target.value as typeof mode })}
          >
            <option value="resume" disabled={!sessionReady || !session?.canResume}>
              继续原 CLI 会话{!sessionReady ? '（待核对）' : !session?.canResume ? '（不可用）' : ''}
            </option>
            <option value="new-session" disabled={!sessionReady || !session?.canStartNew}>
              新 CLI 会话处理补充需求
            </option>
          </select>
        </label>
        {!draft.commandId &&
          mode === 'resume' &&
          sessionReady &&
          session &&
          !session.canResume &&
          session.canStartNew && (
            <div className="terminal-continuation-notice" role="status">
              <p>当前无法继续原 CLI 会话。可显式选择新会话，保留本次正文和消息选择。</p>
              <button
                type="button"
                className="secondary"
                disabled={disabled}
                onClick={() => change({ mode: 'new-session' })}
              >
                选择新 CLI 会话
              </button>
            </div>
          )}
        {draft.commandId && (
          <p className="terminal-continuation-notice" role="status">
            上次继续请求尚未确认。重试会使用同一请求核对结果；修改正文、方式或消息选择将创建新请求。
          </p>
        )}
        <label className="terminal-continuation-field">
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
        <fieldset className="terminal-pending-messages" disabled={disabled || !pendingReady}>
          <legend>选择本轮处理的消息{pending ? `（待处理 ${pending.pendingCount} 条）` : ''}</legend>
          <p
            className={`terminal-continuation-status${pendingIssue ? ' has-error' : ''}`}
            role={pendingIssue ? 'alert' : 'status'}
            aria-label="待处理消息读取状态"
            tabIndex={0}
          >
            {pendingIssue ||
              (pendingLoading
                ? '正在读取待处理消息…'
                : '所选消息按接收顺序进入本轮续接；未选和后来收到的消息继续保留。')}
            {pending && !pendingReady ? ' 当前显示上次读取的列表，消息选择保留，读取成功后再核对。' : ''}
          </p>
          {pending?.page.hasMore && (
            <p className="field-help">
              当前显示最新 {pending.items.length}{' '}
              条。还有更早的待处理消息，处理本批后刷新查看；未显示的选择保持不变。
            </p>
          )}
          {!!pending && (
            <p className="field-help">
              已选择 {inboxIds.length} 条{staleSelection ? `，其中 ${staleIds.length} 条已失效` : ''}。
            </p>
          )}
          {pending && pending.items.length > 0 && (
            <>
              <div className="terminal-pending-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={allSelectedIds.length > 100}
                  onClick={() => change({ inboxIds: allSelectedIds })}
                >
                  全选当前显示消息
                </button>
                <button type="button" className="secondary" onClick={() => change({ inboxIds: [] })}>
                  清空选择
                </button>
              </div>
              {allSelectedIds.length > 100 && (
                <p className="field-help">每轮最多选择100条。请先减少已有选择，再选择本页消息。</p>
              )}
              {pending.items.map((item, index) => (
                <div
                  key={item.id}
                  className="terminal-pending-item"
                  data-selected={inboxIds.includes(item.id)}
                >
                  <label className="terminal-pending-choice">
                    <input
                      type="checkbox"
                      checked={inboxIds.includes(item.id)}
                      disabled={!inboxIds.includes(item.id) && inboxIds.length >= 100}
                      onChange={(event) =>
                        change({
                          inboxIds: event.target.checked
                            ? [...inboxIds, item.id]
                            : inboxIds.filter((id) => id !== item.id),
                        })
                      }
                    />
                    <span>
                      <span>
                        第 {index + 1} 条 · {inboxIds.includes(item.id) ? '已选择' : '未选择'}
                      </span>
                      <strong>{item.peer ? `${item.peer.title} · 用户转交` : '用户补充'}</strong>
                    </span>
                  </label>
                  <p
                    className="terminal-pending-text"
                    role="region"
                    aria-label={`第 ${index + 1} 条待处理消息正文`}
                    tabIndex={0}
                  >
                    {item.text}
                  </p>
                </div>
              ))}
            </>
          )}
          {staleSelection && (
            <div className="terminal-continuation-notice" role="alert">
              <p>
                {staleIds.length}{' '}
                条已选消息已被处理、撤回或不再处理。移除这些失效选择后，其他选择和正文继续保留。
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() => change({ inboxIds: inboxIds.filter((id) => !staleIds.includes(id)) })}
              >
                移除失效选择
              </button>
            </div>
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
              (!pendingReady ||
                !sessionReady ||
                !!staleSelection ||
                (!text.trim() && !inboxIds.length) ||
                (mode === 'resume' ? !session?.canResume : !session?.canStartNew)))
          }
          onClick={() => {
            /**
             * ref 防止 React 尚未渲染禁用态前的双击，commandId 在发送前写回持久草稿。
             *
             * EN: The ref blocks double-clicks before React renders disabled state; commandId is persisted before sending.
             */
            if (submitting.current) return;
            submitting.current = true;
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
                /**
                 * 明确的客户端 HTTP 拒绝可放弃旧命令身份；断连/服务错误仍可能已执行，须保留原 ID 重试。
                 *
                 * EN: A definitive client HTTP rejection may discard old command identity; disconnect/server failures may already have executed and retain the ID for retry.
                 */
                if (error instanceof ApiError && error.kind === 'http' && (error.status ?? 500) < 500) {
                  if (current.current.commandId === sent.commandId)
                    changeDraft({ ...current.current, commandId: undefined, expectedRevision: undefined });
                  setReadAttempt((value) => value + 1);
                }
                throw error;
              }
            }).finally(() => {
              submitting.current = false;
            });
          }}
        >
          {draft.commandId ? '重试上次继续请求' : '继续执行'}
        </button>
      </>
    </details>
  );
}
