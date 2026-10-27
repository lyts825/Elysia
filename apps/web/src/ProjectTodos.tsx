/* 从项目交付项生成并展示待办。 */
import type {
  ProjectDeliveryBoard,
  ProjectDeliveryItem,
} from '../../../packages/contracts/src/project-delivery';
import { executionLabel } from './ProjectRunList';
import { useId } from 'react';
import './project-todos.css';

export const projectTodoLabels = {
  create: '待创建 / 关联',
  execution: '执行未完成',
  review: '待人工复核',
  changes: '需修改',
  feedback: '原意见待复验',
  standard: '项目标准需确认',
  unavailable: '记录不可读 / 不可用',
} as const;
type Todo = {
  category: keyof typeof projectTodoLabels;
  reason: string;
  action: string;
  target: 'item' | 'run' | 'review';
};

/** 将交付就绪状态映射为待办原因和跳转目标；已就绪项不生成待办。 */
export function projectTodo(item: ProjectDeliveryItem): Todo | undefined {
  const current = item.current;
  switch (item.readiness) {
    case 'ready':
      return;
    case 'unlinked':
      return {
        category: 'create',
        reason: item.attemptCount
          ? `已有关联执行 ${item.attemptCount} 次，尚未选择当前候选。`
          : '尚无关联执行和当前候选，需创建任务或关联已有执行。',
        action: item.attemptCount ? '选择当前候选' : '创建或关联任务',
        target: 'item',
      };
    case 'not_done':
      return {
        category: 'execution',
        reason: `当前候选执行状态：${executionLabel(current?.status ?? null)}。执行完成后还需复核与确认。`,
        action: '查看执行进展',
        target: current && !current.missing ? 'run' : 'item',
      };
    case 'review_pending':
      return {
        category: 'review',
        reason: '执行已完成，当前交付尚未获得人工采纳。',
        action: '复核当前交付',
        target: 'review',
      };
    case 'review_stale':
      return {
        category: 'review',
        reason: '交付内容已变化，原人工复核已失效，需重新检查当前交付。',
        action: '重新复核交付',
        target: 'review',
      };
    case 'changes_requested':
      return {
        category: 'changes',
        reason: '人工复核已要求修改，需要按反馈修订并再次复核。',
        action: '查看修改意见',
        target: 'review',
      };
    case 'source_feedback_pending':
      return {
        category: 'feedback',
        reason: `原意见仍有 ${current?.sourceNotes.pending ?? 0} 条待复验、${current?.sourceNotes.needsChanges ?? 0} 条需修改、${current?.sourceNotes.stale ?? 0} 条需重新核对。`,
        action: '检查原意见复验',
        target: 'review',
      };
    case 'unconfirmed':
      return {
        category: 'standard',
        reason: item.confirmationStale
          ? '项目标准、候选或交付已变化，原符合性确认已失效。'
          : '人工采纳与原意见复验已满足，尚未确认当前候选符合项目标准。',
        action: '对照并确认项目标准',
        target: 'item',
      };
    default:
      return {
        category: 'unavailable',
        reason: current?.missing
          ? '当前候选的源任务已删除，无法核验交付；需重新选择或创建候选。'
          : current?.issue ||
            (current?.sourceNotes.unavailable
              ? `有 ${current.sourceNotes.unavailable} 条原意见记录无法读取，结果未知，不能视为已完成。`
              : '当前候选记录无法读取，状态未知，不能视为已完成。'),
        action: current?.executionHold ? '查看执行恢复提示' : '检查候选与读取情况',
        target: current?.executionHold ? 'run' : 'item',
      };
  }
}

export function ProjectTodos({
  board,
  unavailable,
  selectItem,
  openRun,
  manifests,
  onEditPlan,
  busy,
}: {
  board: ProjectDeliveryBoard;
  unavailable: boolean;
  selectItem: (id: string) => void;
  openRun: (itemId: string, runId: string, review?: boolean) => void;
  manifests: () => void;
  onEditPlan: () => void;
  busy: boolean;
}) {
  const id = useId();
  const entries = board.items
    .map((item) => ({ item, todo: projectTodo(item) }))
    .filter((entry): entry is { item: ProjectDeliveryItem; todo: Todo } => !!entry.todo)
    .sort((a, b) => Number(b.item.required) - Number(a.item.required));
  return (
    <section className="project-todos" aria-label="项目待办">
      <header className="project-todo-heading">
        <h2>项目待办</h2>
        <span>{entries.length} 项交付待办</span>
      </header>
      <p className="field-help">
        必需项优先，按每个交付项当前的首个阻塞条件引导下一步。完成一步后刷新查看后续条件。
      </p>
      <dl className="project-todo-counts" aria-label="待办分类计数">
        {Object.entries(projectTodoLabels).map(([key, label]) => (
          <div key={key} data-category={key}>
            <dt>{label}</dt>
            <dd>{entries.filter(({ todo }) => todo.category === key).length}</dd>
          </div>
        ))}
      </dl>
      {unavailable && (
        <p className="field-error" role="status">
          项目状态读取失败；以下为上次读取结果，当前完成情况未知。请刷新项目状态后再确认。
        </p>
      )}
      {!unavailable && !board.goal.trim() && (
        <article className="project-todo-row">
          <div>
            <strong>项目目标待填写</strong>
            <p>冻结交付清单前需要填写并保存项目目标。</p>
          </div>
          <button type="button" className="secondary" disabled={busy || board.archived} onClick={onEditPlan}>
            填写项目目标
          </button>
        </article>
      )}
      {entries.map(({ item, todo }, index) => (
        <article className="project-todo-row" key={item.id}>
          <div className="project-todo-content">
            <div className="project-todo-meta">
              <span>{item.required ? '必需' : '可选'}</span>
              <span className="project-readiness">{projectTodoLabels[todo.category]}</span>
            </div>
            <div className="project-todo-reading" role="region" aria-label="待办交付项完整名称" tabIndex={0}>
              <h3 id={`${id}-title-${index}`}>{item.title}</h3>
            </div>
            <div className="project-todo-reading" role="region" aria-label="待办原因全文" tabIndex={0}>
              <p>{todo.reason}</p>
            </div>
          </div>
          <button
            type="button"
            className="secondary project-todo-action"
            aria-describedby={`${id}-title-${index}`}
            onClick={() => {
              if (todo.target === 'item' || !item.current || item.current.missing) selectItem(item.id);
              else openRun(item.id, item.current.runId, todo.target === 'review');
            }}
          >
            {todo.action}
          </button>
        </article>
      ))}
      {!entries.length &&
        (!board.items.length ? (
          <p>尚未定义交付项。请编辑项目计划，明确交付物和验收标准。</p>
        ) : (
          !unavailable &&
          !!board.goal.trim() && (
            <div>
              <p>
                {board.archived
                  ? '项目已归档，可查看已有交付清单。'
                  : busy
                    ? '正在处理项目操作，完成后可核对交付清单。'
                    : '当前交付项均已满足交付条件，可前往核对本次冻结选择。'}
              </p>
              <button type="button" className="secondary" disabled={busy} onClick={manifests}>
                前往汇总交付
              </button>
            </div>
          )
        ))}
    </section>
  );
}
