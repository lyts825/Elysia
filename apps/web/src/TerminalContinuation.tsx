import { useEffect, useState } from 'react';
import type { Run } from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';

type Session = {
  supported: boolean;
  canResume: boolean;
  canStartNew: boolean;
  reason: string;
  revision: number;
  sessionId?: string;
};
export function TerminalContinuation({
  run,
  disabled,
  act,
}: {
  run: Run;
  disabled: boolean;
  act: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const { api, mutation } = useSurfaceClient();
  const [session, setSession] = useState<Session | null>(null),
    [issue, setIssue] = useState('');
  const [text, setText] = useState(''),
    [mode, setMode] = useState<'resume' | 'new-session'>('resume');
  useEffect(() => {
    const controller = new AbortController();
    setSession(null);
    setIssue('');
    void api<Session>(`/runs/${run.id}/terminal/session`, undefined, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && value.revision === run.revision) {
          setSession(value);
          setMode((current) => (current === 'resume' && !value.canResume ? 'new-session' : current));
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setIssue(error instanceof Error ? error.message : '无法读取会话状态');
      });
    return () => controller.abort();
  }, [run.id, run.revision, api]);
  return (
    <details className="terminal-continuation">
      <summary>补充需求并继续</summary>
      <p className="field-help">{issue || session?.reason || '正在检查会话能力…'}</p>
      {session && (
        <>
          <label>
            继续方式
            <select
              aria-label="终端继续方式"
              value={mode}
              disabled={disabled}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="resume" disabled={!session.canResume}>
                继续原 CLI 会话{!session.canResume ? '（不可用）' : ''}
              </option>
              <option value="new-session" disabled={!session.canStartNew}>
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
              onChange={(event) => setText(event.target.value)}
              placeholder="描述下一步需要完成的工作…"
            />
          </label>
          <p className="field-help">
            继续使用当前工作区、创建时权限和累计运行限制。中断后的未知副作用须先核验。
          </p>
          <button
            type="button"
            className="secondary"
            disabled={
              disabled || !text.trim() || (mode === 'resume' ? !session.canResume : !session.canStartNew)
            }
            onClick={() =>
              void act(async () => {
                await mutation(`/runs/${run.id}/terminal/continue`, {
                  expectedRevision: run.revision,
                  mode,
                  text: text.trim(),
                });
                setText('');
              })
            }
          >
            继续执行
          </button>
        </>
      )}
    </details>
  );
}
