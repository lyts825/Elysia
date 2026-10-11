import { ProjectDeliveryBoardInput } from '../../../packages/contracts/src/project-delivery';
import type { ProjectBoardEdit } from './ProjectBoardDraft';
import { boardLines } from './ProjectBoardDraft';

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
  revision,
  change,
  save,
  close,
  rebase,
}: {
  edit: ProjectBoardEdit;
  busy: boolean;
  revision: number;
  change: (edit: ProjectBoardEdit) => void;
  save: () => void;
  close: () => void;
  rebase: () => void;
}) {
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
      {edit.basedOn !== revision && (
        <div className="field-error" role="alert">
          项目已从版本 {edit.basedOn} 更新到 {revision}。输入已保留，请返回查看当前计划，再明确以此草稿替换。
          <button type="button" className="secondary" onClick={rebase} disabled={busy}>
            已核对最新计划，保留输入继续
          </button>
        </div>
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
        disabled={busy || !valid.success || edit.basedOn !== revision}
        onClick={save}
      >
        {busy ? '正在保存…' : '保存项目计划'}
      </button>
    </section>
  );
}
