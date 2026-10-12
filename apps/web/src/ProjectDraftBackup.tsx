import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkbenchCache } from './WorkbenchCache';
import { projectBoardKey } from './ProjectBoardDraft';
import { useSurfaceClient } from './SurfaceClientContext';
import {
  PROJECT_DRAFT_BACKUP_FILE_LIMIT,
  createProjectDraftBackup,
  decodeProjectDraftBackup,
  projectDraftProtectionKey,
  restoreProjectDraftWithProtection,
  readProjectDraftBackup,
  type ProjectDraftBackupBinding,
  type ProjectDraftBackupPreview,
} from './project-draft-backup';
import './project-draft-backup.css';

function download(raw: string, name: string) {
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
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
  const [restoring, setRestoring] = useState(false);
  const busy = externalBusy || restoring;
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
  const fileInput = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    restoringNow = useRef(false);
  const restoreController = useRef<AbortController | undefined>(undefined);
  const currentRaw = () => {
    const value = cache.get(projectBoardKey(projectId));
    if (value === undefined || value === '') return '';
    if (typeof value !== 'string') throw Error('当前工作台原稿无法读取，请先导出 TXT 核对。当前输入未改动。');
    return value;
  };
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
    try {
      setProtectedRaw(readProtection());
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : '当前浏览器的备份存储不可用。');
    }
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
    };
    window.addEventListener('storage', onStorage);
    return () => {
      generation.current++;
      restoreController.current?.abort();
      window.removeEventListener('storage', onStorage);
    };
  }, [ownerKey]);
  useEffect(() => {
    setAcknowledged(false);
    setReplace(false);
    setDownloadedProtection(null);
  }, [raw]);
  const prepare = (backup: ProjectDraftBackupPreview) => {
    const protection = readProtection();
    setProtectedRaw(protection);
    setPreview({ backup, currentRaw: currentRaw(), protection });
    setAcknowledged(false);
    setReplace(false);
    setDownloadedProtection(null);
    setNotice('');
    setError('');
    setOpen(true);
  };
  const read = async (file: File) => {
    restoreController.current?.abort();
    const request = ++generation.current;
    setReading(true);
    setError('');
    setNotice('');
    setPreview(undefined);
    setAcknowledged(false);
    setReplace(false);
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
    /* The explicit restore handler reports the unreadable current draft. */
  }
  let differentProtection = !!preview?.protection;
  if (preview?.protection) {
    try {
      differentProtection =
        readProjectDraftBackup(preview.protection, binding).file.draftRaw !== preview.currentRaw;
    } catch {
      differentProtection = true;
    }
  }
  const protectionReady = !differentProtection || (replace && downloadedProtection === preview?.protection);
  const backupName = (kind: string) => `elysia-workbench-${kind}-${projectId}-${crypto.randomUUID()}.json`;
  const attempt = (action: () => void) => {
    try {
      action();
      setError('');
    } catch (issue) {
      try {
        setProtectedRaw(readProtection());
      } catch {
        /* Keep the last visible copy. */
      }
      setError(issue instanceof Error ? issue.message : '备份操作失败，当前原稿未改动。');
    }
  };
  const restore = async () => {
    if (!preview || restoringNow.current) return;
    restoringNow.current = true;
    setRestoring(true);
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
        readCurrent: currentRaw,
        apply: (value) => cache.set(projectBoardKey(projectId), value),
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
      restored();
      setNotice(
        '已替换本机工作台草稿，恢复前原稿已保留；等待工作台按当前缓存版本正常保存，请核对保存状态及旧引用。项目计划尚未保存，未执行任务。',
      );
    } catch (issue) {
      if (request === generation.current) {
        try {
          setProtectedRaw(readProtection());
        } catch {
          /* Keep the last visible copy. */
        }
        setError(issue instanceof Error ? issue.message : '草稿恢复失败，当前原稿和预览已保留。');
      }
    } finally {
      restoringNow.current = false;
      if (restoreController.current === controller) {
        restoreController.current = undefined;
        setRestoring(false);
      }
    }
  };
  return (
    <section className="project-draft-backup" aria-label="工作台草稿备份与恢复">
      <div className="project-actions">
        <button
          type="button"
          className="secondary"
          disabled={restoring}
          onClick={() => {
            if (open) {
              generation.current++;
              restoreController.current?.abort();
              setReading(false);
              setPreview(undefined);
              setAcknowledged(false);
              setReplace(false);
              setDownloadedProtection(null);
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
            {protectedRaw && (
              <>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    attempt(() => {
                      download(protectedRaw, backupName('before-restore'));
                      setDownloadedProtection(protectedRaw);
                      setNotice('已发起恢复前副本下载，请确认文件已另存后再允许替换。');
                    })
                  }
                >
                  另存恢复前副本 JSON
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => attempt(() => prepare(readProjectDraftBackup(protectedRaw, binding)))}
                >
                  预览恢复前副本
                </button>
              </>
            )}
          </div>
          <p className="field-help">
            恢复前原稿保存在当前浏览器同来源的本地备份中，每个项目保留一份。它不属于服务端或全量备份；跨端口或来源重开时请另存绑定
            JSON，再选择文件恢复。
          </p>
          {!scope && <p className="field-error">工作台数据范围尚未确认，备份和恢复暂不可用。</p>}
          {reading && <p role="status">正在读取工作台备份…</p>}
          {restoring && <p role="status">正在核对并保留恢复前原稿…</p>}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {preview && (
            <section className="project-draft-backup-preview" aria-label="工作台备份恢复预览">
              <h3>工作台备份恢复预览</h3>
              <p>
                备份时间 {preview.backup.file.createdAt}；原稿{' '}
                {preview.backup.file.draftRaw.length.toLocaleString('zh-CN')} 字符。
              </p>
              <p>
                计划草稿 {preview.backup.draft.edit?.items.length ?? 0} 个交付项；
                {preview.backup.draft.launch ? '包含创建任务草稿' : '无创建任务草稿'}；
                {preview.backup.draft.manifest ? '包含交付清单草稿' : '无交付清单草稿'}；
                {preview.backup.draft.planImportUndo ? '包含导入前原稿' : '无导入前原稿'}。
              </p>
              <p className="field-help">
                恢复会替换整个本地工作台草稿，并取消未应用的计划导入预览。旧交付项、任务、清单引用与计划版本必须重新核对；备份中的旧版本不能授权保存当前项目。
              </p>
              <details>
                <summary>查看全部草稿内容</summary>
                <pre>{preview.backup.file.draftRaw || '（空草稿）'}</pre>
              </details>
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
            </section>
          )}
        </>
      )}
    </section>
  );
}
