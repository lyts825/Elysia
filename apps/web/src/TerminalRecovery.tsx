import { useId } from 'react';
import './terminal-recovery.css';

export function TerminalRecovery({
  disabled,
  note,
  changeNote,
  submit,
}: {
  disabled: boolean;
  note: string;
  changeNote: (value: string) => void;
  submit: (outcome: 'confirmed' | 'not_applied', note: string) => void;
}) {
  const noteHelpId = useId(),
    confirmedHelpId = useId(),
    pausedHelpId = useId();
  return (
    <div className="terminal-activity terminal-recovery-panel">
      <h4>核验中断的终端操作</h4>
      <p className="field-help">先检查任务日志和任务目录。提交核验结果时，系统会先核对并停止本任务容器。</p>
      <label>
        实际核验说明
        <textarea
          aria-describedby={noteHelpId}
          value={note}
          disabled={disabled}
          rows={2}
          maxLength={60000}
          onChange={(e) => changeNote(e.target.value)}
          placeholder="说明已检查的文件、日志与执行结果"
        />
        <small className="field-help" id={noteHelpId}>
          {note.length.toLocaleString()} / 60,000 字符；提交时去除说明首尾空白。
        </small>
      </label>
      <p className="terminal-recovery-state" role="status">
        {disabled
          ? '当前只读或操作处理中，暂不可提交核验结果。'
          : note.trim()
            ? '说明已填写，请选择核验结果。'
            : '填写实际核验说明后，再选择核验结果。'}
      </p>
      <div className="terminal-recovery-options" role="group" aria-label="选择终端核验结果">
        <div className="terminal-recovery-option">
          <h5>操作已发生</h5>
          <p id={confirmedHelpId}>保留当前产物并进入验收。</p>
          <button
            type="button"
            className="secondary"
            disabled={disabled || !note.trim()}
            aria-describedby={`${confirmedHelpId} ${noteHelpId}`}
            onClick={() => submit('confirmed', note.trim())}
          >
            确认已发生
          </button>
        </div>
        <div className="terminal-recovery-option">
          <h5>操作未发生</h5>
          <p id={pausedHelpId}>保持暂停，之后选择恢复。</p>
          <button
            type="button"
            className="secondary"
            disabled={disabled || !note.trim()}
            aria-describedby={`${pausedHelpId} ${noteHelpId}`}
            onClick={() => submit('not_applied', note.trim())}
          >
            确认未发生
          </button>
        </div>
      </div>
    </div>
  );
}
