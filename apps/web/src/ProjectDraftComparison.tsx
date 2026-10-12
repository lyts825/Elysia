import { differenceText, type MergeChoice, type ProjectDraftDifference } from './ProjectDraftMerge';

export function ProjectDraftComparison({
  differences,
  choose,
  busy,
}: {
  differences: ProjectDraftDifference[];
  choose: (key: string, choice: MergeChoice) => void;
  busy: boolean;
}) {
  return (
    <div className="project-draft-differences">
      {!differences.length && <p>内容未发生变化，可核对后沿用当前计划版本。</p>}
      {differences.map((row) => (
        <section key={row.key} className="project-draft-difference" aria-label={row.label}>
          <h4>{row.label}</h4>
          <div className="project-difference-columns">
            <div>
              <strong>原始基线</strong>
              <p>{differenceText(row.original, row.unknownBaseline)}</p>
            </div>
            <div>
              <strong>当前计划</strong>
              <p>{differenceText(row.current)}</p>
            </div>
            <div>
              <strong>本人草稿</strong>
              <p>{differenceText(row.mine)}</p>
            </div>
          </div>
          {row.conflict ? (
            <label>
              {row.unknownBaseline ? '基线未知，请明确选择' : '双方修改冲突，请明确选择'}
              <select
                value={row.choice || ''}
                disabled={busy}
                onChange={(event) => choose(row.key, event.target.value as MergeChoice)}
              >
                <option value="" disabled>
                  请选择此项采用的内容
                </option>
                <option value="current">采用当前计划</option>
                <option value="mine">采用本人草稿</option>
              </select>
            </label>
          ) : (
            <p className="field-help">
              {row.current === row.mine
                ? '双方内容一致'
                : row.choice === 'current'
                  ? '无冲突：合并当前计划的变更'
                  : '无冲突：保留本人草稿的变更'}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
