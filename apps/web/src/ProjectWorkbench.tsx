import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Project } from '../../../packages/contracts/src/index';
import type {
  ProjectDeliveryBoard,
  ProjectDeliveryItem,
} from '../../../packages/contracts/src/project-delivery';
import type { WorkbenchCache } from './WorkbenchCache';
import {
  boardToEdit,
  projectBoardKey,
  readProjectBoardDraft,
  writeProjectBoardDraft,
  type ProjectBoardDraft,
} from './ProjectBoardDraft';
import { ProjectBoardEditor, boardEditPayload } from './ProjectBoardEditor';
import { ProjectBoardItem, readinessLabels } from './ProjectBoardItem';
import { ProjectRunList } from './ProjectRunList';
import { ProjectManifests } from './ProjectManifests';
import { useSurfaceClient } from './SurfaceClientContext';
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
    let pending = false;
    const read = async () => {
      if (pending || writing.current) return;
      pending = true;
      setLoading(true);
      try {
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
        if (!controller.signal.aborted) setLoading(false);
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
  const change = (update: (value: ProjectBoardDraft) => ProjectBoardDraft) => {
    try {
      writeProjectBoardDraft(cache, project.id, update);
      setDraftError('');
    } catch (issue) {
      setDraftError(issue instanceof Error ? issue.message : '保存草稿失败');
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
        itemId: item.id,
        itemRevision: item.itemRevision,
        expectedRevision: board.revision,
        title: item.title,
        objective: [
          item.title,
          item.description,
          board.goal && `项目目标：${board.goal}`,
          board.scope.length && `项目范围：\n${board.scope.join('\n')}`,
          board.nonGoals.length && `不做事项：\n${board.nonGoals.join('\n')}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        deliverables: item.deliverables.join('\n'),
        acceptanceCriteria: item.acceptanceCriteria.join('\n'),
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
        </div>
      </header>
      {(error || draftError || parseError) && (
        <div className="field-error" role="alert">
          {error || draftError || parseError}
          {parseError && (
            <div className="project-actions">
              <button type="button" className="secondary" onClick={exportDraft}>
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
            <section className="project-launch-draft">
              <strong>待创建：{draft.launch.title}</strong>
              <p>来源项目标准版本 {draft.launch.itemRevision}，草稿保留了当时的目标和标准。</p>
              {draft.launch.expectedRevision !== board.revision && (
                <p className="field-error">项目计划已变化。请核对当前交付项后再继续，旧输入不会自动替换。</p>
              )}
              <div className="project-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || board.archived || draft.launch.expectedRevision !== board.revision}
                  onClick={launch}
                >
                  继续创建草稿
                </button>
                {draft.launch.expectedRevision !== board.revision && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={!board.items.some((item) => item.id === draft!.launch!.itemId)}
                    onClick={() =>
                      change((value) => ({
                        ...value,
                        launch: { ...value.launch!, expectedRevision: board.revision },
                      }))
                    }
                  >
                    已核对当前计划，保留草稿继续
                  </button>
                )}
                <button
                  type="button"
                  className="secondary danger"
                  disabled={busy}
                  onClick={() => change((value) => ({ ...value, launch: undefined }))}
                >
                  移除此创建草稿
                </button>
              </div>
            </section>
          )}
          <nav className="project-tabs" aria-label="项目工作台页面">
            {(
              [
                ['overview', '目标与范围'],
                ['items', '交付清单'],
                ['executions', '关联与执行'],
                ['manifests', '汇总交付'],
              ] as const
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-current={draft!.tab === key ? 'page' : undefined}
                className={draft!.tab === key ? 'active' : ''}
                onClick={() => change((value) => ({ ...value, tab: key, editing: false }))}
              >
                {label}
              </button>
            ))}
          </nav>
          {draft.editing && draft.edit ? (
            <ProjectBoardEditor
              edit={draft.edit}
              revision={board.revision}
              busy={busy || board.archived}
              change={(edit) => change((value) => ({ ...value, edit }))}
              close={() => change((value) => ({ ...value, editing: false }))}
              rebase={() =>
                change((value) => ({ ...value, edit: { ...value.edit!, basedOn: board.revision } }))
              }
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
                        ? { ...value, edit: undefined, editing: false }
                        : value,
                    );
                });
              }}
            />
          ) : (
            <>
              {(draft.tab === 'overview' || draft.tab === 'items') && (
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
                      onClick={() => change((value) => ({ ...value, edit: undefined }))}
                    >
                      放弃项目计划草稿
                    </button>
                  )}
                </div>
              )}
              {draft.tab === 'overview' && (
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
              )}
              {draft.tab === 'items' && (
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
              {draft.tab === 'executions' && (
                <ProjectRunList
                  projectId={project.id}
                  query={draft.query}
                  changeQuery={(query) => change((value) => ({ ...value, query }))}
                  openRun={(id, review) => void navigate(id, review)}
                />
              )}
              {draft.tab === 'manifests' && (
                <ProjectManifests
                  board={board}
                  draft={draft}
                  change={change}
                  busy={busy || !!error}
                  action={action}
                  openRun={(id, review) => void navigate(id, review)}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
