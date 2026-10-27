/**
 * 编辑并校验任务交付物和验收标准。
 * 按行去除首尾空白和空项，供表单校验与提交载荷复用。
 *
 * EN: Edits and validates task deliverables and acceptance criteria.
 * Trims each line and removes empty entries for shared form validation and payload building.
 *
 * 本模块提供交付物与验收标准的受控编辑、按行规范化和共享校验；输入阶段保留原文，规范化结果用于后续合同载荷，持久化由调用方完成。
 * EN: Provides controlled editing, line normalization, and shared validation for deliverables/acceptance criteria. Editing preserves raw text; normalized values feed later contract payloads and the caller persists them.
 */
export const requirementLines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
/**
 * 必填时两组至少各一项；每组最多 40 项，每项最多 2000 字。
 *
 * EN: When required, both groups need an entry; each allows at most 40 lines of 2000 characters.
 */
export const validRequirements = (deliverables: string, criteria: string, required: boolean) =>
  [deliverables, criteria].every((value) => {
    const lines = requirementLines(value);
    return (
      (!required || lines.length > 0) && lines.length <= 40 && lines.every((line) => line.length <= 2000)
    );
  });

/**
 * 受控编辑交付物与验收标准原文，以逐行计数显示输入限制；不在输入时删改用户换行或空白。
 * required 由执行模式决定，真正创建合同前使用同一规范化函数和完整校验再次检查。
 *
 * EN: Controlled raw-text editing with per-line limits, preserving user whitespace/newlines during input. Execution mode determines required, and creation reuses the same normalization/validation.
 */
export function TaskRequirements({
  deliverables,
  criteria,
  change,
  required,
  disabled,
}: {
  deliverables: string;
  criteria: string;
  change: (field: 'deliverables' | 'acceptanceCriteria', value: string) => void;
  required: boolean;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <section className="workflow-requirements" aria-label="本次交付要求">
      <h3>本次交付要求</h3>
      <p className="field-help">
        {required
          ? '直接执行前，请至少填写一项交付物和验收标准。'
          : '可先写明具体要求，未填写的内容会在计划阶段确认。'}
        每行一项，最多各 40 项。
      </p>
      {(
        [
          ['deliverables', '交付物', deliverables, '例如：含来源链接的研究报告.md'],
          ['acceptanceCriteria', '验收标准', criteria, '例如：每项结论附原始来源；汇总金额与明细一致'],
        ] as const
      ).map(([field, label, value, placeholder]) => {
        const lines = requirementLines(value);
        const invalid = !validRequirements(value, '', false);
        const helpId = `${id}-${field}-help`;
        return (
          <div className="requirement-field" key={field}>
            <label htmlFor={`${id}-${field}`}>{label}</label>
            <textarea
              id={`${id}-${field}`}
              aria-label={`本次${label}`}
              aria-describedby={helpId}
              aria-invalid={invalid || undefined}
              rows={field === 'deliverables' ? 2 : 3}
              value={value}
              disabled={disabled}
              required={required}
              placeholder={placeholder}
              onChange={(event) => change(field, event.target.value)}
            />
            <p
              id={helpId}
              className={invalid ? 'field-error' : 'field-help'}
              role={invalid ? 'alert' : undefined}
            >
              已填写 {lines.length} / 40 项
              {invalid
                ? '；最多 40 项，每项最多 2000 字。'
                : required && !lines.length
                  ? '；直接执行前至少填写一项。'
                  : '，每项最多 2000 字。'}
            </p>
          </div>
        );
      })}
    </section>
  );
}
import { useId } from 'react';
