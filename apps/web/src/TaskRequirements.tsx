export const requirementLines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
export const validRequirements = (deliverables: string, criteria: string, required: boolean) =>
  [deliverables, criteria].every((value) => {
    const lines = requirementLines(value);
    return (
      (!required || lines.length > 0) && lines.length <= 40 && lines.every((line) => line.length <= 2000)
    );
  });

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
  return (
    <section className="workflow-requirements" aria-label="本次交付要求">
      <h3>本次交付要求</h3>
      <p className="field-help">
        {required
          ? '直接执行前，请至少填写一项交付物和验收标准。'
          : '可先写明具体要求，未填写的内容会在计划阶段确认。'}
        每行一项，最多各 40 项。
      </p>
      <label>
        交付物
        <textarea
          aria-label="本次交付物"
          rows={2}
          value={deliverables}
          disabled={disabled}
          required={required}
          placeholder="例如：含来源链接的研究报告.md"
          onChange={(event) => change('deliverables', event.target.value)}
        />
      </label>
      <label>
        验收标准
        <textarea
          aria-label="本次验收标准"
          rows={3}
          value={criteria}
          disabled={disabled}
          required={required}
          placeholder="例如：每项结论附原始来源；汇总金额与明细一致"
          onChange={(event) => change('acceptanceCriteria', event.target.value)}
        />
      </label>
      {!validRequirements(deliverables, criteria, false) && (
        <p className="field-error" role="alert">
          每类最多 40 项，每项最多 2000 字。
        </p>
      )}
    </section>
  );
}
