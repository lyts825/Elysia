/**
 * 检查项目清单是否满足准备条件并汇总阻碍项。
 * 检查交付项运行、产物和复核依据是否可冻结成清单，返回阻碍和可用来源；它给出准备信息，不代替服务端生成清单时的复验。
 * EN: Checks known manifest blockers and their repair destinations. Checks run, artifact, and review evidence for manifest freezing and returns blockers/available sources; server manifest creation still revalidates these conditions.
 */
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

/**
 * 仅根据当前看板和冻结草稿列出已知阻塞项及修复目标：项是否存在、候选是否就绪、
 * 必需项与产物选择是否满足条件。这里的可冻结是界面门禁，服务端仍需重新校验版本和元数据。
 * EN: Use current board/frozen draft to list missing items, candidate readiness, required selections, and artifacts. This is a UI freeze gate only; server still revalidates versions/metadata.
 */
export function projectManifestReadiness(
  board: ProjectDeliveryBoard,
  manifest: NonNullable<ProjectBoardDraft['manifest']>,
  state: { unavailable: boolean; busy: boolean },
) {
  const blockers: ProjectManifestBlocker[] = [];
  /**
   * 项目状态未知时不能根据缓存推断冻结资格，先要求重新读取。
   * EN: Unknown project state cannot establish freeze eligibility from cache; reread first.
   */
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
  /**
   * 逐项检查选择是否仍存在、可交付且具备冻结所需的版本与复核依据。
   * EN: Check each selection still exists, is deliverable, and has required version/review evidence.
   */
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
    /**
     * 必需交付项即使未选中也要列为阻碍，不能被选择过滤掉。
     * EN: Include unselected required items as blockers rather than filtering them away.
     */
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
