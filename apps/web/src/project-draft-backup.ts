/**
 * 创建、校验与恢复项目草稿备份，并保护恢复前的草稿。
 * 以完整原文和精确工作台绑定生成备份，恢复前通过锁、比较和读回确认保护原稿；JSON解码、容量或并发冲突失败均不输出截断数据。
 * EN: Creates/restores complete project-draft backups and protects pre-restore originals. Backs up full source with exact workbench binding and protects originals through locks, comparison, and readback before restoration; decode/size/concurrency failures never yield truncated data.
 */
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

/**
 * 用Schema验证项目、入口和工作台绑定，失败时抛出不改原稿的明确错误。
 * EN: Validates project, surface, and workbench binding with the schema, throwing an explicit error without modifying the original draft on failure.
 */
function requireBinding(value: unknown): ProjectDraftBackupBinding {
  const checked = binding.safeParse(value);
  if (!checked.success) throw Error('当前项目或工作台入口身份无法确认，请重新连接后重试。原稿未改动。');
  return checked.data;
}
/**
 * 将完整备份序列化为易读JSON并按UTF-8字节检查容量；超限时拒绝生成，避免输出截断备份。
 * EN: Serializes a complete backup as readable JSON and checks UTF-8 size, refusing oversized output rather than producing a truncated backup.
 */
function fileText(file: ProjectDraftBackupFile): string {
  const raw = JSON.stringify(file, null, 2) + '\n';
  if (new TextEncoder().encode(raw).byteLength > PROJECT_DRAFT_BACKUP_FILE_LIMIT)
    throw Error('备份文件超过 640 KiB，未生成不完整文件。当前原稿未改动。');
  return raw;
}
/**
 * 生成包含完整 draftRaw 和精确所属身份的备份；任何容量或草稿校验失败都不产生截断文件。
 * EN: Back up full draftRaw and exact scope identity; failed capacity/validation never creates a truncated file.
 */
export function createProjectDraftBackup(
  draftRaw: string,
  current: ProjectDraftBackupBinding,
  createdAt = new Date().toISOString(),
): { file: ProjectDraftBackupFile; raw: string } {
  /**
   * 先确认工作台身份及草稿可读，再生成带来源身份的完整备份文件。
   * EN: Confirm readable workbench identity/draft before generating complete provenance-bound backup.
   */
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
/**
 * 严格读取备份 JSON 并核对三重所属身份；跨项目、跨入口或跨认证范围均拒绝完整恢复。
 * EN: Strictly parse backup and validate project/surface/auth scope; reject cross-scope full recovery.
 */
export function readProjectDraftBackup(
  raw: string,
  current: ProjectDraftBackupBinding,
): ProjectDraftBackupPreview {
  /**
   * 完整恢复必须匹配项目、入口和工作台数据范围；跨项目复用走计划导入。
   * EN: Full restore requires project/surface/data scope; use plan import for cross-project reuse.
   */
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
/**
 * 先限制文件体积，再严格解码UTF-8并校验备份结构和当前绑定，返回可核对预览；非法字节不替换后继续恢复。
 * EN: Bounds file size before strict UTF-8 decoding and validates backup structure and current binding to return an inspectable preview; invalid bytes are never replaced and silently restored.
 */
export function decodeProjectDraftBackup(
  bytes: ArrayBuffer,
  current: ProjectDraftBackupBinding,
): ProjectDraftBackupPreview {
  /**
   * 严格解码，避免将非法字节替换成字符后误认为备份完整。
   * EN: Decode strictly so invalid bytes cannot become replacement characters falsely presented as intact backup.
   */
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
/**
 * 返回保护副本字节数、创建时间和可读状态；损坏副本仍保留大小信息，便于导出或人工处置。
 * EN: Returns protection-copy byte size, creation time, and readability, retaining size information for corrupt copies so they can be exported or inspected manually.
 */
export function projectDraftProtectionInfo(raw: string, current: ProjectDraftBackupBinding) {
  const bytes = new TextEncoder().encode(raw).byteLength;
  try {
    return { bytes, createdAt: readProjectDraftBackup(raw, current).file.createdAt, readable: true };
  } catch {
    return { bytes, createdAt: null, readable: false };
  }
}
/**
 * 验证绑定后以工作台、入口和编码项目ID构造保护副本键，防止跨项目或入口覆盖。
 * EN: Validates binding and constructs a protection key from workbench, surface, and encoded project ID to prevent cross-project or cross-surface overwrites.
 */
export function projectDraftProtectionKey(current: ProjectDraftBackupBinding): string {
  const owner = requireBinding(current);
  return `elysia.project-draft-restore.v1:${owner.workbenchScope}:${owner.surface}:${encodeURIComponent(owner.projectId)}`;
}
/**
 * 比较当前浏览器副本仍等于预览时的 expectedProtection 后保存恢复前原稿。
 * 已有相同原稿可复用；不同或不可读副本要求明确 replace，写入后读回一致才返回成功。
 * EN: Compare current protection copy with preview expectedProtection before saving original. Reuse equal originals; different/unreadable copies require explicit replace. Read back equality before success.
 */
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
  /**
   * 与预览时看到的副本比较，防止另一个窗口的更新被静默覆盖。
   * EN: Compare preview-time copy to avoid overwriting another window's update.
   */
  if (latest !== expectedProtection)
    throw Error('恢复前备份已被另一窗口修改，请重新核对。当前草稿和预览已保留。');
  if (latest !== null) {
    let same = false;
    try {
      same = readProjectDraftBackup(latest, current).file.draftRaw === currentRaw;
    } catch {
      /**
       * 不可读旧副本也需明确替换。
       * EN: An unreadable old copy still requires explicit replacement.
       */
    }
    if (same) return latest;
    if (!replace) throw Error('已有不同的恢复前备份，请先另存并明确允许替换。当前草稿未改动。');
  }
  try {
    storage.setItem(key, next.raw);
    /**
     * 浏览器存储写入后回读，确认完整原稿确实可用，才允许后续恢复。
     * EN: Read back browser storage to prove complete original is available before restore.
     */
    if (storage.getItem(key) !== next.raw) throw Error('备份读取核验不一致');
  } catch {
    throw Error('当前浏览器无法完整保留原稿，可能空间不足或存储不可用；未恢复草稿。原输入和预览已保留。');
  }
  return next.raw;
}
/**
 * 独占锁覆盖重新核验、保护原稿和应用备份，readCurrent 在等待结束和应用前各检查一次。
 * assertActive 由界面验证代次与范围；缺少 LockManager 时拒绝恢复，不能降级为无锁覆盖。
 * EN: Lock revalidation/protection/application. readCurrent checks after waiting and before applying; assertActive validates UI generation/scope. Reject without LockManager, never downgrade to unlocked overwrite.
 */
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
  onCritical,
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
  onCritical?: () => void;
}): Promise<string> {
  if (!locks?.request) throw Error('当前浏览器不支持安全的备份恢复锁，未恢复草稿；仍可导出或预览备份。');
  /**
   * 独占锁覆盖身份复核、原稿备份与应用；再次读取草稿以发现等待期间的修改。
   * EN: One exclusive lock covers identity, original backup, and apply; reread to catch edits while waiting.
   */
  return locks.request(projectDraftProtectionKey(current) + ':restore', { mode: 'exclusive', signal }, () => {
    assertActive();
    onCritical?.();
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
/**
 * 使用与恢复相同的锁删除明确确认过的副本；删除后读回 null 才能证明成功。
 * EN: Delete confirmed copy under the same lock; read back null before declaring success.
 */
export async function deleteProjectDraftProtection({
  locks,
  storage,
  current,
  expectedProtection,
  assertActive,
  signal,
  onCritical,
}: {
  locks: Pick<LockManager, 'request'> | undefined;
  storage: Pick<Storage, 'getItem' | 'removeItem'>;
  current: ProjectDraftBackupBinding;
  expectedProtection: string;
  assertActive: () => void;
  signal?: AbortSignal;
  onCritical?: () => void;
}): Promise<void> {
  if (!locks?.request) throw Error('当前浏览器不支持安全的副本管理锁，未删除恢复前副本。');
  /**
   * 删除与恢复使用同一把锁，并核对用户确认过的副本仍是最新内容。
   * EN: Deletion and restore share a lock and recheck the confirmed latest copy.
   */
  const key = projectDraftProtectionKey(current);
  return locks.request(key + ':restore', { mode: 'exclusive', signal }, () => {
    assertActive();
    onCritical?.();
    let latest: string | null;
    try {
      latest = storage.getItem(key);
    } catch {
      throw Error('无法核对当前浏览器的恢复前副本，未删除。当前草稿和预览保留。');
    }
    if (latest !== expectedProtection)
      throw Error('恢复前副本已变化，请重新另存和确认后再删除。当前草稿和预览保留。');
    assertActive();
    try {
      storage.removeItem(key);
    } catch {
      let unchanged = false;
      try {
        unchanged = storage.getItem(key) === expectedProtection;
      } catch {
        /**
         * 结果仍然未知。
         * EN: Result remains unknown.
         */
      }
      if (unchanged) throw Error('恢复前副本未删除，请检查浏览器存储后重试。当前草稿和预览未改动。');
      throw Error('删除结果未确认，请保留另存文件并重新核对副本状态。当前草稿和预览未改动。');
    }
    let after: string | null;
    try {
      after = storage.getItem(key);
    } catch {
      throw Error('删除结果未确认，请保留另存文件并重新核对副本状态。当前草稿和预览未改动。');
    }
    if (after !== null)
      throw Error('删除结果未确认，请保留另存文件并重新核对副本状态。当前草稿和预览未改动。');
  });
}
