/**
 * 校验、导入和导出项目计划，并在导入前检查条件。
 * 严格处理可复用计划文件格式、UTF-8大小和交付约束，导入生成新项身份并保留撤销基线；不导入历史运行或项目内ID。
 * EN: Validates reusable plan imports/exports and previews application capacity. Strictly handles reusable plan format, UTF-8 size, and delivery constraints, assigning fresh item IDs and retaining an undo baseline without importing run history or project-local IDs.
 */
import { z } from 'zod';
import { ProjectDeliveryBoardInput } from '../../../packages/contracts/src/project-delivery';
import {
  boardLines,
  prepareProjectBoardDraft,
  type ProjectBoardDraft,
  type ProjectBoardEdit,
} from './ProjectBoardDraft';

export const PROJECT_PLAN_FILE_LIMIT = 192 * 1024;
const line = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => !!value.trim() && !/[\r\n]/.test(value));
const shape = z
  .object({
    format: z.literal('elysia.project-plan'),
    version: z.literal(1),
    plan: z
      .object({
        goal: z.string().max(4000),
        scope: z.array(line).max(40),
        nonGoals: z.array(line).max(40),
        items: z
          .array(
            z
              .object({
                title: z.string().max(200),
                description: z.string().max(4000),
                deliverables: z.array(line).min(1).max(20),
                acceptanceCriteria: z.array(line).min(1).max(40),
                required: z.boolean(),
              })
              .strict(),
          )
          .max(40),
      })
      .strict(),
  })
  .strict();
export type ProjectPlanTransfer = z.infer<typeof shape>;
const validationId = '00000000-0000-4000-8000-000000000000';

/**
 * 先严格校验计划传输版本与字段，再套用服务端交付计划输入规则；任何项不合法都拒绝整份导入或导出。
 * EN: Strictly validates transfer version and fields before applying server delivery-plan input rules, rejecting the whole import/export if any item is invalid.
 */
function validate(value: unknown): ProjectPlanTransfer {
  /**
   * 先校验传输格式，再用真实的交付计划输入规则检查每一项。
   * EN: Validate transport format before checking every item using actual delivery-plan input rules.
   */
  const result = shape.safeParse(value);
  if (!result.success)
    throw Error('计划文件格式、版本或内容不符合要求。仅接受 version 1，最多 40 个交付项；不允许额外字段。');
  const input = ProjectDeliveryBoardInput.safeParse({
    commandId: validationId,
    expectedRevision: 0,
    ...result.data.plan,
    items: result.data.plan.items.map((item) => ({ ...item, id: validationId })),
  });
  if (!input.success)
    throw Error('每个交付项需有效名称、至少一项交付物和验收标准；各条最多 2000 字。原草稿未改动。');
  /**
   * 保留全部已校验文字，不返回修剪后的保存负载。
   * EN: Keep all validated text, rather than returning the trimmed save payload.
   */
  return result.data;
}

/**
 * 按 UTF-8 字节限制读取 JSON，保留校验通过的原始文字供预览，不返回经过修剪的保存负载。
 * EN: Read JSON within UTF-8 byte limits, preserving validated original wording for preview rather than trimmed save payload.
 */
export function readProjectPlanTransfer(raw: string): ProjectPlanTransfer {
  if (new TextEncoder().encode(raw).byteLength > PROJECT_PLAN_FILE_LIMIT)
    throw Error('计划文件超过 192 KiB，未读取或截断内容。原草稿未改动。');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Error('计划文件不是有效 JSON。原草稿未改动。');
  }
  return validate(value);
}

/**
 * 把编辑草稿转换为可复用版本1计划文件，去除项目内交付项ID和历史；通过统一校验后输出完整JSON。
 * EN: Converts an edit draft to a reusable version-1 plan file without project-local item IDs or history, emitting complete JSON only after shared validation.
 */
export function exportProjectPlan(edit: ProjectBoardEdit): string {
  /**
   * 导出可复用的计划内容，不携带项目内交付项 ID 或历史记录。
   * EN: Export reusable plan content without project item IDs/history.
   */
  const file = validate({
    format: 'elysia.project-plan',
    version: 1,
    plan: {
      goal: edit.goal,
      scope: boardLines(edit.scope),
      nonGoals: boardLines(edit.nonGoals),
      items: edit.items.map(({ title, description, deliverables, acceptanceCriteria, required }) => ({
        title,
        description,
        deliverables: boardLines(deliverables),
        acceptanceCriteria: boardLines(acceptanceCriteria),
        required,
      })),
    },
  });
  const raw = JSON.stringify(file, null, 2) + '\n';
  if (new TextEncoder().encode(raw).byteLength > PROJECT_PLAN_FILE_LIMIT)
    throw Error('当前计划超过 192 KiB，未生成不完整的导出文件。请缩小计划后重试，或导出工作台原草稿。');
  return raw;
}

/**
 * 将可复用计划放入原编辑基线，全部交付项获得新 ID，避免误继承其他项目的历史关联。
 * 本函数不写服务端或缓存；原 basedOn/baseline 保留，保存时仍需版本比较与冲突合并。
 * EN: Apply reusable content to existing edit baseline with new IDs for all items, avoiding inherited cross-project history. This pure function writes neither server nor cache; retain basedOn/baseline for later conflict checks.
 */
export function importProjectPlan(
  file: ProjectPlanTransfer,
  original: ProjectBoardEdit,
  assignId: () => string = () => crypto.randomUUID(),
): ProjectBoardEdit {
  /**
   * 每个导入项分配新 ID；保留原编辑基线，以便保存时继续检测冲突。
   * EN: Assign new item IDs and retain edit baseline for later conflict detection.
   */
  return {
    ...original,
    goal: file.plan.goal,
    scope: file.plan.scope.join('\n'),
    nonGoals: file.plan.nonGoals.join('\n'),
    items: file.plan.items.map((item) => ({
      ...item,
      id: assignId(),
      deliverables: item.deliverables.join('\n'),
      acceptanceCriteria: item.acceptanceCriteria.join('\n'),
    })),
  };
}

/**
 * 将已验证计划应用到当前编辑草稿，为导入项生成新身份并保留一次撤销原稿；已有未处理撤销副本时拒绝覆盖。
 * EN: Applies a validated plan to the current edit draft, assigning fresh item IDs and retaining one undo original; an unresolved undo copy prevents replacement.
 */
export function projectPlanImportDraft(
  draft: ProjectBoardDraft,
  file: ProjectPlanTransfer,
  assignId?: () => string,
): ProjectBoardDraft {
  /**
   * 单次导入只保留一份撤销原稿，避免后续导入覆盖尚未处理的备份。
   * EN: Keep one undo original per import so later imports cannot overwrite an unresolved backup.
   */
  if (!draft.edit) throw Error('项目计划草稿已变化，请重新核对后应用。原输入和导入预览已保留。');
  if (draft.planImportUndo)
    throw Error('已有导入前原稿备份，请先恢复原稿或成功保存项目计划，再导入另一份计划。');
  return {
    ...draft,
    edit: importProjectPlan(file, draft.edit, assignId),
    planImportUndo: structuredClone(draft.edit),
  };
}

export type ProjectPlanImportPreflight =
  | { canApply: true; characters: number; baselineOmitted: boolean }
  | { canApply: false; error: string };

/**
 * 按正式保存规则预演含撤销原稿的总容量；使用等长占位 ID，不分配真实编号或改变草稿。
 * EN: Preview actual serialized capacity including undo original, using equal-length placeholder IDs without allocating real IDs/mutating draft.
 */
export function projectPlanImportPreflight(
  draft: ProjectBoardDraft,
  file: ProjectPlanTransfer,
): ProjectPlanImportPreflight {
  /**
   * 使用正式保存的序列化规则检查导入后容量，但不写入存储。
   * EN: Use production serialization for capacity preview without storage writes.
   */
  try {
    /**
     * 新 ID 固定36字符；预览不分配真实编号或写缓存。
     * EN: New IDs are always 36 characters. Preview neither allocates real IDs nor writes the cache.
     */
    const { value, raw } = prepareProjectBoardDraft(projectPlanImportDraft(draft, file, () => validationId));
    return {
      canApply: true,
      characters: raw.length,
      baselineOmitted: !!value.edit?.baselineOmitted,
    };
  } catch (issue) {
    return {
      canApply: false,
      error: issue instanceof Error ? issue.message : '无法检查草稿容量，原稿和预览已保留。',
    };
  }
}
