/**
 * 按字段合并项目草稿、当前状态和原始基线，并记录冲突。
 * 以已记录基线区分单边修改和双方冲突，支持计划及启动内容；未知基线明确要求选择，不猜测哪一方更新。
 * EN: Three-way merges draft fields and records conflicts. Uses a recorded baseline to distinguish one-sided edits from conflicts for plans and launch content; an unknown baseline requires a choice rather than guessing which side changed.
 */
import type { ProjectBoardEdit, ProjectLaunchContent, ProjectPlanSnapshot } from './ProjectBoardDraft';

export type MergeChoice = 'current' | 'mine';
export type MergeChoices = Record<string, MergeChoice>;
type Item = ProjectPlanSnapshot['items'][number];
type Value = string | boolean | Item | undefined;
export type ProjectDraftDifference = {
  key: string;
  label: string;
  original: Value;
  current: Value;
  mine: Value;
  unknownBaseline: boolean;
  conflict: boolean;
  choice?: MergeChoice;
};
/**
 * 对受控草稿字段使用JSON序列化比较，统一处理字符串、布尔值和交付项快照的相等性。
 * EN: Compares controlled draft values through JSON serialization, covering strings, booleans, and deliverable snapshots consistently.
 */
const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);
const planLabels = { goal: '项目目标', scope: '范围', nonGoals: '不做事项' } as const;
const itemLabels = {
  title: '名称',
  description: '说明',
  deliverables: '交付物',
  acceptanceCriteria: '验收标准',
  required: '必需交付项',
} as const;
export const launchLabels = {
  title: '交付项名称',
  objective: '本次任务目标',
  deliverables: '本次交付物',
  acceptanceCriteria: '本次验收标准',
} as const;

/**
 * 字段合并器记录每项差异；缺少基线时不能推断单方修改，因此不一致值都需明确选择。
 * EN: Record field differences. Unknown baseline cannot establish one-sided changes, so unequal values require explicit choices.
 */
function merger(choices: MergeChoices, unknownBaseline: boolean) {
  const differences: ProjectDraftDifference[] = [];
  /**
   * 按基线、服务端当前值和本地值进行字段级三方合并；双方修改或基线未知时登记冲突并应用显式选择。
   * EN: Three-way merges a field from baseline, current server value, and local value, recording conflicts for both-side edits or an unknown baseline and applying explicit choices.
   */
  function field<T extends Value>(key: string, label: string, original: T, current: T, mine: T): T {
    /**
     * 双方均修改同一字段或缺少基线时，需要用户选择冲突结果。
     * EN: Both-side edits or missing baseline require conflict selection.
     */
    const conflict =
      !same(current, mine) && (unknownBaseline || (!same(original, current) && !same(original, mine)));
    const choice = conflict ? choices[key] : same(original, mine) ? 'current' : 'mine';
    if (!same(original, current) || !same(original, mine))
      differences.push({ key, label, original, current, mine, unknownBaseline, conflict, choice });
    return choice === 'mine' ? mine : current;
  }
  return { differences, field };
}

/**
 * 按字段进行基线/当前/本人草稿三方合并，交付项以稳定 ID 配对。
 * 单方修改可直接采用，双方不同修改或删除与编辑相遇时要求选择；当前计划顺序优先，
 * 本人新增项随后追加。result 只是暂定预览，unresolved 非零时调用方必须阻止提交。
 * EN: Merge baseline/current/local fields, pairing items by ID. Adopt one-sided edits; require choices for conflicting edits or delete-versus-edit. Preserve current order and append local additions. result is provisional; unresolved must block submission.
 */
export function mergeProjectPlan(
  edit: ProjectBoardEdit,
  current: ProjectPlanSnapshot,
  choices: MergeChoices = {},
) {
  const original = edit.baseline;
  const { differences, field } = merger(choices, !original);
  const result: ProjectPlanSnapshot = { goal: '', scope: '', nonGoals: '', items: [] };
  for (const key of Object.keys(planLabels) as (keyof typeof planLabels)[])
    result[key] = field(key, planLabels[key], original?.[key], current[key], edit[key]) ?? '';

  const baseById = new Map(original?.items.map((item) => [item.id, item]));
  const currentById = new Map(current.items.map((item) => [item.id, item]));
  const mineById = new Map(edit.items.map((item) => [item.id, item]));
  /**
   * 保持当前顺序并确定性追加本人新增项。
   * EN: Preserve the current plan's order and append newly authored items deterministically.
   */
  const ids = new Set([...currentById.keys(), ...mineById.keys(), ...baseById.keys()]);
  for (const id of ids) {
    const baseItem = baseById.get(id),
      currentItem = currentById.get(id),
      mineItem = mineById.get(id);
    const label = currentItem?.title || mineItem?.title || baseItem?.title || '未命名交付项';
    if (!currentItem || !mineItem) {
      /**
       * 整项新增或删除作为一个字段比较；双方仍保留时再逐字段合并。
       * EN: Compare whole-item addition/deletion as one field; use per-field merge when both sides retain it.
       */
      const kept = field(`items.${id}`, `交付项「${label}」· 新增或移除`, baseItem, currentItem, mineItem);
      if (kept) result.items.push({ ...kept });
      continue;
    }
    const merged: Item = { ...currentItem };
    for (const key of Object.keys(itemLabels) as (keyof typeof itemLabels)[]) {
      const value = field(
        `items.${id}.${key}`,
        `交付项「${label}」· ${itemLabels[key]}`,
        baseItem?.[key],
        currentItem[key],
        mineItem[key],
      );
      if (key === 'required') merged.required = value as boolean;
      else merged[key] = value as string;
    }
    result.items.push(merged);
  }
  /**
   * 仍未选择的冲突供界面阻止提交，result 只是可预览的暂定结果。
   * EN: Unchosen conflicts block submission; result remains a provisional preview.
   */
  return { result, differences, unresolved: differences.filter((row) => row.conflict && !row.choice).length };
}

/**
 * 创建草稿使用同一三方规则，但只合并目标、标题、交付物和标准，不改模型与预算配置。
 * EN: Launch drafts reuse three-way rules for goal/title/deliverables/criteria only, leaving model/budget settings alone.
 */
export function mergeProjectLaunch(
  original: ProjectLaunchContent | undefined,
  current: ProjectLaunchContent,
  mine: ProjectLaunchContent,
  choices: MergeChoices = {},
) {
  const { differences, field } = merger(choices, !original);
  const result: ProjectLaunchContent = { ...current };
  for (const key of Object.keys(launchLabels) as (keyof typeof launchLabels)[])
    result[key] = field(key, launchLabels[key], original?.[key], current[key], mine[key]) ?? '';
  return { result, differences, unresolved: differences.filter((row) => row.conflict && !row.choice).length };
}

/**
 * 把差异值转为可读详情，区分未知基线、删除、空文本和必需性，并展开交付项要求供人工核对。
 * EN: Formats differences for inspection, distinguishing an unknown baseline, deletion, empty text, and required status while expanding deliverable requirements.
 */
export function differenceText(value: Value, unknown = false): string {
  if (unknown) return '原始基线未记录，无法判断谁修改了此字段';
  if (value === undefined) return '此交付项不存在';
  if (typeof value === 'boolean') return value ? '必需' : '可选';
  if (typeof value === 'string') return value || '（空）';
  return `${value.title || '未命名交付项'}\n说明：${value.description || '（空）'}\n交付物：\n${value.deliverables || '（空）'}\n验收标准：\n${value.acceptanceCriteria || '（空）'}\n${value.required ? '必需交付项' : '可选交付项'}`;
}
