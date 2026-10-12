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

function merger(choices: MergeChoices, unknownBaseline: boolean) {
  const differences: ProjectDraftDifference[] = [];
  function field<T extends Value>(key: string, label: string, original: T, current: T, mine: T): T {
    const conflict =
      !same(current, mine) && (unknownBaseline || (!same(original, current) && !same(original, mine)));
    const choice = conflict ? choices[key] : same(original, mine) ? 'current' : 'mine';
    if (!same(original, current) || !same(original, mine))
      differences.push({ key, label, original, current, mine, unknownBaseline, conflict, choice });
    return choice === 'mine' ? mine : current;
  }
  return { differences, field };
}

/** Field-level three-way merge, including additions and deletion-versus-edit conflicts. */
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
  // Preserve the current plan's order and append newly authored items deterministically.
  const ids = new Set([...currentById.keys(), ...mineById.keys(), ...baseById.keys()]);
  for (const id of ids) {
    const baseItem = baseById.get(id),
      currentItem = currentById.get(id),
      mineItem = mineById.get(id);
    const label = currentItem?.title || mineItem?.title || baseItem?.title || '未命名交付项';
    if (!currentItem || !mineItem) {
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
  return { result, differences, unresolved: differences.filter((row) => row.conflict && !row.choice).length };
}

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

export function differenceText(value: Value, unknown = false): string {
  if (unknown) return '原始基线未记录，无法判断谁修改了此字段';
  if (value === undefined) return '此交付项不存在';
  if (typeof value === 'boolean') return value ? '必需' : '可选';
  if (typeof value === 'string') return value || '（空）';
  return `${value.title || '未命名交付项'}\n说明：${value.description || '（空）'}\n交付物：\n${value.deliverables || '（空）'}\n验收标准：\n${value.acceptanceCriteria || '（空）'}\n${value.required ? '必需交付项' : '可选交付项'}`;
}
