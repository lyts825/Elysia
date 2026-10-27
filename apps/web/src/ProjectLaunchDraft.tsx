/* 编辑项目交付项启动草稿。 */
import { useId, useState } from 'react';
import type { ProjectDeliveryBoard } from '../../../packages/contracts/src/project-delivery';
import { itemLaunchContent, type ProjectBoardDraft, type ProjectLaunchContent } from './ProjectBoardDraft';
import { readRunSetupDraft, writeRunSetupDraft, type RunSetupDraft } from './RunSetupDraft';
import { mergeProjectLaunch, type MergeChoices } from './ProjectDraftMerge';
import { ProjectDraftComparison } from './ProjectDraftComparison';
import './project-launch-draft.css';

type Launch = NonNullable<ProjectBoardDraft['launch']>;
export function effectiveLaunchContent(launch: Launch): ProjectLaunchContent {
  // 运行设置中已有交付与验收输入时优先使用，其他字段沿用启动草稿。
  const setup = readRunSetupDraft(launch.setupRaw);
  return {
    title: launch.title,
    objective: launch.objective,
    deliverables: setup?.deliverables ?? launch.deliverables,
    acceptanceCriteria: setup?.acceptanceCriteria ?? launch.acceptanceCriteria,
  };
}
export function ProjectLaunchDraft({
  board,
  draft,
  busy,
  change,
  launch,
  remove,
}: {
  board: ProjectDeliveryBoard;
  draft: Launch;
  busy: boolean;
  change: (draft: Launch) => void;
  launch: () => void;
  remove: () => void;
}) {
  const headingId = useId();
  const item = board.items.find((entry) => entry.id === draft.itemId);
  const current = item ? itemLaunchContent(board, item) : undefined;
  let setup: RunSetupDraft | undefined,
    mine: ProjectLaunchContent | undefined,
    parseError = '';
  try {
    setup = readRunSetupDraft(draft.setupRaw);
    mine = effectiveLaunchContent(draft);
  } catch (issue) {
    parseError = issue instanceof Error ? issue.message : '创建配置无法读取，原稿已保留。';
  }
  const comparisonKey = JSON.stringify([board.revision, current, draft]);
  const [selection, setSelection] = useState<{ key: string; choices: MergeChoices }>({
    key: '',
    choices: {},
  });
  const [applyError, setApplyError] = useState('');
  const comparison =
    current && mine
      ? mergeProjectLaunch(
          draft.baseline,
          current,
          mine,
          selection.key === comparisonKey ? selection.choices : {},
        )
      : undefined;
  const needsMerge =
    draft.expectedRevision !== board.revision ||
    draft.itemRevision !== item?.itemRevision ||
    (!draft.baseline && !draft.baselineOmitted);
  const retained =
    current &&
    mine &&
    (mine.objective !== current.objective ||
      mine.deliverables !== current.deliverables ||
      mine.acceptanceCriteria !== current.acceptanceCriteria);
  return (
    <section className="project-launch-draft" aria-labelledby={headingId}>
      <header className="project-launch-heading">
        <h3 id={headingId}>交付项创建草稿</h3>
        <span className="project-launch-state">
          {!item || parseError
            ? '草稿待核对'
            : needsMerge
              ? '需核对计划变更'
              : retained
                ? '依据已对齐 · 保留自定义要求'
                : '依据版本已对齐'}
        </span>
      </header>
      <p className="field-help">待创建任务</p>
      <p
        className="project-launch-reading project-launch-title"
        role="region"
        id={`${headingId}-title`}
        tabIndex={0}
        aria-label="创建草稿完整任务名称"
      >
        {draft.title}
      </p>
      <dl className="project-launch-versions">
        <div>
          <dt>草稿依据计划</dt>
          <dd>版本 {draft.expectedRevision}</dd>
        </div>
        <div>
          <dt>当前项目计划</dt>
          <dd>版本 {board.revision}</dd>
        </div>
        <div>
          <dt>草稿依据标准</dt>
          <dd>版本 {draft.itemRevision}</dd>
        </div>
        <div>
          <dt>当前交付项标准</dt>
          <dd>{item ? `版本 ${item.itemRevision}` : '已移除'}</dd>
        </div>
      </dl>
      {draft.baselineOmitted && (
        <p className="field-help" role="status">
          此草稿正文较大，原始基线因保存容量限制未保留；目标、要求和创建配置完整保留。创建仍校验计划版本，若计划变化，所有差异需逐项明确选择。
        </p>
      )}
      {parseError && (
        <p
          className="field-error project-launch-reading"
          role="alert"
          tabIndex={0}
          aria-label="创建配置读取错误全文"
        >
          {parseError}
        </p>
      )}
      {applyError && (
        <p
          className="field-error project-launch-reading"
          role="alert"
          tabIndex={0}
          aria-label="创建草稿保存错误全文"
        >
          {applyError}
        </p>
      )}
      {!item && (
        <p className="field-error" role="alert">
          来源交付项已从当前计划移除。创建草稿仍保留，不能继续关联已移除的交付项。
        </p>
      )}
      {needsMerge && comparison && (
        <section className="project-draft-comparison" aria-label="创建草稿变更对照">
          <h3>创建草稿变更对照</h3>
          <p>
            项目计划从版本 {draft.expectedRevision} 变为 {board.revision}
            。本人草稿列显示创建表单实际采用的目标、交付物和验收标准。
          </p>
          {!draft.baseline && (
            <p className="field-error">
              旧创建草稿没有原始基线，所有不一致内容需逐项选择。已保存的配置与用户输入会保留。
            </p>
          )}
          <ProjectDraftComparison
            differences={comparison.differences}
            busy={busy}
            choose={(key, choice) =>
              setSelection({
                key: comparisonKey,
                choices: { ...(selection.key === comparisonKey ? selection.choices : {}), [key]: choice },
              })
            }
          />
          {comparison.unresolved > 0 && (
            <p className="field-error">还有 {comparison.unresolved} 项冲突待选择。</p>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy || board.archived || comparison.unresolved > 0}
            onClick={() => {
              if (!item || !current) return;
              const next = comparison.result;
              try {
                change({
                  ...draft,
                  ...next,
                  expectedRevision: board.revision,
                  itemRevision: item.itemRevision,
                  baseline: current,
                  ...(setup
                    ? {
                        setupRaw: writeRunSetupDraft({
                          ...setup,
                          deliverables: next.deliverables,
                          acceptanceCriteria: next.acceptanceCriteria,
                        }),
                      }
                    : {}),
                });
                setApplyError('');
              } catch (issue) {
                setApplyError(issue instanceof Error ? issue.message : '创建草稿保存失败，原稿已保留。');
              }
            }}
          >
            应用对照结果到创建草稿
          </button>
          <p className="field-help">
            此操作保留模型、权限和预算等创建配置。创建任务后仍需按当前项目标准复核与确认。
          </p>
        </section>
      )}
      {retained && mine && (
        <details className="project-retained-requirements" open>
          <summary>创建表单仍采用保留或自定义内容</summary>
          <p className="field-help">
            以下值与当前项目说明或标准不同；继续创建后可直接编辑，不会自动覆盖用户设置。
          </p>
          {mine.objective !== current!.objective && (
            <div>
              <strong>本次任务目标</strong>
              <p
                className="project-prose project-launch-reading"
                role="region"
                tabIndex={0}
                aria-label="本次保留的任务目标全文"
              >
                {mine.objective || '（空）'}
              </p>
            </div>
          )}
          {mine.deliverables !== current!.deliverables && (
            <div>
              <strong>本次交付物</strong>
              <p
                className="project-prose project-launch-reading"
                role="region"
                tabIndex={0}
                aria-label="本次保留的交付物全文"
              >
                {mine.deliverables || '（空）'}
              </p>
            </div>
          )}
          {mine.acceptanceCriteria !== current!.acceptanceCriteria && (
            <div>
              <strong>本次验收标准</strong>
              <p
                className="project-prose project-launch-reading"
                role="region"
                tabIndex={0}
                aria-label="本次保留的验收标准全文"
              >
                {mine.acceptanceCriteria || '（空）'}
              </p>
            </div>
          )}
        </details>
      )}
      {board.archived && <p className="field-help">项目已归档，当前草稿仍保留；无法继续创建或应用对照。</p>}
      <p className="project-launch-next-step" id={`${headingId}-next-step`}>
        继续只打开任务配置表单，核对后仍需明确创建任务。移除只清除此创建草稿，不会修改项目计划或历史任务。
      </p>
      <div className="project-actions project-launch-actions">
        <button
          type="button"
          className="primary"
          aria-describedby={`${headingId}-title ${headingId}-next-step`}
          disabled={busy || board.archived || needsMerge || !item || !!parseError}
          onClick={launch}
        >
          继续填写创建配置
        </button>
        <button
          type="button"
          className="secondary danger"
          disabled={busy}
          aria-describedby={`${headingId}-title ${headingId}-next-step`}
          onClick={remove}
        >
          移除此创建草稿
        </button>
      </div>
    </section>
  );
}
