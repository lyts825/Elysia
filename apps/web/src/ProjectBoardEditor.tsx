import { useState, type RefObject } from 'react';
import {
  ProjectDeliveryBoardInput,
  type ProjectDeliveryBoard,
} from '../../../packages/contracts/src/project-delivery';
import type { ProjectBoardEdit } from './ProjectBoardDraft';
import { boardLines, boardSnapshot } from './ProjectBoardDraft';
import { mergeProjectPlan, type MergeChoices } from './ProjectDraftMerge';
import { ProjectDraftComparison } from './ProjectDraftComparison';
import { ProjectPlanTransfer, type PlanImportLifecycle } from './ProjectPlanTransfer';
import type { ProjectPlanTransfer as PlanFile, ProjectPlanImportPreflight } from './project-plan-transfer';

export function boardEditPayload(edit: ProjectBoardEdit) {
  return {
    expectedRevision: edit.basedOn,
    goal: edit.goal,
    scope: boardLines(edit.scope),
    nonGoals: boardLines(edit.nonGoals),
    items: edit.items.map((item) => ({
      ...item,
      deliverables: boardLines(item.deliverables),
      acceptanceCriteria: boardLines(item.acceptanceCriteria),
    })),
  };
}
export function ProjectBoardEditor({
  edit,
  busy,
  board,
  change,
  save,
  close,
  canRestorePlan,
  applyPlan,
  restorePlan,
  inspectPlan,
  exportOriginal,
  planLifecycle,
}: {
  edit: ProjectBoardEdit;
  busy: boolean;
  board: ProjectDeliveryBoard;
  change: (edit: ProjectBoardEdit) => void;
  save: () => void;
  close: () => void;
  canRestorePlan: boolean;
  applyPlan: (file: PlanFile) => boolean;
  restorePlan: () => boolean;
  inspectPlan: (file: PlanFile) => ProjectPlanImportPreflight;
  exportOriginal: () => void;
  planLifecycle: RefObject<PlanImportLifecycle | null>;
}) {
  const current = boardSnapshot(board);
  const comparisonKey = JSON.stringify([board.revision, current, edit]);
  const [selection, setSelection] = useState<{ key: string; choices: MergeChoices }>({
    key: '',
    choices: {},
  });
  const comparison = mergeProjectPlan(
    edit,
    current,
    selection.key === comparisonKey ? selection.choices : {},
  );
  const needsMerge = edit.basedOn !== board.revision || (!edit.baseline && !edit.baselineOmitted);
  const valid = ProjectDeliveryBoardInput.safeParse({
    commandId: '00000000-0000-4000-8000-000000000000',
    ...boardEditPayload(edit),
  });
  return (
    <section className="project-board-editor" aria-label="编辑项目交付计划">
      <div className="project-section-heading">
        <h2>编辑项目交付计划</h2>
        <button type="button" className="secondary" onClick={close} disabled={busy}>
          返回工作台 · 保留草稿
        </button>
      </div>
      <p className="field-help">
        保存只更新项目说明和交付项，不会重写已创建任务。已有关联候选需按变更后的标准重新确认。
      </p>
      <ProjectPlanTransfer
        key={board.projectId}
        projectId={board.projectId}
        edit={edit}
        busy={busy}
        canRestore={canRestorePlan}
        apply={applyPlan}
        restore={restorePlan}
        inspect={inspectPlan}
        exportOriginal={exportOriginal}
        lifecycle={planLifecycle}
      />
      {edit.baselineOmitted && (
        <p className="field-help" role="status">
          此草稿正文较大，原始基线因保存容量限制未保留；用户输入完整保留。保存仍校验计划版本，若计划变化，所有差异需逐项明确选择。
        </p>
      )}
      {needsMerge && (
        <section className="project-draft-comparison" aria-label="计划变更对照">
          <h3>计划变更对照</h3>
          <p role="status">
            草稿基于版本 {edit.basedOn}，当前计划版本 {board.revision}
            。请核对原始、当前和本人内容，再合并到当前版本。
          </p>
          {!edit.baseline && (
            <p className="field-error">
              旧草稿没有原始基线，无法判断哪些字段被修改。所有不一致内容均需逐项选择，原稿在合并前保留。
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
            <p className="field-error">还有 {comparison.unresolved} 项冲突待选择，尚不能保存项目计划。</p>
          )}
          {comparison.result.items.length > 40 && (
            <p className="field-error">合并后超过 40 个交付项，请先在下方移除不再需要的草稿新增项。</p>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => change({ ...comparison.result, basedOn: board.revision, baseline: current })}
            disabled={busy || comparison.unresolved > 0 || comparison.result.items.length > 40}
          >
            合并到当前计划版本
          </button>
          <p className="field-help">
            合并只更新此草稿；核对后仍需保存项目计划。若当前计划再次变化，将重新对照。
          </p>
        </section>
      )}
      <fieldset disabled={busy}>
        <label>
          项目目标
          <textarea
            value={edit.goal}
            maxLength={4000}
            rows={3}
            onChange={(e) => change({ ...edit, goal: e.target.value })}
          />
        </label>
        <div className="project-form-columns">
          <label>
            范围（每行一项）
            <textarea
              value={edit.scope}
              rows={4}
              onChange={(e) => change({ ...edit, scope: e.target.value })}
            />
          </label>
          <label>
            不做事项（每行一项）
            <textarea
              value={edit.nonGoals}
              rows={4}
              onChange={(e) => change({ ...edit, nonGoals: e.target.value })}
            />
          </label>
        </div>
        {edit.items.map((item, index) => (
          <section className="project-editor-item" key={item.id} aria-label={`交付项 ${index + 1}`}>
            <div className="project-section-heading">
              <h3>交付项 {index + 1}</h3>
              <button
                type="button"
                className="secondary danger"
                onClick={() => change({ ...edit, items: edit.items.filter((entry) => entry.id !== item.id) })}
              >
                从计划移除
              </button>
            </div>
            <label>
              交付项名称
              <input
                maxLength={200}
                value={item.title}
                onChange={(e) =>
                  change({
                    ...edit,
                    items: edit.items.map((entry) =>
                      entry.id === item.id ? { ...entry, title: e.target.value } : entry,
                    ),
                  })
                }
              />
            </label>
            <label>
              说明
              <textarea
                maxLength={4000}
                value={item.description}
                onChange={(e) =>
                  change({
                    ...edit,
                    items: edit.items.map((entry) =>
                      entry.id === item.id ? { ...entry, description: e.target.value } : entry,
                    ),
                  })
                }
              />
            </label>
            <div className="project-form-columns">
              <label>
                交付物（每行一项，最多 20 项）
                <textarea
                  value={item.deliverables}
                  rows={3}
                  onChange={(e) =>
                    change({
                      ...edit,
                      items: edit.items.map((entry) =>
                        entry.id === item.id ? { ...entry, deliverables: e.target.value } : entry,
                      ),
                    })
                  }
                />
              </label>
              <label>
                验收标准（每行一项，最多 40 项）
                <textarea
                  value={item.acceptanceCriteria}
                  rows={3}
                  onChange={(e) =>
                    change({
                      ...edit,
                      items: edit.items.map((entry) =>
                        entry.id === item.id ? { ...entry, acceptanceCriteria: e.target.value } : entry,
                      ),
                    })
                  }
                />
              </label>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={item.required}
                onChange={(e) =>
                  change({
                    ...edit,
                    items: edit.items.map((entry) =>
                      entry.id === item.id ? { ...entry, required: e.target.checked } : entry,
                    ),
                  })
                }
              />
              项目必需交付项
            </label>
          </section>
        ))}
        <button
          type="button"
          className="secondary"
          disabled={edit.items.length >= 40}
          onClick={() =>
            change({
              ...edit,
              items: [
                ...edit.items,
                {
                  id: crypto.randomUUID(),
                  title: '',
                  description: '',
                  deliverables: '',
                  acceptanceCriteria: '',
                  required: true,
                },
              ],
            })
          }
        >
          添加交付项
        </button>
      </fieldset>
      {!valid.success && (
        <p className="field-help">
          每个交付项需名称、至少一项交付物和验收标准；各条最多 2000 字，范围和不做事项各最多 40 条。
        </p>
      )}
      <button
        type="button"
        className="primary"
        disabled={busy || !valid.success || needsMerge}
        onClick={save}
      >
        {busy ? '正在保存…' : '保存项目计划'}
      </button>
    </section>
  );
}
