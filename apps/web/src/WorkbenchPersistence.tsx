/**
 * 展示和管理工作台草稿的保存状态。
 * EN: Displays and resolves workbench draft persistence issues.
 *
 * 围绕单个草稿展示本地与远端差异、导出及明确选择，实际版本竞争交给缓存层。界面确认绑定核对令牌，采用远端前必须另存当前原稿。
 * EN: Guide per-draft comparison, export, and explicit choice while the cache owns revision races. Confirmation binds to an inspection token, and adopting remote requires exporting the local original.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Modal } from './Modal';
import type { WorkbenchCache, WorkbenchSnapshot, WorkbenchInspection } from './WorkbenchCache';
import './workbench-persistence.css';

/**
 * 把完整文本封装为下载文件并触发浏览器保存，延迟释放临时 URL；导出过程不改变原草稿。
 * EN: Download complete text through a Blob URL and revoke the temporary URL after triggering the browser save, leaving the draft unchanged.
 */
function downloadText(value: string, name: string, type = 'text/plain;charset=utf-8') {
  /**
   * 本地导出保留完整原稿；临时下载 URL 在触发后释放。
   * EN: Local export retains complete originals; revoke temporary URL after download trigger.
   */
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 保留字符串原文，布尔值转换为文本，用于可恢复原稿导出，避免展示格式改变内容。
 * EN: Preserve string originals and stringify booleans for draft export without applying display formatting.
 */
const originalText = (value: string | boolean) => (typeof value === 'string' ? value : String(value));
/**
 * 为核对界面生成可读值：布尔值显示状态，合法 JSON 缩进展示，普通文本保持原样。
 * EN: Produce inspection display text: readable boolean states, indented valid JSON, or the unchanged plain string.
 */
const readableText = (value: string | boolean) => {
  if (typeof value === 'boolean') return value ? '已启用' : '已关闭';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

/**
 * 根据草稿键前缀识别用途及所属项目/会话，并解析名称；名称未加载时回退到短标识，保留可辨认的归属。
 * EN: Resolve a draft key to its purpose and project/run name, falling back to a short identifier when the owner name is unavailable.
 */
export function workbenchEntryLabel(
  key: string,
  projects: { id: string; name: string }[],
  runs: { id: string; title: string }[],
) {
  const kinds = [
    ['draft:project-intelligence:', '项目能力与记忆', 'project'],
    ['draft:project-schedules:', '项目定时任务', 'project'],
    ['draft:working-state:', '长任务工作状态', 'run'],
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
    ['draft:terminal-send:', '消息发送确认', 'run'],
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

/**
 * 呈现同步状态、待保存数及浏览器恢复保护状态，并提供逐项恢复入口。读取失败和待处理问题优先显示，避免误报已保存。
 * EN: Render synchronization, pending edits, and browser-recovery protection with access to item-level recovery; failures and issues take display precedence.
 */
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

/**
 * 展示逐项保存问题并引导人工选择本地/服务端内容。inspect 返回的 token 固定核对快照，
 * 本地值或问题状态变化就使确认失效；采用远端前要求另存原稿并显式确认。
 * 每次只解决一个键，其他待保存项保留，实际版本检查和写入由 WorkbenchCache 完成。
 * EN: Guide local/server conflict choices per key. inspect tokens freeze review snapshots; edits/issues invalidate confirmation. Adopting remote requires exported original and explicit confirmation. Resolve one key at a time; cache handles actual version checks/writes.
 */
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
  const issueTitlePrefix = useId();
  const [inspection, setInspection] = useState<WorkbenchInspection>();
  const [choice, setChoice] = useState<'local' | 'remote'>('local');
  const [confirmed, setConfirmed] = useState(false);
  const [downloaded, setDownloaded] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(0);
  const inspectionSection = useRef<HTMLElement>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
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
  useEffect(() => {
    if (!error) return;
    errorMessage.current?.scrollIntoView({ block: 'nearest' });
    errorMessage.current?.focus({ preventScroll: true });
  }, [error]);
  /**
   * 串行化核对、保存和导出动作，用请求序号屏蔽弹窗卸载后的错误与忙碌回写。
   * EN: Serialize inspect/save/export and use sequence to suppress errors/busy updates after dialog unmount.
   */
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
  /**
   * 启动单项冲突核对并重置选择、确认及导出凭据；仅当前请求仍有效时接收结果，避免关闭弹窗后回写旧核对。
   * EN: Start inspection for one conflict and reset choice, consent, and export proof; accept results only while the request remains current.
   */
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
  /**
   * 只有当前 token 已确认且满足原稿另存门禁时才提交选择，结束后清除该次核对界面。
   * EN: Apply only a confirmed current token satisfying original-export gates, then clear that inspection UI.
   */
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
  /**
   * 导出单项的完整原文，并净化草稿键形成下载文件名；不会清除该项或改变保存状态。
   * EN: Export one complete original, sanitizing its key for the filename without clearing the entry or changing its save state.
   */
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
    <Modal title="草稿保存与恢复" close={close} wide busy={!!busy} className="workbench-persistence-modal">
      <div className="form-body workbench-persistence">
        <section aria-label="草稿保护状态">
          <h3>保存与恢复保护</h3>
          <dl className="workbench-persistence-summary" aria-label="当前窗口草稿范围">
            <div>
              <dt>当前窗口已读</dt>
              <dd>{Object.keys(snapshot.entries).length} 项草稿与偏好</dd>
            </div>
            <div>
              <dt>尚未确认保存</dt>
              <dd>{pending} 项</dd>
            </div>
            <div>
              <dt>需要逐项处理</dt>
              <dd>{snapshot.issues.length} 项</dd>
            </div>
          </dl>
          <p>
            {pending
              ? `${pending} 项内容尚未确认保存到本机服务。`
              : snapshot.readError || snapshot.status === 'loading'
                ? '本机服务保存状态尚未完成核对。'
                : '草稿与偏好已保存到本机服务。'}
          </p>
          {pending > 0 && (
            <p
              className={
                'workbench-persistence-reading ' +
                (snapshot.recovery.status === 'verified' ? 'field-help' : 'field-error')
              }
              role="status"
              aria-label="当前窗口恢复保护完整说明"
              tabIndex={0}
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
            <p
              className="field-error workbench-persistence-reading"
              role="alert"
              aria-label="草稿读取问题全文"
              tabIndex={0}
            >
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
          {snapshot.issues.length > 0 && (
            <p className="field-help">本页显示 {shownIssues.length} 项；仅处理明确选择的单项内容。</p>
          )}
          {!snapshot.issues.length && <p className="field-help">当前没有需要处理的保存问题。</p>}
          {shownIssues.map((issue, index) => (
            <article className="workbench-save-issue" key={issue.key}>
              <h4
                id={`${issueTitlePrefix}-${actualPage}-${index}`}
                className="workbench-persistence-reading"
                tabIndex={0}
              >
                {labelFor(issue.key)}
              </h4>
              <p
                className="workbench-persistence-reading"
                role="region"
                aria-label={`${labelFor(issue.key)}保存问题全文`}
                tabIndex={0}
              >
                {issue.message}
              </p>
              <details className="workbench-persistence-source">
                <summary>完整条目标识与依据版本</summary>
                <dl
                  className="workbench-persistence-reading"
                  role="region"
                  tabIndex={0}
                  aria-label={`${labelFor(issue.key)}完整草稿标识`}
                >
                  <div>
                    <dt>条目标识</dt>
                    <dd>{issue.key}</dd>
                  </div>
                  <div>
                    <dt>当前窗口依据版本</dt>
                    <dd>{snapshot.entries[issue.key]?.revision ?? '尚未读取条目'}</dd>
                  </div>
                </dl>
              </details>
              <div className="workbench-persistence-actions">
                {issue.kind === 'conflict' ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={!!busy}
                    aria-describedby={`${issueTitlePrefix}-${actualPage}-${index}`}
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
                      aria-describedby={`${issueTitlePrefix}-${actualPage}-${index}`}
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
                  aria-describedby={`${issueTitlePrefix}-${actualPage}-${index}`}
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
            <nav className="workbench-persistence-pagination" aria-label="保存问题分页">
              <span>
                第 {actualPage + 1} / {lastPage + 1} 页
              </span>
              <div className="workbench-persistence-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={actualPage === 0 || !!busy}
                  onClick={() => setPage(actualPage - 1)}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={actualPage === lastPage || !!busy}
                  onClick={() => setPage(actualPage + 1)}
                >
                  下一页
                </button>
              </div>
            </nav>
          )}
        </section>
        {inspection && (
          <section
            ref={inspectionSection}
            tabIndex={-1}
            className="workbench-inspection"
            aria-label="草稿内容核对"
          >
            <h3>核对单项草稿</h3>
            <p
              className="workbench-persistence-reading"
              role="region"
              tabIndex={0}
              aria-label="本次核对草稿完整名称"
            >
              {labelFor(inspection.key)}
            </p>
            <p className="field-help" role="status">
              {busy === inspection.key
                ? '正在处理本次选择，保存结果尚未确认。'
                : changed
                  ? '本次核对已失效，当前窗口原稿仍保留。'
                  : '本次核对尚未处理；选择保存方向不等于已保存或已采用。'}
            </p>
            <details className="workbench-persistence-source">
              <summary>本次核对的条目、版本与标识</summary>
              <dl
                className="workbench-persistence-reading"
                role="region"
                tabIndex={0}
                aria-label="本次草稿核对完整依据"
              >
                <div>
                  <dt>条目标识</dt>
                  <dd>{inspection.key}</dd>
                </div>
                <div>
                  <dt>当前窗口依据版本</dt>
                  <dd>{inspection.local.revision}</dd>
                </div>
                <div>
                  <dt>本次读回服务端版本</dt>
                  <dd>{inspection.remote?.revision ?? '没有可采用的内容'}</dd>
                </div>
                <div>
                  <dt>本次核对标识</dt>
                  <dd>{inspection.token}</dd>
                </div>
              </dl>
            </details>
            <div className="workbench-inspection-columns">
              <label>
                当前窗口内容
                <small>格式化阅读，导出保留存储原文。</small>
                <textarea readOnly value={readableText(inspection.local.value)} rows={12} />
              </label>
              <label>
                服务端内容
                <small>本次核对读回的内容，尚未采用。</small>
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
                <>
                  <p className="field-help">
                    {downloaded === inspection.token
                      ? '已发起本次原稿下载，请确认文件保存完成后再勾选。'
                      : '采用服务端内容前，须先导出本次核对的原稿并确认另存。'}
                  </p>
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
                </>
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
          <p
            ref={errorMessage}
            tabIndex={-1}
            className="field-error workbench-persistence-reading"
            role="alert"
            aria-label="草稿处理问题全文"
          >
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </Modal>
  );
}
