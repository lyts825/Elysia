/**
 * 展示终端任务恢复操作。
 *
 * EN: Displays terminal-task reconciliation actions.
 *
 * 本模块受控收集用户对中断终端操作的实际核验结论及说明；只提交人工声明，副作用核验、容器停止和运行状态转换由外层处理。
 * EN: Collects controlled user verification outcomes/notes for interrupted terminal operations. It submits human declarations only; outer layers verify side effects, stop containers, and transition run state.
 */
import { useId } from 'react';
import './terminal-recovery.css';

/**
 * 受控收集用户对中断操作的实际核验说明和结论，不自行读取文件或推断副作用是否发生。
 * note/changeNote 由外层保存草稿，disabled 或说明为空时禁止两个结果按钮。
 * submit 接收去除首尾空白后的说明与 confirmed/not_applied 结果；容器停止和状态变更由外层完成。
 *
 * EN: A controlled form collects user-verified outcomes without reading files or inferring side effects. The parent retains note/changeNote; disabled/empty notes block both buttons. submit receives trimmed notes plus confirmed/not_applied, while the parent stops containers and changes state.
 */
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
  /**
   * 仅收集人工核验说明及结论；操作结果由 submit 交给上层处理。
   *
   * EN: Collects human verification only; submit delegates actual outcome handling to the parent.
   */
  const noteHelpId = useId(),
    scopeHelpId = useId(),
    noteStateId = useId(),
    confirmedHelpId = useId(),
    pausedHelpId = useId();
  return (
    <div className="terminal-activity terminal-recovery-panel">
      <header className="terminal-recovery-heading">
        <h4>核验中断的终端操作</h4>
        <p className="field-help" id={scopeHelpId}>
          先检查任务日志和任务目录。提交核验结果时，系统会先核对并停止本任务容器。
        </p>
      </header>
      <label>
        实际核验说明
        <textarea
          aria-describedby={`${noteHelpId} ${scopeHelpId} ${noteStateId}`}
          aria-required="true"
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
      <p className="terminal-recovery-state" id={noteStateId} role="status">
        {disabled
          ? '当前只读或操作处理中，暂不可提交核验结果。'
          : note.trim()
            ? `说明已填写，提交时保留 ${note.trim().length.toLocaleString()} 个字符。请选择核验结果。`
            : '填写实际核验说明后，再选择核验结果。'}
      </p>
      <div
        className="terminal-recovery-options"
        role="group"
        aria-label="选择终端核验结果"
        aria-describedby={scopeHelpId}
      >
        <div className="terminal-recovery-option">
          <h5>操作已发生</h5>
          <p id={confirmedHelpId}>保留当前产物并进入验收。</p>
          <button
            type="button"
            className="secondary"
            disabled={disabled || !note.trim()}
            aria-describedby={`${confirmedHelpId} ${noteHelpId} ${noteStateId}`}
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
            aria-describedby={`${pausedHelpId} ${noteHelpId} ${noteStateId}`}
            onClick={() => submit('not_applied', note.trim())}
          >
            确认未发生
          </button>
        </div>
      </div>
    </div>
  );
}
