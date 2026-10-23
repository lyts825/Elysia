import { useId } from 'react';
import './terminal-operation-notices.css';

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
  const noteHelpId = useId();
  return (
    <div className="terminal-activity terminal-operation-recovery">
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
          {note.length.toLocaleString()} / 60,000 字；填写实际核验说明后可确认结果。
        </small>
      </label>
      <div className="terminal-operation-outcomes">
        <p>已发生：保留当前产物并进入验收。未发生：保持暂停，之后选择恢复。</p>
        {disabled && <p>当前只读或操作处理中，暂不可提交核验结果。</p>}
      </div>
      <div className="terminal-operation-actions">
        <button
          type="button"
          className="secondary"
          disabled={disabled || !note.trim()}
          onClick={() => submit('confirmed', note.trim())}
        >
          确认已发生，审阅产物
        </button>
        <button
          type="button"
          className="secondary"
          disabled={disabled || !note.trim()}
          onClick={() => submit('not_applied', note.trim())}
        >
          确认未发生，保持暂停
        </button>
      </div>
    </div>
  );
}
