import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Project } from '../../../packages/contracts/src/index';
import type {
  ProjectDeliveryBoard,
  ProjectDeliveryItem,
} from '../../../packages/contracts/src/project-delivery';
import type { WorkbenchCache } from './WorkbenchCache';
import {
  boardToEdit,
  itemLaunchContent,
  projectBoardKey,
  readProjectBoardDraft,
  writeProjectBoardDraft,
  type ProjectBoardDraft,
} from './ProjectBoardDraft';
import { ProjectBoardEditor, boardEditPayload } from './ProjectBoardEditor';
import { projectPlanImportDraft, projectPlanImportPreflight } from './project-plan-transfer';
import { ProjectBoardItem, readinessLabels } from './ProjectBoardItem';
import { ProjectRunList } from './ProjectRunList';
import { ProjectManifests } from './ProjectManifests';
import { ProjectTodos } from './ProjectTodos';
import { ProjectLaunchDraft } from './ProjectLaunchDraft';
import { ProjectUsage } from './ProjectUsage';
import { useSurfaceClient } from './SurfaceClientContext';
import { DeliveryReadProgress, prepareDeliveryRead, type DeliveryWarmProgress } from './DeliveryReadProgress';
import './project-workbench.css';

export function ProjectWorkbench({
  project,
  cache,
  raw,
  freeComposer,
  openRun,
  launch,
  openTaskCenter,
}: {
  project: Project;
  cache: WorkbenchCache;
  raw: unknown;
  freeComposer: ReactNode;
  openRun: (id: string, review?: boolean) => Promise<void>;
  launch: () => void;
  openTaskCenter: () => void;
}) {
  const { api, mutation } = useSurfaceClient();
  const [board, setBoard] = useState<ProjectDeliveryBoard>(),
    [error, setError] = useState(''),
    [draftError, setDraftError] = useState('');
  const [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0),
    [opening, setOpening] = useState(false);
  const live = useRef(true),
    writing = useRef(false);
  const readRequest = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<DeliveryWarmProgress>();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    void cache
      .ensureKey(projectBoardKey(project.id))
      .then(() => {
        if (active) {
          setLoaded(true);
          setDraftError('');
        }
      })
      .catch((issue) => {
        if (active) setDraftError(issue instanceof Error ? issue.message : '工作台草稿读取失败');
      });
    return () => {
      active = false;
    };
  }, [cache, project.id, retry]);
  useEffect(() => {
    const controller = new AbortController();
    readRequest.current = controller;
    let pending = false,
      firstRead = true;
    const read = async () => {
      if (pending || writing.current || controller.signal.aborted) return;
      pending = true;
      let visible = firstRead;
      firstRead = false;
      if (visible) {
        setLoading(true);
        setProgress(undefined);
      }
      try {
        await prepareDeliveryRead(api, { kind: 'project', id: project.id }, controller.signal, (next) => {
          if (!controller.signal.aborted && (visible || next.status === 'warming')) {
            visible = true;
            setLoading(true);
            setProgress(next);
          }
        });
        const result = await api<ProjectDeliveryBoard>(
          `/projects/${project.id}/delivery-board`,
          undefined,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted && result.projectId === project.id) {
          setBoard(result);
          setError('');
        }
      } catch (issue) {
        if (!controller.signal.aborted)
          setError(issue instanceof Error ? issue.message : '项目交付计划读取失败');
      } finally {
        pending = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          setProgress(undefined);
        }
      }
    };
    void read();
    const timer = setInterval(() => void read(), 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, project.id, retry]);
  let draft: ProjectBoardDraft | undefined;
  let parseError = '';
  try {
    if (loaded) draft = readProjectBoardDraft(raw);
  } catch (issue) {
    parseError = issue instanceof Error ? issue.message : '草稿无法读取';
  }
  const activeTab = draft?.usageOpen ? 'usage' : draft?.tab;
  const change = (update: (value: ProjectBoardDraft) => ProjectBoardDraft) => {
    try {
      writeProjectBoardDraft(cache, project.id, update);
      setDraftError('');
      return true;
    } catch (issue) {
      setDraftError(issue instanceof Error ? issue.message : '保存草稿失败');
      return false;
    }
  };
  const action = async (path: string, body: Record<string, unknown>, method = 'POST') => {
    if (!board || writing.current || board.archived || !live.current) return false;
    writing.current = true;
    setBusy(true);
    setError('');
    try {
      await mutation(path, { expectedRevision: board.revision, ...body }, method);
      if (!live.current) return false;
      // Mutations may return different resource types. Always render a fresh board projection.
      setRetry((n) => n + 1);
      return true;
    } catch (issue) {
      if (live.current)
        setError(
          (issue instanceof Error ? issue.message : '保存失败') +
            ' 输入和选择已保留，请刷新并核对当前计划后重试。',
        );
      return false;
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  };
  const navigate = async (id: string, review?: boolean) => {
    if (opening) return;
    setOpening(true);
    setError('');
    try {
      await openRun(id, review);
    } catch (issue) {
      if (live.current) setError(issue instanceof Error ? issue.message : '任务无法打开');
    } finally {
      if (live.current) setOpening(false);
    }
  };
  const prepare = (item: ProjectDeliveryItem) => {
    if (!board || !draft) return;
    if (draft.launch) {
      setError('已有创建任务草稿，请先继续该草稿，或明确移除后再从此交付项创建。');
      return;
    }
    change((value) => ({
      ...value,
      launch: {
        ...itemLaunchContent(board, item),
        baseline: itemLaunchContent(board, item),
        itemId: item.id,
        itemRevision: item.itemRevision,
        expectedRevision: board.revision,
      },
    }));
    if (readProjectBoardDraft(cache.get(projectBoardKey(project.id))).launch?.itemId === item.id) launch();
  };
  const exportDraft = () => {
    const value = cache.get(projectBoardKey(project.id));
    const url = URL.createObjectURL(
      new Blob([typeof value === 'string' ? value : String(value ?? '')], {
        type: 'text/plain;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `project-workbench-draft-${project.id}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportDraftSafely = () => {
    try {
      exportDraft();
      setDraftError('');
    } catch (issue) {
      setDraftError(issue instanceof Error ? issue.message : '原稿下载失败，当前输入已保留。');
    }
  };
  return (
    <div className="project-workbench" aria-label="项目交付工作台">
      <header className="project-workbench-heading">
        <div>
          <p className="project-eyebrow">项目交付工作台</p>
          <h1>{project.name}</h1>
          <p>从项目目标到可追溯的交付清单。</p>
        </div>
        <div className="project-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy || loading}
            onClick={() => setRetry((n) => n + 1)}
          >
            {loading ? '正在读取…' : '刷新项目状态'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!draft}
            onClick={() => change((value) => ({ ...value, freeOpen: !value.freeOpen }))}
          >
            自由新建任务
          </button>
          <button type="button" className="secondary" onClick={openTaskCenter}>
            任务中心
          </button>
          <button type="button" className="secondary" disabled={!loaded} onClick={exportDraftSafely}>
            导出工作台原稿 TXT
          </button>
        </div>
      </header>
      {loading && (
        <DeliveryReadProgress
          label="项目交付状态"
          progress={progress}
          cancel={() => {
            readRequest.current?.abort();
            setLoading(false);
            setProgress(undefined);
            setError('本次项目读取已取消。已读内容和草稿保留，请刷新项目状态后继续。');
          }}
        />
      )}
      {(error || draftError || parseError) && (
        <div className="field-error" role="alert">
          {error || draftError || parseError}
          {parseError && (
            <div className="project-actions">
              <button type="button" className="secondary" onClick={exportDraftSafely}>
                导出原草稿
              </button>
              <button
                type="button"
                className="secondary danger"
                onClick={() => {
                  cache.set(projectBoardKey(project.id), '');
                  setDraftError('');
                }}
              >
                明确清空无法读取的草稿
              </button>
            </div>
          )}
        </div>
      )}
      {!draft && !parseError && <p role="status">正在读取此项目的工作台草稿…</p>}
      {board && draft && (
        <>
          {board.archived && (
            <p className="field-help">项目已归档，可查看历史与草稿。恢复项目后才能修改交付计划。</p>
          )}
          <div className="project-counts">
            {!!error && <span role="status">以下为上次读取的统计，当前状态未知</span>}
            <span>
              <b>
                {board.counts.requiredReady}/{board.counts.required}
              </b>{' '}
              必需项可交付
            </span>
            <span>
              <b>
                {board.counts.ready}/{board.counts.total}
              </b>{' '}
              全部交付项
            </span>
            {board.counts.unavailable > 0 && <span>有 {board.counts.unavailable} 项读取情况未知</span>}
            <span>计划版本 {board.revision}</span>
          </div>
          {draft.freeOpen && (
            <section className="project-free-create" aria-label="自由新建项目任务">
              <button
                type="button"
                className="secondary"
                onClick={() => change((value) => ({ ...value, freeOpen: false }))}
              >
                收起 · 保留任务草稿
              </button>
              {freeComposer}
            </section>
          )}
          {draft.launch && (
            <ProjectLaunchDraft
              board={board}
              draft={draft.launch}
              busy={busy || !!error}
              launch={launch}
              change={(next) =>
                change((value) => {
                  if (JSON.stringify(value.launch) !== JSON.stringify(draft!.launch))
                    throw Error('创建草稿已变化，请重新核对。原输入已保留。');
                  return { ...value, launch: next };
                })
              }
              remove={() => change((value) => ({ ...value, launch: undefined }))}
            />
          )}
          <nav className="project-tabs" aria-label="项目工作台页面">
            {(
              [
                ['overview', '项目总览'],
                ['items', '交付清单'],
                ['executions', '关联与执行'],
                ['manifests', '汇总交付'],
                ['usage', '项目用量'],
              ] as const
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-current={activeTab === key ? 'page' : undefined}
                className={activeTab === key ? 'active' : ''}
                onClick={() =>
                  change((value) => ({
                    ...value,
                    ...(key === 'usage' ? { usageOpen: true } : { tab: key, usageOpen: false }),
                    editing: false,
                  }))
                }
              >
                {label}
              </button>
            ))}
          </nav>
          {draft.editing && draft.edit ? (
            <ProjectBoardEditor
              key={project.id}
              edit={draft.edit}
              board={board}
              busy={busy || board.archived || !!error}
              canRestorePlan={!!draft.planImportUndo}
              exportOriginal={exportDraft}
              inspectPlan={(file) => {
                try {
                  const current = readProjectBoardDraft(cache.get(projectBoardKey(project.id)));
                  if (!current.edit || JSON.stringify(current.edit) !== JSON.stringify(draft!.edit))
                    return {
                      canApply: false,
                      error: '项目计划草稿已变化，请重新核对。原输入和导入预览已保留。',
                    };
                  return projectPlanImportPreflight(current, file);
                } catch (issue) {
                  return {
                    canApply: false,
                    error: issue instanceof Error ? issue.message : '无法检查草稿容量，原稿已保留。',
                  };
                }
              }}
              applyPlan={(file) =>
                change((value) => {
                  if (!value.edit || JSON.stringify(value.edit) !== JSON.stringify(draft!.edit))
                    throw Error('项目计划草稿已变化，请重新核对后应用。原输入和导入预览已保留。');
                  return projectPlanImportDraft(value, file);
                })
              }
              restorePlan={() =>
                change((value) => {
                  if (!value.planImportUndo || JSON.stringify(value.edit) !== JSON.stringify(draft!.edit))
                    throw Error('项目计划草稿已变化，请重新核对后恢复。当前输入已保留。');
                  return { ...value, edit: value.planImportUndo, planImportUndo: undefined };
                })
              }
              change={(edit) => change((value) => ({ ...value, edit }))}
              close={() => change((value) => ({ ...value, editing: false }))}
              save={() => {
                const sent = JSON.stringify(draft!.edit);
                void action(
                  `/projects/${project.id}/delivery-board`,
                  boardEditPayload(draft!.edit!),
                  'PUT',
                ).then((ok) => {
                  if (ok)
                    change((value) =>
                      JSON.stringify(value.edit) === sent
                        ? { ...value, edit: undefined, planImportUndo: undefined, editing: false }
                        : value,
                    );
                });
              }}
            />
          ) : (
            <>
              {(activeTab === 'overview' || activeTab === 'items') && (
                <div className="project-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || board.archived}
                    onClick={() =>
                      change((value) => ({ ...value, editing: true, edit: value.edit || boardToEdit(board) }))
                    }
                  >
                    {draft.edit ? '继续编辑项目计划草稿' : '编辑目标与交付计划'}
                  </button>
                  {draft.edit && (
                    <button
                      type="button"
                      className="secondary danger"
                      disabled={busy}
                      onClick={() =>
                        change((value) => ({ ...value, edit: undefined, planImportUndo: undefined }))
                      }
                    >
                      放弃项目计划草稿
                    </button>
                  )}
                </div>
              )}
              {activeTab === 'overview' && (
                <>
                  <ProjectTodos
                    board={board}
                    unavailable={!!error}
                    selectItem={(selected) =>
                      change((value) => ({ ...value, tab: 'items', filter: 'all', selected, editing: false }))
                    }
                    openRun={(itemId, id, review) => {
                      change((value) => ({ ...value, selected: itemId }));
                      void navigate(id, review);
                    }}
                    manifests={() => change((value) => ({ ...value, tab: 'manifests' }))}
                  />
                  <section className="project-overview">
                    <h2>项目目标</h2>
                    <p className="project-prose">
                      {board.goal || '先描述项目希望达成的结果，再定义可验收的交付项。'}
                    </p>
                    <div className="project-form-columns">
                      <div>
                        <h3>范围</h3>
                        {board.scope.length ? (
                          <ul>
                            {board.scope.map((text, index) => (
                              <li key={index}>{text}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="field-help">尚未填写范围。</p>
                        )}
                      </div>
                      <div>
                        <h3>不做事项</h3>
                        {board.nonGoals.length ? (
                          <ul>
                            {board.nonGoals.map((text, index) => (
                              <li key={index}>{text}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="field-help">尚未填写不做事项。</p>
                        )}
                      </div>
                    </div>
                    <p className="field-help">
                      执行完成、人工采纳、原意见复验和项目标准符合性分别确认。只有满足全部条件的候选才能纳入冻结清单。
                    </p>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => change((value) => ({ ...value, tab: 'items' }))}
                    >
                      查看交付清单
                    </button>
                  </section>
                </>
              )}
              {activeTab === 'items' && (
                <>
                  <label className="project-filter">
                    交付项范围
                    <select
                      value={draft.filter}
                      onChange={(e) =>
                        change((value) => ({
                          ...value,
                          filter: e.target.value as ProjectBoardDraft['filter'],
                        }))
                      }
                    >
                      <option value="all">全部交付项</option>
                      <option value="attention">尚待处理</option>
                      <option value="ready">可交付</option>
                    </select>
                  </label>
                  <div className="project-item-layout">
                    <nav aria-label="交付项选择">
                      {board.items
                        .filter(
                          (item) =>
                            draft!.filter === 'all' ||
                            (draft!.filter === 'ready'
                              ? item.readiness === 'ready'
                              : item.readiness !== 'ready'),
                        )
                        .map((item) => (
                          <button
                            type="button"
                            key={item.id}
                            className={'project-item-link ' + (draft!.selected === item.id ? 'selected' : '')}
                            aria-current={draft!.selected === item.id ? 'true' : undefined}
                            onClick={() => change((value) => ({ ...value, selected: item.id }))}
                          >
                            <strong>{item.title}</strong>
                            <span>
                              {item.required ? '必需 · ' : ''}
                              {readinessLabels[item.readiness]}
                            </span>
                            <small>{item.attemptCount} 次关联执行</small>
                          </button>
                        ))}
                      {!board.items.length && <p className="field-help">在项目计划中添加第一个交付项。</p>}
                    </nav>
                    <div>
                      {board.items.find((item) => item.id === draft!.selected) ? (
                        <ProjectBoardItem
                          key={draft.selected}
                          board={board}
                          item={board.items.find((item) => item.id === draft!.selected)!}
                          busy={busy || opening || !!error}
                          note={draft.confirmNotes?.[draft.selected] || ''}
                          changeNote={(note) =>
                            change((value) => ({
                              ...value,
                              confirmNotes: { ...value.confirmNotes, [value.selected]: note },
                            }))
                          }
                          query={draft.query}
                          changeQuery={(query) => change((value) => ({ ...value, query }))}
                          openRun={(id, review) => void navigate(id, review)}
                          createRun={() => prepare(board.items.find((item) => item.id === draft!.selected)!)}
                          action={action}
                        />
                      ) : (
                        <p className="field-help">选择一个交付项，查看标准、候选与历次执行。</p>
                      )}
                    </div>
                  </div>
                </>
              )}
              {activeTab === 'executions' && (
                <ProjectRunList
                  projectId={project.id}
                  query={draft.query}
                  changeQuery={(query) => change((value) => ({ ...value, query }))}
                  openRun={(id, review) => void navigate(id, review)}
                />
              )}
              {activeTab === 'manifests' && (
                <ProjectManifests
                  board={board}
                  draft={draft}
                  change={change}
                  busy={busy || !!error}
                  action={action}
                  openRun={(id, review) => void navigate(id, review)}
                />
              )}
              {activeTab === 'usage' && (
                <ProjectUsage key={project.id} projectId={project.id} openRun={(id) => void navigate(id)} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
