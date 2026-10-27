/* 比较项目草稿与当前内容。 */
import { differenceText, type MergeChoice, type ProjectDraftDifference } from './ProjectDraftMerge';
import './project-draft-comparison.css';

/**
 * 纯展示三方字段差异和采用结果，不修改合并结果本身。
 * 每个冲突的选择以稳定 key 回传，父组件负责将选择绑定到当次完整比较身份。
 */
export function ProjectDraftComparison({
  differences,
  choose,
  busy,
}: {
  differences: ProjectDraftDifference[];
  choose: (key: string, choice: MergeChoice) => void;
  busy: boolean;
}) {
  // 显示基线、当前值和本机值；冲突选择交由父组件保存。
  return (
    <div className="project-draft-differences">
      {!differences.length && <p>内容未发生变化，可核对后沿用当前计划版本。</p>}
      {differences.map((row) => (
        <section
          key={row.key}
          className="project-draft-difference"
          aria-label={row.label}
          data-conflict={row.conflict}
          data-choice={row.choice}
        >
          <div className="project-difference-heading">
            <h4>{row.label}</h4>
            <span className="project-difference-status">
              {row.conflict ? (row.choice ? '已选择' : '待选择') : '无冲突'}
            </span>
          </div>
          <div className="project-difference-columns">
            <div className="project-difference-side">
              <strong>原始基线</strong>
              <div
                className="project-difference-content"
                role="region"
                tabIndex={0}
                aria-label={`${row.label}：原始基线内容`}
              >
                <p>{differenceText(row.original, row.unknownBaseline)}</p>
              </div>
            </div>
            <div className="project-difference-side" data-selected={row.choice === 'current'}>
              <strong>当前计划 {row.choice === 'current' && <span>将采用</span>}</strong>
              <div
                className="project-difference-content"
                role="region"
                tabIndex={0}
                aria-label={`${row.label}：当前计划内容`}
              >
                <p>{differenceText(row.current)}</p>
              </div>
            </div>
            <div className="project-difference-side" data-selected={row.choice === 'mine'}>
              <strong>本人草稿 {row.choice === 'mine' && <span>将采用</span>}</strong>
              <div
                className="project-difference-content"
                role="region"
                tabIndex={0}
                aria-label={`${row.label}：本人草稿内容`}
              >
                <p>{differenceText(row.mine)}</p>
              </div>
            </div>
          </div>
          {row.conflict ? (
            <label className="project-difference-choice">
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
