/**
 * 提供项目草稿备份相关界面。
 * 为看板原稿提供JSON备份、TXT保全及恢复预览，协调保护副本、跨窗口变化与关键写入阶段；底层格式和锁由备份模块实现。
 * EN: Provides complete project-draft backup and recovery UI. Provides JSON backups, TXT preservation, and restore previews while coordinating protection copies, cross-window changes, and critical writes; the backup module implements format and locking rules.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchCache } from './WorkbenchCache';
import { projectBoardKey } from './ProjectBoardDraft';
import { useSurfaceClient } from './SurfaceClientContext';
import {
  PROJECT_DRAFT_BACKUP_FILE_LIMIT,
  createProjectDraftBackup,
  decodeProjectDraftBackup,
  deleteProjectDraftProtection,
  projectDraftProtectionKey,
  projectDraftProtectionInfo,
  restoreProjectDraftWithProtection,
  readProjectDraftBackup,
  type ProjectDraftBackupBinding,
  type ProjectDraftBackupPreview,
} from './project-draft-backup';
import './project-draft-backup.css';

/**
 * 以临时Blob URL触发指定文件名的原文下载；完成触发后释放URL，供JSON和TXT导出共用。
 * EN: Triggers a raw-content download with the supplied filename through a temporary Blob URL and releases it afterward, supporting JSON and TXT exports.
 */
function download(raw: string, name: string, type = 'application/json;charset=utf-8') {
  /**
   * 用临时对象 URL 导出，触发下载后释放浏览器持有的资源。
   * EN: Export with a temporary object URL and release it after triggering download.
   */
  const url = URL.createObjectURL(new Blob([raw], { type }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
/**
 * 完整备份与恢复项目工作台草稿，绑定项目、入口及认证数据范围。
 * 预览固定当前原文和已有恢复前副本；恢复前必须确认仍未变化，并先保存且读回原稿副本。
 * 等待浏览器独占锁时允许取消，进入同步临界区后完成核验与应用；恢复和删除副本互斥。
 * EN: Bind complete draft backup/recovery to project/surface/auth scope. Freeze current original and protection copy in preview, recheck unchanged bytes, then save/read back original before restore. Permit cancellation while waiting for an exclusive lock; finish synchronous verification/application inside it. Restore and copy deletion are exclusive.
 */
export function ProjectDraftBackup({
  projectId,
  cache,
  raw,
  busy: externalBusy,
  restored,
}: {
  projectId: string;
  cache: WorkbenchCache;
  raw: unknown;
  busy: boolean;
  restored: () => void;
}) {
  const client = useSurfaceClient();
  const scope = client.workbenchScope();
  const binding: ProjectDraftBackupBinding = {
    projectId,
    surface: client.surface,
    workbenchScope: scope ?? '',
  };
  const ownerKey = JSON.stringify(binding);
  const [open, setOpen] = useState(false),
    [reading, setReading] = useState(false);
  const [restorePhase, setRestorePhase] = useState<'idle' | 'waiting' | 'critical'>('idle');
  const [deletePhase, setDeletePhase] = useState<'idle' | 'waiting' | 'critical'>('idle');
  const deleting = deletePhase !== 'idle';
  const restoring = restorePhase !== 'idle';
  const busy = externalBusy || restoring || deleting;
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [protectedRaw, setProtectedRaw] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    backup: ProjectDraftBackupPreview;
    currentRaw: string;
    protection: string | null;
  }>();
  const [acknowledged, setAcknowledged] = useState(false),
    [replace, setReplace] = useState(false);
  const [downloadedProtection, setDownloadedProtection] = useState<string | null>(null);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    restoringNow = useRef(false);
  const deletingNow = useRef(false),
    restorePhaseNow = useRef<'idle' | 'waiting' | 'critical'>('idle'),
    deletePhaseNow = useRef<'idle' | 'waiting' | 'critical'>('idle');
  const restoreController = useRef<AbortController | undefined>(undefined);
  const deleteController = useRef<AbortController | undefined>(undefined);
  const protectionInfo = useMemo(
    () => (protectedRaw === null ? undefined : projectDraftProtectionInfo(protectedRaw, binding)),
    [protectedRaw, ownerKey],
  );
  /**
   * 读取当前项目看板原稿；缺省视为空稿，非字符串立即报错，避免恢复流程覆盖不可读数据。
   * EN: Reads the current project-board source draft, treating absence as empty and rejecting non-string data so recovery cannot overwrite unreadable input.
   */
  const currentRaw = () => {
    const value = cache.get(projectBoardKey(projectId));
    if (value === undefined || value === '') return '';
    if (typeof value !== 'string') throw Error('当前工作台原稿无法读取，请先导出 TXT 核对。当前输入未改动。');
    return value;
  };
  /**
   * 按当前工作台和项目绑定读取本地保护副本，存储异常交由调用方呈现。
   * EN: Reads the local protection copy for the current workbench/project binding, leaving storage-error presentation to its caller.
   */
  const readProtection = () => localStorage.getItem(projectDraftProtectionKey(binding));
  useLayoutEffect(() => {
    setProtectedRaw(null);
    setError('');
    setNotice('');
    setReading(false);
    setPreview(undefined);
    setAcknowledged(false);
    setReplace(false);
    setDownloadedProtection(null);
    setDeleteConfirmed(false);
    try {
      setProtectedRaw(readProtection());
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : '当前浏览器的备份存储不可用。');
    }
    /**
     * 仅响应当前保护键的跨窗口变化，更新副本并撤销旧确认，防止使用过期确认删除新副本。
     * EN: Handles cross-window changes only for the active protection key, updating the copy and revoking old acknowledgement so it cannot authorize deletion of a newer copy.
     */
    const onStorage = (event: StorageEvent) => {
      let key: string;
      try {
        key = projectDraftProtectionKey(binding);
      } catch {
        return;
      }
      if (event.key !== key) return;
      setProtectedRaw(event.newValue);
      setAcknowledged(false);
      setReplace(false);
      setDownloadedProtection(null);
      setDeleteConfirmed(false);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      generation.current++;
      restoreController.current?.abort();
      deleteController.current?.abort();
      window.removeEventListener('storage', onStorage);
    };
  }, [ownerKey]);
  useEffect(() => {
    setAcknowledged(false);
    setReplace(false);
    setDownloadedProtection(null);
    setDeleteConfirmed(false);
  }, [raw]);
  useEffect(() => {
    setDeleteConfirmed(false);
    setDownloadedProtection(null);
  }, [protectedRaw]);
  /**
   * 固定“待恢复备份、当前原文、已有保护副本”三者，后续确认与执行都基于同一快照。
   * EN: Freeze backup, current original, and existing protection copy together for confirmation/application.
   */
  const prepare = (backup: ProjectDraftBackupPreview) => {
    /**
     * 预览绑定当前原稿和已有保护副本，恢复时再次比较这些快照。
     * EN: Bind preview to current original/protection copy and compare again at restore.
     */
    const protection = readProtection();
    setProtectedRaw(protection);
    setPreview({ backup, currentRaw: currentRaw(), protection });
    setAcknowledged(false);
    setReplace(false);
    setDownloadedProtection(null);
    setNotice('');
    setDeleteConfirmed(false);
    setError('');
    setOpen(true);
  };
  /**
   * 取消旧恢复并以新代次读取用户文件；完整解码、验证绑定后才展示恢复预览，旧代次结果忽略。
   * EN: Cancels earlier recovery and reads the selected file under a new generation; a restore preview appears only after full decoding and binding validation, ignoring obsolete results.
   */
  const read = async (file: File) => {
    /**
     * 用代次忽略过期的文件读取；只有完整解码并验证后才展示预览。
     * EN: Use generation to discard old file reads; preview only fully decoded, valid input.
     */
    restoreController.current?.abort();
    const request = ++generation.current;
    setReading(true);
    setError('');
    setNotice('');
    setPreview(undefined);
    setAcknowledged(false);
    setReplace(false);
    setDeleteConfirmed(false);
    try {
      if (file.size > PROJECT_DRAFT_BACKUP_FILE_LIMIT) throw Error('备份文件超过 640 KiB，当前原稿未改动。');
      const bytes = await file.arrayBuffer();
      if (request !== generation.current) return;
      prepare(decodeProjectDraftBackup(bytes, binding));
    } catch (issue) {
      if (request === generation.current)
        setError(issue instanceof Error ? issue.message : '备份读取失败，当前原稿未改动。');
    } finally {
      if (request === generation.current) setReading(false);
    }
  };
  let unchanged = false;
  try {
    unchanged = !!preview && preview.currentRaw === currentRaw() && preview.protection === protectedRaw;
  } catch {
    /**
     * 显式恢复处理器报告当前草稿无法读取。
     * EN: The explicit restore handler reports the unreadable current draft.
     */
  }
  let differentProtection = preview?.protection !== undefined && preview.protection !== null;
  if (preview && preview.protection !== null) {
    try {
      differentProtection =
        readProjectDraftBackup(preview.protection, binding).file.draftRaw !== preview.currentRaw;
    } catch {
      differentProtection = true;
    }
  }
  const protectionReady = !differentProtection || (replace && downloadedProtection === preview?.protection);
  /**
   * 生成带类型、项目身份和随机UUID的备份文件名，降低多次导出时的命名冲突。
   * EN: Builds a backup filename with kind, project identity, and a random UUID to reduce collisions between exports.
   */
  const backupName = (kind: string, extension = 'json') =>
    `elysia-workbench-${kind}-${projectId}-${crypto.randomUUID()}.${extension}`;
  /**
   * 统一执行同步导出动作并管理错误；失败后尽力重读保护副本，读取失败保留最后可见副本。
   * EN: Runs a synchronous export action with shared error handling; on failure it best-effort rereads protection state while retaining the last visible copy if that read fails.
   */
  const attempt = (action: () => void) => {
    try {
      action();
      setError('');
    } catch (issue) {
      try {
        setProtectedRaw(readProtection());
      } catch {
        /**
         * 保留最后可见副本。
         * EN: Keep the last visible copy.
         */
      }
      setError(issue instanceof Error ? issue.message : '备份操作失败，当前原稿未改动。');
    }
  };
  /**
   * 在独占锁内重新核对当前身份与原文；成功只替换本地工作台草稿，不保存项目计划。
   * EN: Recheck identity and original under exclusive lock. Replace local workbench draft only, not the saved plan.
   */
  const restore = async () => {
    /**
     * 恢复与删除互斥；进入临界区后仍核对界面代次和工作台作用域。
     * EN: Restore/delete are exclusive; still check UI generation and workbench scope inside the critical section.
     */
    if (!preview || restoringNow.current || deletingNow.current) return;
    restoringNow.current = true;
    restorePhaseNow.current = 'waiting';
    setRestorePhase('waiting');
    setError('');
    setNotice('');
    const request = generation.current;
    const controller = new AbortController();
    restoreController.current = controller;
    try {
      const protectedCopy = await restoreProjectDraftWithProtection({
        locks: navigator.locks,
        storage: localStorage,
        current: binding,
        backup: preview.backup,
        expectedCurrent: preview.currentRaw,
        expectedProtection: preview.protection,
        replace,
        signal: controller.signal,
        /**
         * 记录恢复已进入不可随意打断的关键写入阶段，同时更新即时引用与渲染状态。
         * EN: Records entry into the critical recovery write phase in both the immediate ref and rendered state.
         */
        onCritical: () => {
          restorePhaseNow.current = 'critical';
          setRestorePhase('critical');
        },
        readCurrent: currentRaw,
        /**
         * 将已验证的恢复原文写入当前项目的看板缓存，持久化一致性由缓存层处理。
         * EN: Writes verified recovery text to the current project-board cache, delegating persistence consistency to the cache layer.
         */
        apply: (value) => cache.set(projectBoardKey(projectId), value),
        /**
         * 恢复写入前再次核对取消信号、页面代次和工作台作用域；变化时抛错保留当前原稿。
         * EN: Rechecks abort state, page generation, and workbench scope before recovery writes; a mismatch throws and preserves the current draft.
         */
        assertActive: () => {
          if (
            controller.signal.aborted ||
            request !== generation.current ||
            client.workbenchScope() !== binding.workbenchScope
          )
            throw Error('恢复页面或工作台范围已变化，未恢复草稿。请重新选择备份核对。');
        },
      });
      if (request !== generation.current) return;
      setProtectedRaw(protectedCopy);
      setPreview(undefined);
      setAcknowledged(false);
      setReplace(false);
      setDeleteConfirmed(false);
      setDownloadedProtection(null);
      restored();
      setNotice(
        '已替换本机工作台草稿，恢复前原稿已保留；等待工作台按当前缓存版本正常保存，请核对保存状态及旧引用。项目计划尚未保存，未执行任务。',
      );
    } catch (issue) {
      if (request === generation.current) {
        try {
          setProtectedRaw(readProtection());
        } catch {
          /**
           * 保留最后可见副本。
           * EN: Keep the last visible copy.
           */
        }
        if (controller.signal.aborted && restorePhaseNow.current === 'waiting') {
          setError('');
          setNotice('已取消本次恢复等待。原稿、预览和恢复前副本保留，可重新尝试。');
        } else setError(issue instanceof Error ? issue.message : '草稿恢复失败，当前原稿和预览已保留。');
      }
    } finally {
      restoringNow.current = false;
      if (restoreController.current === controller) {
        restoreController.current = undefined;
        restorePhaseNow.current = 'idle';
        setRestorePhase('idle');
      }
    }
  };
  /**
   * 只删除已另存、确认且仍为当前内容的保护副本；通过锁和作用域复核协调跨窗口竞争，并发布最终状态。
   * EN: Deletes only the current protection copy after export and confirmation, coordinating cross-window races through locking and scope checks before publishing the final state.
   */
  const deleteProtection = async () => {
    /**
     * 仅允许删除已另存并确认的当前副本，其他状态不发起删除。
     * EN: Delete only the current separately-saved and confirmed copy; other states issue no deletion.
     */
    if (
      protectedRaw === null ||
      deletingNow.current ||
      restoringNow.current ||
      !deleteConfirmed ||
      downloadedProtection !== protectedRaw
    )
      return;
    const expected = protectedRaw,
      request = generation.current,
      controller = new AbortController();
    deletingNow.current = true;
    deletePhaseNow.current = 'waiting';
    deleteController.current = controller;
    setDeletePhase('waiting');
    setError('');
    setNotice('');
    try {
      await deleteProjectDraftProtection({
        locks: navigator.locks,
        storage: localStorage,
        current: binding,
        expectedProtection: expected,
        signal: controller.signal,
        /**
         * 将保护副本删除标记为关键阶段，并同步引用与界面状态，避免中途导航误报可取消。
         * EN: Marks protection-copy deletion as critical in both ref and UI state so navigation does not misrepresent it as freely cancellable.
         */
        onCritical: () => {
          deletePhaseNow.current = 'critical';
          setDeletePhase('critical');
        },
        /**
         * 删除前确认请求未取消、页面代次和工作台绑定仍有效；不匹配时中止且不删除副本。
         * EN: Checks cancellation, page generation, and workbench binding before deletion; mismatches stop the operation without deleting the copy.
         */
        assertActive: () => {
          if (
            controller.signal.aborted ||
            request !== generation.current ||
            client.workbenchScope() !== binding.workbenchScope
          )
            throw Error('副本管理页面或工作台范围已变化，未删除副本。');
        },
      });
      if (request !== generation.current) return;
      setProtectedRaw(null);
      setDownloadedProtection(null);
      setDeleteConfirmed(false);
      setAcknowledged(false);
      setReplace(false);
      setNotice('已删除当前项目在此浏览器中的恢复前副本。当前草稿、恢复预览和其他副本未改动。');
    } catch (issue) {
      if (request === generation.current) {
        try {
          setProtectedRaw(readProtection());
        } catch {
          /**
           * 保留最后可见副本。
           * EN: Keep the last visible copy.
           */
        }
        if (controller.signal.aborted && deletePhaseNow.current === 'waiting') {
          setError('');
          setNotice('已取消本次副本删除等待，未执行本次删除。当前原稿和预览保留，可重新尝试。');
        } else {
          setDownloadedProtection(null);
          setDeleteConfirmed(false);
          setError(
            issue instanceof Error ? issue.message : '副本删除失败，请重新核对。当前草稿和预览未改动。',
          );
        }
      }
    } finally {
      deletingNow.current = false;
      if (deleteController.current === controller) {
        deleteController.current = undefined;
        deletePhaseNow.current = 'idle';
        setDeletePhase('idle');
      }
    }
  };
  return (
    <section className="project-draft-backup" aria-label="工作台草稿备份与恢复">
      <div className="project-actions">
        <button
          type="button"
          className="secondary"
          aria-expanded={open}
          disabled={restoring || deleting}
          onClick={() => {
            if (open) {
              generation.current++;
              restoreController.current?.abort();
              setReading(false);
              setPreview(undefined);
              setAcknowledged(false);
              setReplace(false);
              setDownloadedProtection(null);
              setDeleteConfirmed(false);
            }
            setOpen((value) => !value);
          }}
        >
          工作台草稿备份与恢复
        </button>
      </div>
      {open && (
        <>
          <p className="field-help">
            绑定备份 JSON
            仅在同项目、同入口和同工作台数据范围恢复本地草稿，不执行任务、不更新已保存的项目计划。TXT
            原稿仅供查看；跨项目复用请使用计划 JSON。
          </p>
          <div className="project-actions">
            <button
              type="button"
              className="secondary"
              disabled={!scope}
              onClick={() =>
                attempt(() => {
                  download(createProjectDraftBackup(currentRaw(), binding).raw, backupName('backup'));
                  setNotice('已发起绑定备份 JSON 下载，请保留文件以便以后恢复。');
                })
              }
            >
              导出绑定备份 JSON
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || !scope}
              onClick={() => fileInput.current?.click()}
            >
              选择备份 JSON 恢复
            </button>
            <input
              ref={fileInput}
              type="file"
              className="project-draft-backup-file"
              accept=".json,application/json"
              aria-label="选择工作台备份 JSON 文件"
              disabled={busy || !scope}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void read(file);
              }}
            />
          </div>
          {protectedRaw !== null && protectionInfo && (
            <section
              className="project-draft-protection"
              aria-label="当前项目恢复前副本"
              data-readable={protectionInfo.readable}
            >
              <div className="project-draft-backup-heading">
                <h3>当前项目恢复前副本</h3>
                <span>{protectionInfo.readable ? '可预览' : '仅可另存原文'}</span>
              </div>
              <dl className="project-draft-backup-summary">
                <div>
                  <dt>副本时间</dt>
                  <dd>
                    {protectionInfo.createdAt ? (
                      <time dateTime={protectionInfo.createdAt} title={protectionInfo.createdAt}>
                        {new Date(protectionInfo.createdAt).toLocaleString('zh-CN')}
                      </time>
                    ) : (
                      '未知（副本无法读取）'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{protectionInfo.readable ? 'JSON' : '原文'} UTF-8 文件大小</dt>
                  <dd>
                    {protectionInfo.bytes.toLocaleString('zh-CN')} 字节（
                    {(protectionInfo.bytes / 1024).toFixed(1)} KiB）
                  </dd>
                </div>
              </dl>
              <p className="field-help">这是另存文件的大小，不表示浏览器剩余空间。</p>
              {!protectionInfo.readable && (
                <p className="field-help">
                  此副本格式或绑定无法读取。可先另存完整原文，再明确删除；不会尝试将损坏副本恢复为草稿。
                </p>
              )}
              <div className="project-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    attempt(() => {
                      download(
                        protectedRaw,
                        backupName('before-restore', protectionInfo.readable ? 'json' : 'txt'),
                        protectionInfo.readable
                          ? 'application/json;charset=utf-8'
                          : 'text/plain;charset=utf-8',
                      );
                      setDownloadedProtection(protectedRaw);
                      setDeleteConfirmed(false);
                      setNotice('已发起恢复前副本另存，请确认文件保存完成后再允许替换或删除。');
                    })
                  }
                >
                  {protectionInfo.readable ? '另存恢复前副本 JSON' : '另存恢复前副本原文'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !protectionInfo.readable}
                  onClick={() => attempt(() => prepare(readProjectDraftBackup(protectedRaw, binding)))}
                >
                  预览恢复前副本
                </button>
              </div>
              <div className="project-draft-delete-controls">
                <h4>删除本地恢复前副本</h4>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={deleteConfirmed}
                    disabled={busy || downloadedProtection !== protectedRaw}
                    onChange={(event) => setDeleteConfirmed(event.target.checked)}
                  />
                  <span>已确认另存文件保存完成，删除此浏览器中当前项目的恢复前副本。</span>
                </label>
                <button
                  type="button"
                  className="secondary danger"
                  disabled={busy || !deleteConfirmed || downloadedProtection !== protectedRaw}
                  onClick={() => void deleteProtection()}
                >
                  明确删除恢复前副本
                </button>
              </div>
            </section>
          )}
          <p className="field-help">
            恢复前原稿保存在当前浏览器同来源的本地备份中，每个项目保留一份。它不属于服务端或全量备份；跨端口或来源重开时请另存绑定
            JSON，再选择文件恢复。
          </p>
          {!scope && <p className="field-error">工作台数据范围尚未确认，备份和恢复暂不可用。</p>}
          {reading && <p role="status">正在读取工作台备份…</p>}
          {restorePhase === 'waiting' && (
            <div className="project-draft-restore-wait" role="status">
              <p>正在等待恢复操作，尚未开始替换草稿。</p>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (restorePhaseNow.current === 'waiting') restoreController.current?.abort();
                }}
              >
                取消本次恢复等待
              </button>
            </div>
          )}
          {restorePhase === 'critical' && <p role="status">正在核对并恢复草稿，本阶段不支持取消。</p>}
          {deletePhase === 'waiting' && (
            <div className="project-draft-restore-wait" role="status">
              <p>正在等待副本删除操作，尚未开始删除。</p>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (deletePhaseNow.current === 'waiting') deleteController.current?.abort();
                }}
              >
                取消本次副本删除等待
              </button>
            </div>
          )}
          {deletePhase === 'critical' && <p role="status">正在核对并删除恢复前副本，本阶段不支持取消。</p>}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {preview && (
            <section className="project-draft-backup-preview" aria-label="工作台备份恢复预览">
              <h3>工作台备份恢复预览</h3>
              <dl className="project-draft-backup-summary">
                <div>
                  <dt>备份时间</dt>
                  <dd>
                    <time dateTime={preview.backup.file.createdAt}>{preview.backup.file.createdAt}</time>
                  </dd>
                </div>
                <div>
                  <dt>原稿长度</dt>
                  <dd>{preview.backup.file.draftRaw.length.toLocaleString('zh-CN')} 字符</dd>
                </div>
              </dl>
              <ul className="project-draft-backup-inventory" aria-label="备份包含内容">
                <li>计划草稿 {preview.backup.draft.edit?.items.length ?? 0} 个交付项</li>
                <li>{preview.backup.draft.launch ? '包含创建任务草稿' : '无创建任务草稿'}</li>
                <li>{preview.backup.draft.manifest ? '包含交付清单草稿' : '无交付清单草稿'}</li>
                <li>{preview.backup.draft.planImportUndo ? '包含导入前原稿' : '无导入前原稿'}</li>
              </ul>
              <p className="field-help project-draft-backup-warning">
                恢复会替换整个本地工作台草稿，并取消未应用的计划导入预览。旧交付项、任务、清单引用与计划版本必须重新核对；备份中的旧版本不能授权保存当前项目。
              </p>
              <details className="project-draft-backup-content">
                <summary>查看全部草稿内容</summary>
                <pre tabIndex={0} role="region" aria-label="备份完整草稿原文">
                  {preview.backup.file.draftRaw || '（空草稿）'}
                </pre>
              </details>
              <div className="project-draft-restore-confirmation">
                <h4>确认恢复到本地草稿</h4>
                {!unchanged && (
                  <>
                    <p className="field-error" role="alert">
                      当前原稿或恢复前副本已变化，请重新核对。恢复预览保留，尚未覆盖任何输入。
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => attempt(() => prepare(preview.backup))}
                    >
                      重新核对当前原稿
                    </button>
                  </>
                )}
                {differentProtection && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={replace}
                      disabled={busy || downloadedProtection !== preview.protection}
                      onChange={(event) => setReplace(event.target.checked)}
                    />
                    <span>已另存现有恢复前副本，允许用当前原稿替换这份本地备份。</span>
                  </label>
                )}
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    disabled={busy || !unchanged || !protectionReady}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  <span>先完整保留当前原稿，再将此备份恢复为本地草稿；之后重新核对并显式保存。</span>
                </label>
                <div className="project-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !unchanged || !protectionReady || !acknowledged}
                    onClick={() => void restore()}
                  >
                    保留当前原稿并恢复草稿
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      generation.current++;
                      setReading(false);
                      setPreview(undefined);
                      setAcknowledged(false);
                      setReplace(false);
                      setNotice('已取消恢复预览，当前原稿未改动。');
                    }}
                  >
                    取消恢复 · 保留当前原稿
                  </button>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}
