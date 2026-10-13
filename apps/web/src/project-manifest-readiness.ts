import type { ProjectDeliveryBoard } from '../../../packages/contracts/src/project-delivery';
import type { ProjectBoardDraft } from './ProjectBoardDraft';
import { projectTodo } from './ProjectTodos';

export interface ProjectManifestBlocker {
  id: string;
  reason: string;
  action: string;
  target: 'plan' | 'title' | 'selection' | 'remove' | 'item' | 'run' | 'review' | 'refresh';
  itemId?: string;
  runId?: string;
}

/** Known blockers only; the server checks revisions and selected metadata again when freezing. */
export function projectManifestReadiness(
  board: ProjectDeliveryBoard,
  manifest: NonNullable<ProjectBoardDraft['manifest']>,
  state: { unavailable: boolean; busy: boolean },
) {
  const blockers: ProjectManifestBlocker[] = [];
  if (state.unavailable)
    return {
      canFreeze: false,
      blockers: [
        {
          id: 'unknown',
          reason: '项目状态尚未重新确认，当前冻结条件未知。名称与勾选保留，请重读后核对。',
          action: '重读项目状态',
          target: 'refresh',
        },
      ] as ProjectManifestBlocker[],
    };
  if (!board.goal.trim())
    blockers.push({ id: 'goal', reason: '项目目标尚未填写。', action: '填写项目目标', target: 'plan' });
  if (!manifest.title.trim() || manifest.title.trim().length > 200)
    blockers.push({
      id: 'title',
      reason: !manifest.title.trim() ? '本次交付名称尚未填写。' : '本次交付名称超过 200 字符。',
      action: '编辑交付名称',
      target: 'title',
    });
  if (!manifest.selected.length)
    blockers.push({
      id: 'empty',
      reason: board.items.length ? '尚未选择纳入本次冻结的交付项。' : '项目计划中尚无交付项。',
      action: board.items.length ? '选择交付项' : '定义交付项',
      target: board.items.length ? 'selection' : 'plan',
    });
  const selected = new Set(manifest.selected);
  for (const itemId of selected) {
    const item = board.items.find((entry) => entry.id === itemId);
    if (!item) {
      blockers.push({
        id: `removed:${itemId}`,
        reason: `原选交付项已不在当前计划中：${itemId}。`,
        action: '核对并移除失效选择',
        target: 'remove',
        itemId,
      });
      continue;
    }
    if (manifest.selected.filter((id) => id === itemId).length > 1)
      blockers.push({
        id: `duplicate:${itemId}`,
        reason: `${item.title}：重复纳入本次清单，请取消此项勾选后重新选择。`,
        action: '核对重复选择',
        target: 'selection',
        itemId,
      });
    const todo = projectTodo(item);
    if (todo)
      blockers.push({
        id: `readiness:${itemId}`,
        reason: `${item.title}：${todo.reason}`,
        action: todo.action,
        target: !item.current || item.current.missing ? 'item' : todo.target,
        itemId,
        runId: item.current?.runId,
      });
    else if (
      !item.current?.runId ||
      !item.current.fingerprint ||
      !item.current.reviewId ||
      item.current.runRevision == null ||
      item.current.rootRevision == null
    )
      blockers.push({
        id: `metadata:${itemId}`,
        reason: `${item.title}：当前候选的版本、交付或复核元数据不完整，尚不能确认冻结依据。`,
        action: '重读项目状态',
        target: 'refresh',
        itemId,
      });
  }
  for (const item of board.items)
    if (item.required && !selected.has(item.id))
      blockers.push({
        id: `required:${item.id}`,
        reason: `${item.title}：必需交付项尚未纳入本次清单。`,
        action: '核对此项勾选',
        target: 'selection',
        itemId: item.id,
      });
  return { canFreeze: !state.busy && !board.archived && !blockers.length, blockers };
}
