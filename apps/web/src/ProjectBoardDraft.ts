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
const shape = z.object({
  version: z.literal(1),
  tab: z.enum(['overview', 'items', 'executions', 'manifests']),
  selected: z.string(),
  filter: z.enum(['all', 'attention', 'ready']),
  query: z.string(),
  freeOpen: z.boolean(),
  editing: z.boolean().default(false),
  edit: z
    .object({
      basedOn: z.number().int().nonnegative(),
      goal: z.string(),
      scope: z.string(),
      nonGoals: z.string(),
      items: z.array(item).max(40),
    })
    .optional(),
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
});
export type ProjectBoardDraft = z.infer<typeof shape>;
export type ProjectBoardEdit = NonNullable<ProjectBoardDraft['edit']>;
export const projectBoardKey = (id: string) => `draft:project-board:${id}`;
export const emptyBoardDraft = (): ProjectBoardDraft => ({
  version: 1,
  tab: 'overview',
  selected: '',
  filter: 'all',
  query: '',
  freeOpen: false,
  editing: false,
});
export function readProjectBoardDraft(raw: unknown): ProjectBoardDraft {
  if (raw === undefined || raw === '') return emptyBoardDraft();
  try {
    if (typeof raw !== 'string' || raw.length > 200000) throw Error();
    return shape.parse(JSON.parse(raw));
  } catch {
    throw Error('项目工作台草稿格式或版本无法读取，原文已保留。请导出原稿后再明确清空。');
  }
}
export function writeProjectBoardDraft(
  cache: WorkbenchCache,
  projectId: string,
  update: (draft: ProjectBoardDraft) => ProjectBoardDraft,
) {
  const value = update(readProjectBoardDraft(cache.get(projectBoardKey(projectId))));
  if (!shape.safeParse(value).success)
    throw Error('本次草稿结构无法保存，原稿已保留。请返回项目工作台重新读取。');
  const raw = JSON.stringify(value);
  if (raw.length > 200000) throw Error('项目工作台草稿超过 200000 字符，未覆盖原稿。请缩短本次输入后重试。');
  cache.set(projectBoardKey(projectId), raw);
  return value;
}
export const boardToEdit = (board: ProjectDeliveryBoard): ProjectBoardEdit => ({
  basedOn: board.revision,
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
export const boardLines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
