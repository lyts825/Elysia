import { useState } from 'react';

export function TerminalRecovery({
  disabled,
  submit,
}: {
  disabled: boolean;
  submit: (outcome: 'confirmed' | 'not_applied', note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <div className="terminal-activity">
      <h4>核验中断的终端操作</h4>
      <p>
        先检查右侧日志和任务目录。确认已发生会保留当前产物并进入验收；确认未发生会暂停任务，之后由你选择恢复。系统会先核对并停止本任务容器。
      </p>
      <label>
        实际核验说明
        <textarea
          value={note}
          disabled={disabled}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          placeholder="说明已检查的文件、日志与执行结果"
        />
      </label>
      <div className="form-columns">
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
