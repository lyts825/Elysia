/**
 * 组织项目工作台的内容与操作。
 * 整合交付看板、计划编辑、启动、清单、备份与设置面板，协调轮询、写入和离开保护；专用模块各自校验草稿及请求身份。
 * EN: Organizes the project workbench and its actions. Composes board, plan editing, launch, manifests, backups, and settings with polling/write/leave coordination; dedicated modules validate their drafts and request identities.
 */
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
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
import { ProjectDraftBackup } from './ProjectDraftBackup';
/**
 * 计划导入预览与导航保护共享生命周期，离开前可检查是否仍有待处理内容。
 * EN: Import preview and navigation guard share a lifecycle so leaving can detect unresolved content.
 */
import type { PlanImportLifecycle } from './ProjectPlanTransfer';
import type { ProjectPlanNavigationLifecycle } from './ProjectPlanNavigation';
import { projectPlanImportDraft, projectPlanImportPreflight } from './project-plan-transfer';
import { ProjectBoardItem, readinessLabels } from './ProjectBoardItem';
import { ProjectRunList } from './ProjectRunList';
import { ProjectManifests } from './ProjectManifests';
import { ProjectTodos } from './ProjectTodos';
import { ProjectLaunchDraft } from './ProjectLaunchDraft';
import { ProjectUsage } from './ProjectUsage';
import { ProjectIntelligence } from './ProjectIntelligence';
import { ProjectSchedules } from './ProjectSchedules';
import { useSurfaceClient } from './SurfaceClientContext';
import { DeliveryReadProgress, prepareDeliveryRead, type DeliveryWarmProgress } from './DeliveryReadProgress';
import './project-workbench.css';

/**
 * 项目交付工作台同时维护服务端看板投影与本地编辑草稿，两者独立读取并保留版本基线。
 * 只在写操作前使用当前看板修订，成功后重新读取统一投影；轮询不会覆盖草稿。
 * 计划导入通过命令式生命周期向外层导航门禁报告未处理预览，防止离开时丢失核对意图。
 * EN: Keep server board projection and local draft independent with version baselines. Mutations use current board revision, then reread one unified projection; polling never overwrites drafts. Import lifecycle reports unresolved previews to outer navigation guards.
 */
export function ProjectWorkbench({
  project,
  cache,
  raw,
  freeComposer,
  openRun,
  launch,
  openTaskCenter,
  navigationLifecycle,
}: {
  project: Project;
  cache: WorkbenchCache;
  raw: unknown;
  freeComposer: ReactNode;
  openRun: (id: string, review?: boolean) => Promise<void>;
  launch: () => void;
  openTaskCenter: () => void;
  navigationLifecycle?: RefObject<ProjectPlanNavigationLifecycle | null>;
}) {
  const { api, mutation } = useSurfaceClient();
  const [board, setBoard] = useState<ProjectDeliveryBoard>(),
    [readError, setReadError] = useState(''),
    [actionError, setActionError] = useState(''),
    [openError, setOpenError] = useState(''),
    [draftError, setDraftError] = useState('');
  const [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0),
    [opening, setOpening] = useState(false);
  const live = useRef(true),
    writing = useRef(false),
    actionIssueSource = useRef<string | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<DeliveryWarmProgress>();
  const planLifecycle = useRef<PlanImportLifecycle | null>(null);
  useImperativeHandle(
    navigationLifecycle,
    () => ({
      projectId: project.id,
      /**
       * 查询当前计划导入组件是否还有待处理预览；组件不存在时返回false供导航协调器判断。
       * EN: Queries the current plan importer for a pending preview, returning false when absent for navigation coordination.
       */
      hasPending: () => planLifecycle.current?.hasPending() ?? false,
      /**
       * 让计划导入组件丢弃预览并清除工作台待离开动作，保持父子生命周期状态一致。
       * EN: Discards the plan-import preview and clears the workbench pending-leave action, keeping parent and child lifecycle state aligned.
       */
      discard: () => {
        planLifecycle.current?.discard();
        setPendingLeave(undefined);
      },
    }),
    [project.id],
  );
  const [pendingLeave, setPendingLeave] = useState<() => boolean>();
  const [intelligenceOpen, setIntelligenceOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  useLayoutEffect(() => setSchedulesOpen(false), [project.id]);
  useLayoutEffect(() => setIntelligenceOpen(false), [project.id]);
  useLayoutEffect(() => setPendingLeave(undefined), [project.id, api]);
  /**
   * 导入预览尚未处理时延迟页内导航，获准后才执行原动作。
   * EN: Defer in-page navigation for unresolved imports and execute the original action only after permission.
   */
  const leavePlan = (action: () => boolean) => {
    if (planLifecycle.current?.hasPending()) setPendingLeave(() => action);
    else action();
  };
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
  /**
   * 先完成交付元数据预热再读取看板；后台轮询互斥，且写入期间不混入旧快照。
   * EN: Warm delivery metadata before board reading; serialize polling and exclude stale snapshots during writes.
   */
  useEffect(() => {
    const controller = new AbortController();
    readRequest.current = controller;
    let pending = false,
      firstRead = true;
    /**
     * 串行预热并读取项目交付看板，写入期间不刷新；首读展示进度，取消后不回写，后续轮询保留可读旧快照。
     * EN: Serially warms and reads the project delivery board, skipping refresh during writes. Initial reads show progress, aborted reads do not publish, and later polling retains the readable snapshot.
     */
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
          setReadError('');
        }
      } catch (issue) {
        if (!controller.signal.aborted)
          setReadError(issue instanceof Error ? issue.message : '项目交付计划读取失败');
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
  /**
   * 草稿原文未变时复用解析结果，避免轮询和进度更新反复校验大草稿；错误仍保留原文。
   * EN: Reuse parsing while the raw draft is unchanged so polling/progress renders do not revalidate large drafts; errors still preserve the source.
   */
  const { draft, parseError } = useMemo(() => {
    try {
      return { draft: loaded ? readProjectBoardDraft(raw) : undefined, parseError: '' };
    } catch (issue) {
      return {
        draft: undefined,
        parseError: issue instanceof Error ? issue.message : '草稿无法读取',
      };
    }
  }, [loaded, raw]);
  const activeTab = draft?.usageOpen ? 'usage' : draft?.tab;
  const visibleItems =
    board?.items.filter(
      (item) =>
        draft?.filter === 'all' ||
        (draft?.filter === 'ready' ? item.readiness === 'ready' : item.readiness !== 'ready'),
    ) || [];
  /**
   * 调用看板草稿写入器更新本地缓存；成功返回true，校验或容量异常保留原稿并提示。
   * EN: Updates the local board draft through its validated writer, returning true on success and preserving the source draft with feedback on validation or capacity failure.
   */
  const change = (update: (value: ProjectBoardDraft) => ProjectBoardDraft) => {
    /**
     * 草稿只更新本地缓存；校验或容量失败时保留上次内容并显示错误。
     * EN: Draft changes update local cache only; retain previous content and show validation/capacity errors.
     */
    try {
      writeProjectBoardDraft(cache, project.id, update);
      setDraftError('');
      return true;
    } catch (issue) {
      setDraftError(issue instanceof Error ? issue.message : '保存草稿失败');
      return false;
    }
  };
  /**
   * 串行提交当前看板版本的动作，按请求来源保留失败提示；成功结果类型不一，因此不
   * 直接替换 board，而是触发完整重读。只有仍挂载的工作台才消费操作结果。
   * EN: Serialize current-revision actions and keep errors at their origin. Responses may be different resource types, so reread board rather than replacing it directly. Only mounted workbenches consume results.
   */
  const action = async (path: string, body: Record<string, unknown>, method = 'POST') => {
    /**
     * 使用当前看板版本执行写入，结束后重新读取统一投影而不混用不同接口的返回值。
     * EN: Mutate against current board revision and reread the common projection instead of mixing endpoint results.
     */
    if (!board || readError || writing.current || board.archived || !live.current) return false;
    writing.current = true;
    setBusy(true);
    const source = `${method} ${path}`;
    try {
      await mutation(path, { expectedRevision: board.revision, ...body }, method);
      if (!live.current) return false;
      if (actionIssueSource.current === source) {
        actionIssueSource.current = null;
        setActionError('');
      }
      /**
       * 修改可能返回不同资源，始终展示新读的看板投影。
       * EN: Mutations may return different resource types. Always render a fresh board projection.
       */
      setRetry((n) => n + 1);
      return true;
    } catch (issue) {
      if (live.current) {
        actionIssueSource.current = source;
        setActionError(
          (issue instanceof Error ? issue.message : '保存失败') +
            ' 输入和选择已保留，请刷新并核对当前计划后重试。',
        );
      }
      return false;
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  };
  /**
   * 打开候选运行时防止重复导航，失败保留工作台及草稿并在本区域显示错误。
   * EN: Prevent duplicate candidate navigation; on failure retain workbench/draft and show a local error.
   */
  const navigate = async (id: string, review?: boolean) => {
    if (opening) return;
    setOpening(true);
    setOpenError('');
    try {
      await openRun(id, review);
    } catch (issue) {
      if (live.current) setOpenError(issue instanceof Error ? issue.message : '任务无法打开');
    } finally {
      if (live.current) setOpening(false);
    }
  };
  /**
   * 以交付项和看板当前版本建立唯一创建草稿；已有草稿必须由用户先继续或移除。
   * EN: Create one launch draft from current item/board revision; existing drafts require explicit continuation or removal.
   */
  const prepare = (item: ProjectDeliveryItem) => {
    /**
     * 已有创建草稿时不覆盖；新草稿冻结交付项和看板版本供后续核对。
     * EN: Do not overwrite existing launch drafts; freeze item and board revision for later review.
     */
    if (!board || !draft || readError) return;
    if (draft.launch) {
      actionIssueSource.current = null;
      setActionError('已有创建任务草稿，请先继续该草稿，或明确移除后再从此交付项创建。');
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
  /**
   * 将项目看板缓存原稿作为TXT下载，不依赖草稿成功解析，供错误恢复时保存输入。
   * EN: Downloads the cached project-board source as TXT without requiring successful parsing, preserving input for recovery.
   */
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
  /**
   * 包装原稿下载并把浏览器下载错误转换为草稿区反馈；输入本身不因导出失败而改变。
   * EN: Wraps source-draft download and presents browser download errors in the draft area while retaining the input.
   */
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
          <button
            type="button"
            className="secondary"
            aria-expanded={intelligenceOpen}
            onClick={() => setIntelligenceOpen((value) => !value)}
          >
            {intelligenceOpen ? '收起能力与记忆' : '项目能力与记忆'}
          </button>
          <button type="button" className="secondary" disabled={!loaded} onClick={exportDraftSafely}>
            导出工作台原稿 TXT
          </button>
          <button
            type="button"
            className="secondary"
            aria-expanded={schedulesOpen}
            onClick={() => setSchedulesOpen((value) => !value)}
          >
            {schedulesOpen ? '收起定时任务' : '项目定时任务'}
          </button>
        </div>
      </header>
      {intelligenceOpen && (
        <ProjectIntelligence
          key={`intelligence:${project.id}`}
          projectId={project.id}
          cache={cache}
          archived={project.archived}
        />
      )}
      {schedulesOpen && (
        <ProjectSchedules
          key={`schedules:${project.id}`}
          projectId={project.id}
          cache={cache}
          archived={project.archived}
          openRun={navigate}
        />
      )}
      {loaded && (
        <ProjectDraftBackup
          key={project.id}
          projectId={project.id}
          cache={cache}
          raw={raw}
          busy={busy}
          restored={() => {
            planLifecycle.current?.discard();
            setPendingLeave(undefined);
          }}
        />
      )}
      {loading && (
        <DeliveryReadProgress
          label="项目交付状态"
          progress={progress}
          cancel={() => {
            readRequest.current?.abort();
            setLoading(false);
            setProgress(undefined);
            setReadError('本次项目读取已取消。已读内容和草稿保留，请刷新项目状态后继续。');
          }}
        />
      )}
      {readError && (
        <div className="field-error" role="alert" aria-label="项目交付读取问题">
          {readError}
        </div>
      )}
      {actionError && (
        <div className="field-error" role="alert" aria-label="项目交付保存问题">
          <p>{actionError}</p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              actionIssueSource.current = null;
              setActionError('');
            }}
          >
            已核对 · 清除保存提示
          </button>
        </div>
      )}
      {openError && (
        <div className="field-error" role="alert" aria-label="打开任务问题">
          <p>{openError}</p>
          <button type="button" className="secondary" onClick={() => setOpenError('')}>
            清除打开提示
          </button>
        </div>
      )}
      {(draftError || parseError) && (
        <div className="field-error" role="alert">
          {draftError || parseError}
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
          </div>
          <dl className="project-workbench-basis" aria-label="工作台已读计划与本机草稿依据">
            <div>
              <dt>已读计划</dt>
              <dd>版本 {board.revision}</dd>
              <dd>
                {loading
                  ? '正在重读，保留已读内容'
                  : readError
                    ? '保留上次结果，当前状态尚未确认'
                    : '显示已读内容'}
              </dd>
            </div>
            <div>
              <dt>本机计划草稿</dt>
              <dd>{draft.edit ? `基于版本 ${draft.edit.basedOn}，尚未保存到项目计划` : '无计划编辑草稿'}</dd>
            </div>
          </dl>
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
              busy={busy || !!readError}
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
                  leavePlan(() =>
                    change((value) => ({
                      ...value,
                      ...(key === 'usage' ? { usageOpen: true } : { tab: key, usageOpen: false }),
                      editing: false,
                    })),
                  )
                }
              >
                {label}
              </button>
            ))}
          </nav>
          {pendingLeave && (
            <section className="project-plan-leave" aria-label="未应用导入预览离开确认">
              <p>
                离开将取消正在读取或尚未应用的导入预览；当前编辑内容和已应用的导入前原稿仍保留。返回后需重选计划文件。
              </p>
              <div className="project-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setPendingLeave(undefined)}
                >
                  留在当前预览
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    const lifecycle = planLifecycle.current;
                    if (pendingLeave()) {
                      lifecycle?.discard();
                      setPendingLeave(undefined);
                    }
                  }}
                >
                  离开预览 · 保留编辑草稿
                </button>
              </div>
            </section>
          )}
          {draft.editing && draft.edit ? (
            <ProjectBoardEditor
              key={project.id}
              edit={draft.edit}
              board={board}
              busy={busy || board.archived || !!readError}
              canRestorePlan={!!draft.planImportUndo}
              planLifecycle={planLifecycle}
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
              close={() => leavePlan(() => change((value) => ({ ...value, editing: false })))}
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
                    disabled={busy || board.archived || !!readError}
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
                    busy={busy}
                    unavailable={!!readError}
                    onEditPlan={() =>
                      change((value) => ({ ...value, editing: true, edit: value.edit || boardToEdit(board) }))
                    }
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
                  <p className="field-help project-item-range" role="status">
                    当前筛选显示 {visibleItems.length} / {board.items.length} 个已读交付项。
                    {board.items.some((item) => item.id === draft!.selected) &&
                      !visibleItems.some((item) => item.id === draft!.selected) &&
                      '当前详情不在筛选结果中，仍保留供核对。'}
                  </p>
                  <div className="project-item-layout">
                    <nav aria-label="交付项选择">
                      {visibleItems.map((item) => (
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
                      {!!board.items.length && !visibleItems.length && (
                        <p className="field-help">当前筛选没有交付项，可切换交付项范围继续查看。</p>
                      )}
                    </nav>
                    <div>
                      {board.items.find((item) => item.id === draft!.selected) ? (
                        <ProjectBoardItem
                          key={draft.selected}
                          board={board}
                          item={board.items.find((item) => item.id === draft!.selected)!}
                          busy={busy || opening || !!readError}
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
                  busy={busy}
                  unavailable={!!readError}
                  onRefreshBoard={() => setRetry((value) => value + 1)}
                  onEditPlan={() =>
                    change((value) => ({ ...value, editing: true, edit: value.edit || boardToEdit(board) }))
                  }
                  onSelectItem={(selected) =>
                    change((value) => ({
                      ...value,
                      tab: 'items',
                      filter: 'all',
                      query: '',
                      selected,
                      editing: false,
                    }))
                  }
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
