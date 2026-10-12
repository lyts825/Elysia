import { z } from 'zod';
import type { WorkspaceSurface } from '../../../packages/contracts/src/index';
import { readProjectBoardBackupDraft, type ProjectBoardDraft } from './ProjectBoardDraft';

export const PROJECT_DRAFT_BACKUP_FILE_LIMIT = 640 * 1024;
const binding = z
  .object({
    projectId: z.string().min(1).max(200),
    surface: z.enum(['native', 'terminal']),
    workbenchScope: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const shape = binding
  .extend({
    format: z.literal('elysia.project-workbench-backup'),
    version: z.literal(1),
    createdAt: z.string().datetime(),
    draftRaw: z.string().max(200000),
  })
  .strict();
export type ProjectDraftBackupBinding = {
  projectId: string;
  surface: WorkspaceSurface;
  workbenchScope: string;
};
export type ProjectDraftBackupFile = z.infer<typeof shape>;
export type ProjectDraftBackupPreview = { file: ProjectDraftBackupFile; draft: ProjectBoardDraft };

function requireBinding(value: unknown): ProjectDraftBackupBinding {
  const checked = binding.safeParse(value);
  if (!checked.success) throw Error('当前项目或工作台入口身份无法确认，请重新连接后重试。原稿未改动。');
  return checked.data;
}
function fileText(file: ProjectDraftBackupFile): string {
  const raw = JSON.stringify(file, null, 2) + '\n';
  if (new TextEncoder().encode(raw).byteLength > PROJECT_DRAFT_BACKUP_FILE_LIMIT)
    throw Error('备份文件超过 640 KiB，未生成不完整文件。当前原稿未改动。');
  return raw;
}
export function createProjectDraftBackup(
  draftRaw: string,
  current: ProjectDraftBackupBinding,
  createdAt = new Date().toISOString(),
): { file: ProjectDraftBackupFile; raw: string } {
  const owner = requireBinding(current);
  readProjectBoardBackupDraft(draftRaw);
  const file = shape.parse({
    ...owner,
    format: 'elysia.project-workbench-backup',
    version: 1,
    createdAt,
    draftRaw,
  });
  return { file, raw: fileText(file) };
}
export function readProjectDraftBackup(
  raw: string,
  current: ProjectDraftBackupBinding,
): ProjectDraftBackupPreview {
  const owner = requireBinding(current);
  if (new TextEncoder().encode(raw).byteLength > PROJECT_DRAFT_BACKUP_FILE_LIMIT)
    throw Error('备份文件超过 640 KiB，当前原稿未改动。');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Error('备份文件不是有效 JSON。TXT 原稿仅供查看；复用计划请使用计划 JSON。');
  }
  const checked = shape.safeParse(value);
  if (!checked.success)
    throw Error(
      '仅接受 version 1 的工作台备份 JSON，不允许未知字段。TXT 原稿仅供查看；复用计划请使用计划 JSON。',
    );
  const file = checked.data;
  if (file.projectId !== owner.projectId)
    throw Error('此备份属于另一项目，不能完整恢复。跨项目复用请使用计划 JSON。');
  if (file.surface !== owner.surface) throw Error('此备份属于另一工作台入口，当前原稿未改动。');
  if (file.workbenchScope !== owner.workbenchScope)
    throw Error('此备份属于另一工作台数据范围，当前原稿未改动。');
  return { file, draft: readProjectBoardBackupDraft(file.draftRaw) };
}
export function decodeProjectDraftBackup(
  bytes: ArrayBuffer,
  current: ProjectDraftBackupBinding,
): ProjectDraftBackupPreview {
  if (bytes.byteLength > PROJECT_DRAFT_BACKUP_FILE_LIMIT)
    throw Error('备份文件超过 640 KiB，当前原稿未改动。');
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Error('备份文件不是有效 UTF-8，当前原稿未改动。');
  }
  return readProjectDraftBackup(raw, current);
}

type BackupStorage = Pick<Storage, 'getItem' | 'setItem'>;
export function projectDraftProtectionKey(current: ProjectDraftBackupBinding): string {
  const owner = requireBinding(current);
  return `elysia.project-draft-restore.v1:${owner.workbenchScope}:${owner.surface}:${encodeURIComponent(owner.projectId)}`;
}
export function protectProjectDraftBeforeRestore(
  storage: BackupStorage,
  current: ProjectDraftBackupBinding,
  currentRaw: string,
  expectedProtection: string | null,
  replace: boolean,
): string {
  const next = createProjectDraftBackup(currentRaw, current);
  const key = projectDraftProtectionKey(current);
  let latest: string | null;
  try {
    latest = storage.getItem(key);
  } catch {
    throw Error('无法读取当前浏览器的恢复前备份，未恢复草稿。原输入和预览已保留。');
  }
  if (latest !== expectedProtection)
    throw Error('恢复前备份已被另一窗口修改，请重新核对。当前草稿和预览已保留。');
  if (latest) {
    let same = false;
    try {
      same = readProjectDraftBackup(latest, current).file.draftRaw === currentRaw;
    } catch {
      /* An unreadable old copy still requires explicit replacement. */
    }
    if (same) return latest;
    if (!replace) throw Error('已有不同的恢复前备份，请先另存并明确允许替换。当前草稿未改动。');
  }
  try {
    storage.setItem(key, next.raw);
    if (storage.getItem(key) !== next.raw) throw Error('备份读取核验不一致');
  } catch {
    throw Error('当前浏览器无法完整保留原稿，可能空间不足或存储不可用；未恢复草稿。原输入和预览已保留。');
  }
  return next.raw;
}
export async function restoreProjectDraftWithProtection({
  locks,
  storage,
  current,
  backup,
  expectedCurrent,
  expectedProtection,
  replace,
  readCurrent,
  apply,
  assertActive,
  signal,
}: {
  locks: Pick<LockManager, 'request'> | undefined;
  storage: BackupStorage;
  current: ProjectDraftBackupBinding;
  backup: ProjectDraftBackupPreview;
  expectedCurrent: string;
  expectedProtection: string | null;
  replace: boolean;
  readCurrent: () => string;
  apply: (raw: string) => void;
  assertActive: () => void;
  signal?: AbortSignal;
}): Promise<string> {
  if (!locks?.request) throw Error('当前浏览器不支持安全的备份恢复锁，未恢复草稿；仍可导出或预览备份。');
  return locks.request(projectDraftProtectionKey(current) + ':restore', { mode: 'exclusive', signal }, () => {
    assertActive();
    readProjectDraftBackup(JSON.stringify(backup.file), current);
    if (readCurrent() !== expectedCurrent)
      throw Error('当前原稿已变化，请重新核对后恢复。原输入和预览已保留。');
    const protectedCopy = protectProjectDraftBeforeRestore(
      storage,
      current,
      expectedCurrent,
      expectedProtection,
      replace,
    );
    assertActive();
    if (readCurrent() !== expectedCurrent) throw Error('当前原稿已变化，未恢复草稿；恢复前备份已保留。');
    apply(backup.file.draftRaw);
    return protectedCopy;
  });
}
