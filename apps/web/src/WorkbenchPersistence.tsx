import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import type { WorkbenchCache, WorkbenchSnapshot, WorkbenchInspection } from './WorkbenchCache';
import './workbench-persistence.css';

function downloadText(value: string, name: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const originalText = (value: string | boolean) => (typeof value === 'string' ? value : String(value));
const readableText = (value: string | boolean) => {
  if (typeof value === 'boolean') return value ? '已启用' : '已关闭';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

export function workbenchEntryLabel(
  key: string,
  projects: { id: string; name: string }[],
  runs: { id: string; title: string }[],
) {
  const kinds = [
    ['draft:project-board:', '项目交付工作台', 'project'],
    ['draft:setup:project:', '项目任务创建配置', 'project'],
    ['draft:project:', '项目输入', 'project'],
    ['draft:run:', '会话输入', 'run'],
    ['draft:handoff:', '交接与修订', 'run'],
    ['draft:delivery-review:', '交付复核', 'run'],
    ['draft:source-resolutions:', '来源意见复验', 'run'],
    ['draft:terminal-continuation:', '终端续接', 'run'],
    ['draft:terminal-communication:', '终端协作消息', 'run'],
    ['draft:terminal-resolution:', '终端消息处置', 'run'],
    ['draft:terminal-send:', '终端发送确认', 'run'],
    ['draft:terminal-recovery:', '终端恢复', 'run'],
  ];
  for (const [prefix, label, owner] of kinds) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length).split(':')[0];
    const title =
      owner === 'project'
        ? projects.find((item) => item.id === id)?.name
        : runs.find((item) => item.id === id)?.title;
    return `${label} · ${title || id.slice(0, 8)}`;
  }
  if (key === 'draft:chat') return '独立对话输入';
  if (key === 'draft:setup:chat') return '独立对话创建配置';
  if (key.startsWith('settings:')) return '终端选择偏好';
  if (key.startsWith('collapsed:')) return '侧栏展开偏好';
  if (key.startsWith('pinned:')) return '会话置顶偏好';
  if (key.startsWith('unread:')) return '会话未读状态';
  return '草稿与偏好';
}

export function WorkbenchSaveStatus({ snapshot, open }: { snapshot: WorkbenchSnapshot; open: () => void }) {
  const pending = snapshot.pendingKeys.length;
  return (
    <div className="cache-state" role="status" data-state={snapshot.status}>
      <span>
        {snapshot.status === 'loading'
          ? '正在读取草稿与偏好…'
          : snapshot.readError
            ? '草稿读取失败，请核对'
            : snapshot.issues.length
              ? `${snapshot.issues.length} 项保存问题待处理`
              : pending
                ? '正在保存草稿与偏好…'
                : '草稿与偏好已保存到本机服务'}
      </span>
      {pending > 0 && (
        <span className="cache-protection-state">
          {snapshot.recovery.status === 'verified'
            ? '浏览器恢复副本已核验'
            : '未保存内容仅保留在当前窗口内存'}
        </span>
      )}
      <button type="button" onClick={open}>
        草稿保存与恢复
      </button>
    </div>
  );
}

export function WorkbenchPersistence({
  cache,
  snapshot,
  labelFor,
  onAdoptRemote,
  close,
}: {
  cache: WorkbenchCache;
  snapshot: WorkbenchSnapshot;
  labelFor: (key: string) => string;
  onAdoptRemote: (key: string) => void;
  close: () => void;
}) {
  const [inspection, setInspection] = useState<WorkbenchInspection>();
  const [choice, setChoice] = useState<'local' | 'remote'>('local');
  const [confirmed, setConfirmed] = useState(false);
  const [downloaded, setDownloaded] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(0);
  const inspectionSection = useRef<HTMLElement>(null);
  const request = useRef(0),
    working = useRef(false);
  useEffect(() => {
    working.current = false;
    setBusy('');
    setInspection(undefined);
    setConfirmed(false);
    return () => {
      request.current++;
      working.current = false;
    };
  }, []);
  useEffect(() => {
    if (!inspection) return;
    inspectionSection.current?.scrollIntoView({ block: 'nearest' });
    inspectionSection.current?.focus({ preventScroll: true });
  }, [inspection?.token]);
  const run = async (label: string, action: () => Promise<void> | void) => {
    if (working.current) return;
    working.current = true;
    const current = ++request.current;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (issue) {
      if (request.current === current)
        setError(issue instanceof Error ? issue.message : '本次草稿处理失败，请重新核对。');
    } finally {
      if (request.current === current) {
        working.current = false;
        setBusy('');
      }
    }
  };
  const inspect = (key: string) =>
    run(key, async () => {
      const current = request.current;
      setInspection(undefined);
      const value = await cache.inspectIssue(key);
      if (request.current !== current) return;
      setInspection(value);
      setChoice('local');
      setConfirmed(false);
      setDownloaded('');
    });
  const resolve = () => {
    if (!inspection || !confirmed || (choice === 'remote' && downloaded !== inspection.token)) return;
    const value = inspection;
    void run(value.key, async () => {
      const current = request.current;
      try {
        await cache.resolveIssue(value.key, value.token, choice);
        if (choice === 'remote') onAdoptRemote(value.key);
        if (request.current === current)
          setNotice(
            choice === 'local'
              ? '已保存所选草稿。其他待处理项保持。'
              : '已采用所选服务端内容。另存的原稿可供核对。',
          );
      } finally {
        if (request.current === current) {
          setInspection(undefined);
          setConfirmed(false);
        }
      }
    });
  };
  const exportOne = (key: string, value: string | boolean) => {
    downloadText(originalText(value), `Elysia-草稿原稿-${key.replace(/[^a-zA-Z0-9-]/g, '_')}.txt`);
  };
  const pending = snapshot.pendingKeys.length;
  const lastPage = Math.max(0, Math.ceil(snapshot.issues.length / 10) - 1);
  const actualPage = Math.min(page, lastPage);
  const shownIssues = snapshot.issues.slice(actualPage * 10, actualPage * 10 + 10);
  const changed =
    inspection &&
    (snapshot.entries[inspection.key]?.value !== inspection.local.value ||
      snapshot.entries[inspection.key]?.revision !== inspection.local.revision ||
      !snapshot.issues.some((issue) => issue.key === inspection.key));
  return (
    <Modal title="草稿保存与恢复" close={close} wide busy={!!busy}>
      <div className="form-body workbench-persistence">
        <section aria-label="草稿保护状态">
          <h3>保存与恢复保护</h3>
          <p>
            {pending
              ? `${pending} 项内容尚未确认保存到本机服务。`
              : snapshot.readError || snapshot.status === 'loading'
                ? '本机服务保存状态尚未完成核对。'
                : '草稿与偏好已保存到本机服务。'}
          </p>
          {pending > 0 && (
            <p
              className={snapshot.recovery.status === 'verified' ? 'field-help' : 'field-error'}
              role="status"
            >
              {snapshot.recovery.status === 'verified'
                ? '浏览器恢复副本已核验。'
                : '未保存内容仅保留在当前窗口内存。'}{' '}
              {snapshot.recovery.message}
            </p>
          )}
          <div className="workbench-persistence-actions">
            <button
              type="button"
              className="secondary"
              disabled={!pending || !!busy}
              onClick={() =>
                void run('export', () => {
                  downloadText(
                    JSON.stringify(cache.exportPending(), null, 2),
                    'Elysia-未保存原稿.json',
                    'application/json;charset=utf-8',
                  );
                  setNotice('已发起未保存原稿下载，请确认文件保存完成。');
                })
              }
            >
              导出未保存原稿
            </button>
            {pending > 0 && snapshot.recovery.status !== 'verified' && (
              <button
                type="button"
                className="secondary"
                disabled={!!busy}
                onClick={() => void run('protection', () => cache.retryRecovery())}
              >
                重试恢复保护
              </button>
            )}
          </div>
          <p className="field-help">
            浏览器副本用于当前窗口的未保存内容恢复；另存文件可保留完整原稿供人工核对。
          </p>
        </section>
        {snapshot.readError && (
          <section aria-label="草稿读取问题">
            <p className="field-error" role="alert">
              {snapshot.readError}
            </p>
            <button
              type="button"
              className="secondary"
              disabled={!!busy}
              onClick={() => void run('read', () => cache.retryReads())}
            >
              重试草稿读取
            </button>
          </section>
        )}
        <section aria-label="逐项保存问题">
          <h3>逐项处理 · {snapshot.issues.length}</h3>
          {!snapshot.issues.length && <p className="field-help">当前没有需要处理的保存问题。</p>}
          {shownIssues.map((issue) => (
            <article className="workbench-save-issue" key={issue.key}>
              <h4>{labelFor(issue.key)}</h4>
              <p>{issue.message}</p>
              <div className="workbench-persistence-actions">
                {issue.kind === 'conflict' ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => void inspect(issue.key)}
                  >
                    核对此项
                  </button>
                ) : (
                  issue.retryable && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={!!busy}
                      onClick={() => void run(issue.key, () => cache.retry(issue.key))}
                    >
                      重试此项
                    </button>
                  )
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={!!busy || !snapshot.entries[issue.key]}
                  onClick={() =>
                    void run('export', () => exportOne(issue.key, snapshot.entries[issue.key].value))
                  }
                >
                  导出此项原稿
                </button>
              </div>
            </article>
          ))}
          {lastPage > 0 && (
            <div className="workbench-persistence-actions" aria-label="保存问题分页">
              <button
                type="button"
                className="secondary"
                disabled={actualPage === 0 || !!busy}
                onClick={() => setPage(actualPage - 1)}
              >
                上一页
              </button>
              <span>
                第 {actualPage + 1} / {lastPage + 1} 页
              </span>
              <button
                type="button"
                className="secondary"
                disabled={actualPage === lastPage || !!busy}
                onClick={() => setPage(actualPage + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </section>
        {inspection && (
          <section
            ref={inspectionSection}
            tabIndex={-1}
            className="workbench-inspection"
            aria-label="草稿内容核对"
          >
            <h3>核对：{labelFor(inspection.key)}</h3>
            <div className="workbench-inspection-columns">
              <label>
                当前窗口内容
                <textarea readOnly value={readableText(inspection.local.value)} rows={12} />
              </label>
              <label>
                服务端内容
                <textarea
                  readOnly
                  value={
                    inspection.remote ? readableText(inspection.remote.value) : '服务端没有可采用的内容。'
                  }
                  rows={12}
                />
              </label>
            </div>
            {changed && (
              <p className="field-error" role="alert">
                草稿已变化，本次核对已失效。请取消后重新核对。
              </p>
            )}
            <fieldset disabled={!!busy || !!changed}>
              <legend>仅处理当前这一项</legend>
              <label className="workbench-choice">
                <input
                  type="radio"
                  name="workbench-resolution"
                  checked={choice === 'local'}
                  onChange={() => {
                    setChoice('local');
                    setConfirmed(false);
                  }}
                />
                保存当前窗口内容
              </label>
              <label className="workbench-choice">
                <input
                  type="radio"
                  name="workbench-resolution"
                  checked={choice === 'remote'}
                  disabled={!inspection.remote}
                  onChange={() => {
                    setChoice('remote');
                    setConfirmed(false);
                  }}
                />
                采用服务端内容
              </label>
              {choice === 'remote' && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void run('export', () => {
                      exportOne(inspection.key, inspection.local.value);
                      setDownloaded(inspection.token);
                    })
                  }
                >
                  导出核对中的原稿
                </button>
              )}
              <label className="workbench-choice">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={choice === 'remote' && downloaded !== inspection.token}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {choice === 'local'
                  ? '已核对两份内容，确认保存当前窗口内容。'
                  : '已确认原稿另存完成，并采用服务端内容。'}
              </label>
            </fieldset>
            <div className="workbench-persistence-actions">
              <button
                type="button"
                className="secondary"
                disabled={!!busy}
                onClick={() => {
                  setInspection(undefined);
                  setConfirmed(false);
                  setError('');
                }}
              >
                取消核对
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  !!busy ||
                  !!changed ||
                  !confirmed ||
                  (choice === 'remote' && (!inspection.remote || downloaded !== inspection.token))
                }
                onClick={resolve}
              >
                {choice === 'local' ? '核对后保存此草稿' : '采用服务端内容'}
              </button>
            </div>
          </section>
        )}
        {busy && <p role="status">正在处理所选内容…</p>}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </Modal>
  );
}
