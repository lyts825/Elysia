/**
 * 定义项目看板草稿，处理读取、写入和看板快照转换。
 * 定义看板编辑、启动、导入撤销与比较基线的本地格式，统一严格解析和容量限制；服务端快照只经投影进入草稿。
 * EN: Defines project-board drafts and converts editable/persisted snapshots. Defines local board-edit, launch, import-undo, and comparison-baseline formats with strict parsing/size limits; server snapshots enter drafts through explicit projection.
 */
import { z } from 'zod';
import type { ProjectDeliveryBoard } from '../../../packages/contracts/src/project-delivery';
import type { WorkbenchCache } from './WorkbenchCache';

const item = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  deliverables: z.string(),
  acceptanceCriteria: z.string(),
  required: z.boolean(),
});
const plan = z.object({
  goal: z.string(),
  scope: z.string(),
  nonGoals: z.string(),
  items: z.array(item).max(40),
});
const launchContent = z.object({
  title: z.string(),
  objective: z.string(),
  deliverables: z.string(),
  acceptanceCriteria: z.string(),
});
const edit = z.object({
  basedOn: z.number().int().nonnegative(),
  goal: z.string(),
  scope: z.string(),
  nonGoals: z.string(),
  items: z.array(item).max(40),
  baseline: plan.optional(),
  baselineOmitted: z.literal('size').optional(),
});
const shape = z.object({
  version: z.literal(1),
  tab: z.enum(['overview', 'items', 'executions', 'manifests']),
  usageOpen: z.boolean().optional(),
  selected: z.string(),
  filter: z.enum(['all', 'attention', 'ready']),
  query: z.string(),
  freeOpen: z.boolean(),
  editing: z.boolean().default(false),
  edit: edit.optional(),
  planImportUndo: edit.optional(),
  launch: z
    .object({
      itemId: z.string(),
      itemRevision: z.number().int().positive(),
      expectedRevision: z.number().int().nonnegative(),
      title: z.string(),
      objective: z.string(),
      deliverables: z.string(),
      acceptanceCriteria: z.string(),
      setupRaw: z.string().optional(),
      baseline: launchContent.optional(),
      baselineOmitted: z.literal('size').optional(),
    })
    .optional(),
  manifest: z
    .object({
      title: z.string(),
      selected: z.array(z.string()).max(40),
      artifacts: z.record(z.string(), z.array(z.string()).max(20)),
    })
    .optional(),
  confirmNotes: z.record(z.string(), z.string()).optional(),
  selectedManifest: z.string().optional(),
  selectedManifestHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const backupItem = item.strict();
/**
 * 本地草稿可兼容扩展字段；导入备份必须严格校验，避免恢复时悄然丢失未知内容。
 * EN: Local drafts tolerate extension fields; imported backups validate strictly to avoid silently losing unknown contents.
 */
const backupPlan = plan.strict().extend({ items: z.array(backupItem).max(40) });
const backupEdit = edit.strict().extend({
  items: z.array(backupItem).max(40),
  baseline: backupPlan.optional(),
});
const backupShape = shape.strict().extend({
  edit: backupEdit.optional(),
  planImportUndo: backupEdit.optional(),
  launch: shape.shape.launch
    .unwrap()
    .strict()
    .extend({ baseline: launchContent.strict().optional() })
    .optional(),
  manifest: shape.shape.manifest.unwrap().strict().optional(),
});
export type ProjectBoardDraft = z.infer<typeof shape>;
export type ProjectBoardEdit = NonNullable<ProjectBoardDraft['edit']>;
export type ProjectPlanSnapshot = z.infer<typeof plan>;
export type ProjectLaunchContent = z.infer<typeof launchContent>;
export const PROJECT_BOARD_DRAFT_LIMIT = 200000;
/**
 * 按项目ID生成看板草稿缓存键，隔离不同项目的计划和编辑状态。
 * EN: Builds a project-specific board draft key, isolating plan edits and UI state between projects.
 */
export const projectBoardKey = (id: string) => `draft:project-board:${id}`;
/**
 * 每次返回新的版本1看板初始状态；默认概览、全部筛选且无选择和编辑。
 * EN: Returns a fresh version-1 board state with overview tab, all-items filter, and no selection or edit in progress.
 */
export const emptyBoardDraft = (): ProjectBoardDraft => ({
  version: 1,
  tab: 'overview',
  selected: '',
  filter: 'all',
  query: '',
  freeOpen: false,
  editing: false,
});
/**
 * 恢复本地编辑工作台；合法空值使用默认状态，解析失败抛错以保护原文和导出机会。
 * EN: Restore local editing state. Valid empty input uses defaults; parse failure throws, preserving the original and export opportunity.
 */
export function readProjectBoardDraft(raw: unknown): ProjectBoardDraft {
  /**
   * 空缓存使用默认值，损坏或超限则抛错并保留原始缓存，不能直接覆盖。
   * EN: Empty cache uses defaults; corrupt/oversized cache throws and is not overwritten.
   */
  if (raw === undefined || raw === '') return emptyBoardDraft();
  try {
    if (typeof raw !== 'string' || raw.length > PROJECT_BOARD_DRAFT_LIMIT) throw Error();
    return shape.parse(JSON.parse(raw));
  } catch {
    throw Error('项目工作台草稿格式或版本无法读取，原文已保留。请导出原稿后再明确清空。');
  }
}
/**
 * 文件恢复拒绝未知字段，避免丢失备份内容。
 * EN: File recovery rejects unknown fields instead of silently losing part of a backup.
 */
export function readProjectBoardBackupDraft(raw: string): ProjectBoardDraft {
  if (raw.length > PROJECT_BOARD_DRAFT_LIMIT)
    throw Error('备份中的工作台草稿超过 200000 字符，当前原稿未改动。');
  if (!raw) return emptyBoardDraft();
  try {
    return backupShape.parse(JSON.parse(raw));
  } catch {
    throw Error('备份中的草稿格式或版本无法读取，或包含未知字段。当前原稿未改动。');
  }
}
/**
 * 只准备序列化结果、不写缓存，供普通编辑和导入容量预览共用。
 * 超限时仅允许省略可选比较基线，不截断用户输入或导入前撤销原稿；仍超限则整体拒绝。
 * EN: Prepare serialization without cache writes for both edits and capacity previews. Omit optional baselines only; never truncate user input or undo originals. Reject if still oversized.
 */
export function prepareProjectBoardDraft(draft: ProjectBoardDraft) {
  let value = draft;
  if (!shape.safeParse(value).success)
    throw Error('本次草稿结构无法保存，原稿已保留。请返回项目工作台重新读取。');
  /**
   * 合法旧草稿不能因快照使容量翻倍就无法编辑。
   * EN: A valid pre-existing draft must not become uneditable because its snapshot doubles storage.
   */
  /**
   * 只可省略可选基线，后续修订需要明确比较。
   * EN: Only optional baselines may be dropped; a later revision then requires explicit comparison.
   */
  for (const key of ['edit', 'launch'] as const) {
    const content = value[key];
    if (content?.baseline && content.baselineOmitted)
      value = { ...value, [key]: { ...content, baselineOmitted: undefined } };
  }
  let raw = JSON.stringify(value);
  const baselines = (['edit', 'launch'] as const).toSorted(
    (a, b) =>
      (JSON.stringify(value[b]?.baseline)?.length ?? 0) - (JSON.stringify(value[a]?.baseline)?.length ?? 0),
  );
  for (const key of baselines) {
    /**
     * 空间不足时先移除体积最大的可选基线，并记录省略原因供后续冲突核对。
     * EN: Omit largest optional baselines first when capacity is tight and record the reason for later conflict review.
     */
    const content = value[key];
    if (raw.length <= PROJECT_BOARD_DRAFT_LIMIT) break;
    if (!content?.baseline) continue;
    value = { ...value, [key]: { ...content, baseline: undefined, baselineOmitted: 'size' } };
    raw = JSON.stringify(value);
  }
  if (raw.length > PROJECT_BOARD_DRAFT_LIMIT)
    throw Error('项目工作台草稿超过 200000 字符，未覆盖原稿。请缩短本次输入后重试。');
  return { value, raw };
}
/**
 * 读取缓存最新草稿，应用更新并通过统一容量规则后一次写入，返回规范化后实际保存的值。
 * EN: Update the newest cached draft, apply shared validation/capacity rules, write once, and return the normalized saved value.
 */
export function writeProjectBoardDraft(
  cache: WorkbenchCache,
  projectId: string,
  update: (draft: ProjectBoardDraft) => ProjectBoardDraft,
) {
  /**
   * 读取旧稿并完成校验及容量检查后才写入，失败不会覆盖先前内容。
   * EN: Write only after validation/capacity checks; failure leaves previous contents intact.
   */
  const { value, raw } = prepareProjectBoardDraft(
    update(readProjectBoardDraft(cache.get(projectBoardKey(projectId)))),
  );
  cache.set(projectBoardKey(projectId), raw);
  return value;
}
/**
 * 把服务端看板投影为可编辑计划快照；数组字段转为多行文本，保留交付项身份和要求供三方合并。
 * EN: Projects a server board into an editable plan snapshot, converting arrays to multiline text and preserving item identities and requirements for three-way merging.
 */
export const boardSnapshot = (board: ProjectDeliveryBoard): ProjectPlanSnapshot => ({
  goal: board.goal,
  scope: board.scope.join('\n'),
  nonGoals: board.nonGoals.join('\n'),
  items: board.items.map(({ id, title, description, deliverables, acceptanceCriteria, required }) => ({
    id,
    title,
    description,
    deliverables: deliverables.join('\n'),
    acceptanceCriteria: acceptanceCriteria.join('\n'),
    required,
  })),
});
/**
 * 将服务端看板转换为可编辑副本，同时保留独立基线与版本用于冲突比较。
 * EN: Convert server board to an editable copy, preserving an independent baseline/revision for conflicts.
 */
export const boardToEdit = (board: ProjectDeliveryBoard): ProjectBoardEdit => {
  const baseline = boardSnapshot(board);
  return { basedOn: board.revision, ...structuredClone(baseline), baseline };
};
/**
 * 为交付项创建草稿组合项目目标/范围与项标准；实际任务权限和预算由创建表单另行确认。
 * EN: Compose item launch requirements from project goal/scope and criteria; creation separately confirms permissions/budget.
 */
export const itemLaunchContent = (
  board: ProjectDeliveryBoard,
  item: ProjectDeliveryBoard['items'][number],
): ProjectLaunchContent => ({
  title: item.title,
  objective: [
    item.title,
    item.description,
    board.goal && `项目目标：${board.goal}`,
    board.scope.length && `项目范围：\n${board.scope.join('\n')}`,
    board.nonGoals.length && `不做事项：\n${board.nonGoals.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n'),
  deliverables: item.deliverables.join('\n'),
  acceptanceCriteria: item.acceptanceCriteria.join('\n'),
});
/**
 * 把多行编辑文本拆成去首尾空白的非空行，作为提交看板数组字段的统一规范化入口。
 * EN: Splits multiline editor text into trimmed nonempty lines, normalizing array fields before board submission.
 */
export const boardLines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
