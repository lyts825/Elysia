import { useEffect, useRef, useState } from 'react';
import type { Project, ProjectSpace, RunListItem, RecordPage } from '../../../packages/contracts/src/index';
import { ApiError } from './api';
import { useSurfaceClient } from './SurfaceClientContext';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { ProjectArchiveDeleteNotice, type ProjectArchiveDeleteConsent } from './ProjectDeliveryArchive';

export function WorkspaceManager({
  spaces,
  projects,
  runs,
  initial = 'projects',
  close,
  updated,
  selectRun,
  listPage,
  listTrail,
  listBusy,
  listQuery,
  changeListQuery,
  listNavigate,
  projectCounts,
  changeListArchive,
}: {
  spaces: ProjectSpace[];
  projects: Project[];
  runs: RunListItem[];
  initial?: string;
  close: () => void;
  updated: (deleted?: {
    kind: 'project' | 'run' | 'space';
    id: string;
    runIds?: string[];
  }) => Promise<void | boolean>;
  selectRun: (run: RunListItem) => void;
  listPage?: RecordPage;
  listTrail?: boolean;
  listBusy?: boolean;
  listQuery?: string;
  changeListQuery?: (value: string) => void;
  listNavigate?: (direction: 'older' | 'newer' | 'latest') => void;
  projectCounts?: Record<string, number>;
  changeListArchive?: (archived: boolean) => void;
}) {
  const { mutation, surface } = useSurfaceClient();
  const [tab, setTab] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [name, setName] = useState(''),
    [search, setSearch] = useState(''),
    [edits, setEdits] = useState<Record<string, string>>({}),
    [targets, setTargets] = useState<Record<string, string>>({}),
    [confirmation, setConfirmation] = useState<{
      title: string;
      description: string;
      projectId?: string;
      action: (expectedArchiveSetHash?: string) => Promise<void>;
    } | null>(null);
  const [archiveConsent, setArchiveConsent] = useState<ProjectArchiveDeleteConsent>();
  const actionPending = useRef(false);
  useEffect(() => {
    changeListArchive?.(tab === 'archive');
  }, [tab, changeListArchive]);
  const searchValue = changeListQuery ? listQuery || '' : search;
  const projectCount = (id: string) => (projectCounts ? (projectCounts[id] ?? 0) : undefined);
  const perform = async (action: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      setConfirmation(null);
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'http' && e.status === 409 && e.code === 'REVISION_CONFLICT') {
        if (!confirmation?.projectId || surface !== 'native') setConfirmation(null);
        const conflict = '记录已更新，本次操作未执行。请核对列表后重新操作。';
        setError(conflict);
        try {
          if ((await updated()) === false)
            setError(conflict + '列表读取失败，请关闭此窗口，刷新会话列表后重新操作。');
        } catch (readError) {
          setError(
            conflict +
              '列表读取失败：' +
              (readError as Error).message +
              ' 请关闭此窗口，刷新会话列表后重新操作。',
          );
        }
      } else setError((e as Error).message);
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };
  const updateProject = (p: Project, changes: Record<string, unknown>) =>
    perform(async () => {
      await mutation('/projects/' + p.id, { expectedRevision: p.revision, ...changes }, 'PATCH');
      await updated();
    });
  const updateRun = (r: RunListItem, changes: Record<string, unknown>) =>
    perform(async () => {
      await mutation('/runs/' + r.id, { expectedRevision: r.revision, ...changes }, 'PATCH');
      await updated();
    });
  const filteredProjects = projects.filter(
    (p) => p.archived === (tab === 'archive') && p.name.toLowerCase().includes(searchValue.toLowerCase()),
  );
  const filteredRuns = runs.filter(
    (r) =>
      r.archived === (tab === 'archive') &&
      r.matchesQuery !== false &&
      (!!changeListQuery || `${r.title} ${r.objective}`.toLowerCase().includes(searchValue.toLowerCase())),
  );
  const projectRow = (p: Project) => (
    <div className="management-row" key={p.id}>
      <div className="management-info">
        <strong>
          <Icon name="folder" size={15} />
          {p.name}
        </strong>
        <small title={p.workspaceRoot}>{p.workspaceRoot}</small>
        <span>
          {projectCount(p.id) ?? '—'} 个对话 ·{' '}
          {spaces.find((s) => s.id === p.spaceId)?.name || '初始项目空间'}
        </span>
      </div>
      <div className="management-fields">
        <input
          aria-label={p.name + '的新名称'}
          maxLength={80}
          value={edits[p.id] ?? p.name}
          onChange={(e) => setEdits({ ...edits, [p.id]: e.target.value })}
          disabled={busy}
        />
        <button
          className="secondary"
          disabled={busy || !(edits[p.id] || '').trim() || edits[p.id] === p.name}
          onClick={() => void updateProject(p, { name: edits[p.id].trim() })}
        >
          改名
        </button>
        <select
          aria-label={p.name + '所属空间'}
          value={p.spaceId}
          disabled={busy}
          onChange={(e) => void updateProject(p, { spaceId: e.target.value })}
        >
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="management-actions">
        <button
          className="quiet-button"
          disabled={busy}
          onClick={() => void updateProject(p, { archived: !p.archived })}
        >
          {p.archived ? '恢复项目' : '归档项目'}
        </button>
        <button
          className="quiet-button danger"
          disabled={busy}
          onClick={() => {
            setArchiveConsent(undefined);
            setConfirmation({
              title: `删除项目「${p.name}」？`,
              description: `将永久删除此项目及其${projectCount(p.id) == null ? '关联对话' : ` ${projectCount(p.id)} 个对话`}、执行和产物登记数据，无法恢复。${surface === 'native' ? '项目交付计划、冻结清单和已保存文件包也会删除，请先导出需要保留的内容。' : ''}原始资料目录 ${p.workspaceRoot} 保留。`,
              projectId: surface === 'native' ? p.id : undefined,
              action: async (expectedArchiveSetHash) => {
                if (surface === 'native' && !expectedArchiveSetHash)
                  throw Error('请先读取已保存文件包，并明确确认需要保留或放弃的内容。');
                const result = await mutation<{ deletedRunIds: string[] }>(
                  '/projects/' + p.id,
                  {
                    expectedRevision: p.revision,
                    ...(expectedArchiveSetHash ? { expectedArchiveSetHash } : {}),
                  },
                  'DELETE',
                );
                await updated({ kind: 'project', id: p.id, runIds: result.deletedRunIds });
              },
            });
          }}
        >
          删除项目
        </button>
      </div>
    </div>
  );
  const runRow = (r: RunListItem) => (
    <div className="management-row" key={r.id}>
      <div className="management-info">
        <strong>
          <Icon name={r.kind === 'chat' ? 'chat' : 'tree'} size={15} />
          {r.title || r.objective}
        </strong>
        <span>
          {r.kind === 'chat'
            ? '独立对话 · 不绑定项目'
            : `项目：${projects.find((p) => p.id === r.projectId)?.name || '未知'}`}{' '}
          · {new Date(r.createdAt).toLocaleDateString('zh-CN')}
        </span>
        {r.kind === 'task' && projects.find((p) => p.id === r.projectId)?.archived && (
          <small>所属项目已归档，恢复项目后可继续任务。</small>
        )}
      </div>
      <div className="management-fields">
        <input
          aria-label={'对话 ' + (r.title || r.objective) + '的新名称'}
          maxLength={160}
          disabled={busy}
          value={edits[r.id] ?? r.title ?? r.objective}
          onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })}
        />
        <button
          className="secondary"
          disabled={busy || !(edits[r.id] || '').trim() || edits[r.id] === r.title}
          onClick={() => void updateRun(r, { title: edits[r.id].trim() })}
        >
          改名
        </button>
      </div>
      <div className="management-actions">
        <button
          className="quiet-button"
          disabled={busy}
          onClick={() => {
            selectRun(r);
            close();
          }}
        >
          打开
        </button>
        <button
          className="quiet-button"
          disabled={busy}
          onClick={() => void updateRun(r, { archived: !r.archived })}
        >
          {r.archived ? '恢复对话' : '归档对话'}
        </button>
        <button
          className="quiet-button danger"
          disabled={busy}
          onClick={() =>
            setConfirmation({
              title: `删除对话「${r.title || r.objective}」？`,
              description:
                '将永久删除这段对话及其任务、消息、调用和产物登记数据，无法恢复。项目的原始资料目录保留。',
              action: async () => {
                await mutation('/runs/' + r.id, { expectedRevision: r.revision }, 'DELETE');
                await updated({ kind: 'run', id: r.id });
              },
            })
          }
        >
          删除对话
        </button>
      </div>
    </div>
  );
  return (
    <Modal title="管理工作空间" subtitle="平级项目空间、项目归属和对话归档" close={close} wide busy={busy}>
      <div className="management-tabs" role="tablist" aria-label="管理类型">
        {[
          ['projects', '项目'],
          ['runs', '对话'],
          ['spaces', '项目空间'],
          ['archive', '归档'],
        ].map(([key, title]) => (
          <button
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'active' : ''}
            key={key}
            disabled={busy}
            onClick={() => {
              setTab(key);
              changeListArchive?.(key === 'archive');
              setConfirmation(null);
              if (changeListQuery) changeListQuery('');
              else setSearch('');
            }}
          >
            {title}
          </button>
        ))}
      </div>
      <div className="form-body management-body">
        {error && (
          <p className="inline-warning" role="alert">
            {error}
          </p>
        )}
        {confirmation ? (
          <div className="delete-confirmation" role="alert">
            <h3>{confirmation.title}</h3>
            <p>{confirmation.description}</p>
            {confirmation.projectId && (
              <ProjectArchiveDeleteNotice
                key={confirmation.projectId}
                projectId={confirmation.projectId}
                disabled={busy}
                onConsent={setArchiveConsent}
              />
            )}
            <div>
              <button className="secondary" disabled={busy} onClick={() => setConfirmation(null)}>
                保留
              </button>
              <button
                className="primary danger-confirm"
                disabled={
                  busy || (!!confirmation.projectId && archiveConsent?.projectId !== confirmation.projectId)
                }
                onClick={() =>
                  void perform(() =>
                    confirmation.action(
                      confirmation.projectId && archiveConsent?.projectId === confirmation.projectId
                        ? archiveConsent.setHash
                        : undefined,
                    ),
                  )
                }
              >
                {confirmation.title.startsWith('合并') ? '确认合并' : '确认永久删除'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {tab !== 'spaces' && (
              <input
                type="search"
                aria-label="搜索项目或对话"
                maxLength={200}
                placeholder="搜索名称或目标…"
                value={searchValue}
                onChange={(e) =>
                  changeListQuery ? changeListQuery(e.target.value) : setSearch(e.target.value)
                }
              />
            )}
            {tab === 'spaces' ? (
              <>
                <form
                  className="new-space-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform(async () => {
                      await mutation('/spaces', { name: name.trim() });
                      setName('');
                      await updated();
                    });
                  }}
                >
                  <input
                    aria-label="新空间名称"
                    placeholder="例如：研究、工作、个人"
                    value={name}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                  />
                  <button className="primary" disabled={busy || !name.trim()}>
                    <Icon name="plus" size={15} />
                    新建平级空间
                  </button>
                </form>
                {spaces.map((s) => (
                  <div key={s.id} className="management-row">
                    <div className="management-info">
                      <strong>
                        <Icon name="grid" size={15} />
                        {s.name}
                      </strong>
                      <span>
                        {projects.filter((p) => p.spaceId === s.id).length} 个项目
                        {s.protected ? ' · 初始空间，保留固定入口' : ' · 平级空间'}
                      </span>
                    </div>
                    {s.protected ? (
                      <p className="field-help">
                        初始空间不可改名、删除或作为合并来源，可接收其他空间的项目。
                      </p>
                    ) : (
                      <>
                        <div className="management-fields">
                          <input
                            aria-label={s.name + '的新名称'}
                            maxLength={80}
                            value={edits[s.id] ?? s.name}
                            disabled={busy}
                            onChange={(e) => setEdits({ ...edits, [s.id]: e.target.value })}
                          />
                          <button
                            className="secondary"
                            disabled={busy || !(edits[s.id] || '').trim() || edits[s.id] === s.name}
                            onClick={() =>
                              void perform(async () => {
                                await mutation(
                                  '/spaces/' + s.id,
                                  { expectedRevision: s.revision, name: edits[s.id].trim() },
                                  'PATCH',
                                );
                                await updated();
                              })
                            }
                          >
                            改名
                          </button>
                        </div>
                        <div className="management-fields">
                          <select
                            aria-label={s.name + '合并到的空间'}
                            value={targets[s.id] || spaces.find((other) => other.protected)?.id || ''}
                            disabled={busy}
                            onChange={(e) => setTargets({ ...targets, [s.id]: e.target.value })}
                          >
                            {spaces
                              .filter((other) => other.id !== s.id)
                              .map((other) => (
                                <option key={other.id} value={other.id}>
                                  {other.name}
                                </option>
                              ))}
                          </select>
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                              const targetId =
                                targets[s.id] || spaces.find((other) => other.protected)?.id || '';
                              const target = spaces.find((other) => other.id === targetId);
                              setConfirmation({
                                title: `合并「${s.name}」到「${target?.name}」？`,
                                description:
                                  '项目与对话都会保留，移入目标空间；来源空间将删除，无法恢复原空间划分。',
                                action: async () => {
                                  await mutation('/spaces/' + s.id + '/merge', {
                                    expectedRevision: s.revision,
                                    targetId,
                                  });
                                  await updated({ kind: 'space', id: s.id });
                                },
                              });
                            }}
                          >
                            合并空间
                          </button>
                          <button
                            className="quiet-button danger"
                            disabled={busy}
                            onClick={() =>
                              setConfirmation({
                                title: `删除空间「${s.name}」？`,
                                description:
                                  '其中项目将移到初始空间，项目和对话数据保留。此空间划分将永久删除。',
                                action: async () => {
                                  await mutation(
                                    '/spaces/' + s.id,
                                    { expectedRevision: s.revision },
                                    'DELETE',
                                  );
                                  await updated({ kind: 'space', id: s.id });
                                },
                              })
                            }
                          >
                            删除空间
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </>
            ) : (
              <>
                {(tab === 'projects' || tab === 'archive') && (
                  <>
                    <h3>{tab === 'archive' ? '已归档项目' : '项目'}</h3>
                    {filteredProjects.map(projectRow)}
                    {!filteredProjects.length && (
                      <p className="muted small">没有{tab === 'archive' ? '已归档' : '匹配'}项目。</p>
                    )}
                  </>
                )}
                {(tab === 'runs' || tab === 'archive') && (
                  <>
                    <h3>{tab === 'archive' ? '已归档对话' : '对话'}</h3>
                    {filteredRuns.map(runRow)}
                    {!filteredRuns.length && (
                      <p className="muted small">没有{tab === 'archive' ? '已归档' : '匹配'}对话。</p>
                    )}
                    {listPage && listNavigate && (
                      <nav className="session-pagination" aria-label="管理对话分页">
                        <span role="status">
                          {listBusy
                            ? '读取会话…'
                            : `本页 ${filteredRuns.length} / 共 ${listPage.total} 个会话`}
                        </span>
                        <div>
                          <button
                            disabled={busy || listBusy || !listTrail}
                            onClick={() => listNavigate('newer')}
                          >
                            更新会话
                          </button>
                          <button
                            disabled={busy || listBusy || !listPage.nextBefore}
                            onClick={() => listNavigate('older')}
                          >
                            更早会话
                          </button>
                          {listPage.before && (
                            <button disabled={busy || listBusy} onClick={() => listNavigate('latest')}>
                              返回最新
                            </button>
                          )}
                        </div>
                      </nav>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
      <footer className="modal-footer">
        <button className="primary" disabled={busy} onClick={close}>
          完成
        </button>
      </footer>
    </Modal>
  );
}
