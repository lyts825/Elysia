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

function validate(value: unknown): ProjectPlanTransfer {
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
  // Keep all validated text, rather than returning the trimmed save payload.
  return result.data;
}

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

export function exportProjectPlan(edit: ProjectBoardEdit): string {
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

/** This is still a local edit on its original baseline; server CAS and merging stay intact. */
export function importProjectPlan(
  file: ProjectPlanTransfer,
  original: ProjectBoardEdit,
  assignId: () => string = () => crypto.randomUUID(),
): ProjectBoardEdit {
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

export function projectPlanImportDraft(
  draft: ProjectBoardDraft,
  file: ProjectPlanTransfer,
  assignId?: () => string,
): ProjectBoardDraft {
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

export function projectPlanImportPreflight(
  draft: ProjectBoardDraft,
  file: ProjectPlanTransfer,
): ProjectPlanImportPreflight {
  try {
    // New IDs are always 36 characters. Preview neither allocates real IDs nor writes the cache.
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
