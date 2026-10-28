/**
 * 展示会话侧栏并管理会话选择。
 * EN: Displays the session sidebar and selection actions.
 *
 * 集中呈现分页会话与项目分组，协调右键菜单、快捷键和带版本的管理操作。完整目标按需读取，列表摘要、未加载计数及旧终端只读状态各有明确处理。
 * EN: Present paged runs and project groups with context menus, shortcuts, and revision-checked actions. Load full objectives on demand and explicitly handle summaries, unknown counts, and read-only legacy terminals.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  Project,
  ProjectSpace,
  Run,
  RunListItem,
  RecordPage,
} from '../../../packages/contracts/src/index';
import { Icon } from './Icon';
import { Modal } from './Modal';
import type { CacheEntry } from './WorkbenchCache';
import './sessions.css';
import { useSurfaceClient, useSurfaceRoot } from './SurfaceClientContext';
import { captureHistoryAnchor, historyViewportVisible, restoreHistoryAnchor } from './HistoryScroll';
import { ProjectArchiveDeleteNotice, type ProjectArchiveDeleteConsent } from './ProjectDeliveryArchive';

type Target = { kind: 'project'; item: Project } | { kind: 'run'; item: RunListItem };
/**
 * 菜单操作携带目标实体，避免项目与运行使用同一个未区分的标识。
 * EN: Menu actions carry typed target entities so project/run IDs cannot be confused.
 */
export type SessionTarget = Target;
export type SessionUpdateResult = boolean | 'conflict';
type Dialog = { target: Target; action: 'rename' | 'delete' | 'move'; value: string };
type MenuAction = { label: string; icon: string; shortcut?: string; danger?: boolean; action: () => void };
/**
 * 将项目与运行列表组织为侧栏树，并承接外层的分页、选择和持久标记操作。
 * 列表刷新用可见锚点保留阅读位置，自动加载只响应可见区域的滚动意图；菜单通过 portal
 * 显示在入口根节点内，键盘操作在弹窗或输入控件活跃时暂停，避免夺取编辑快捷键。
 * EN: Organize project/run tree with outer paging/selection/markers. Preserve list anchors on refresh; auto-load requires visible scroll intent. Portal menus stay inside surface root. Suspend keys during dialogs or input editing to avoid stealing shortcuts.
 */
export function SessionSidebar({
  projects,
  spaces,
  runs,
  spaceId,
  projectId,
  runId,
  entries,
  busy,
  error,
  setValue,
  selectProject,
  selectRun,
  create,
  files,
  manage,
  update,
  listPage,
  listTrail,
  listBusy,
  listQuery,
  changeListQuery,
  listNavigate,
  projectCounts,
  listDynamic = false,
  listError,
  listReadCoverage,
  inspectUnreadable,
  listWindowLimited = false,
}: {
  projects: Project[];
  spaces: ProjectSpace[];
  runs: RunListItem[];
  spaceId: string;
  projectId: string;
  runId: string;
  entries: Record<string, CacheEntry>;
  busy: boolean;
  error: string;
  setValue: (key: string, value: string | boolean) => void;
  selectProject: (id: string) => void;
  selectRun: (run: RunListItem) => void;
  create: (projectId: string, objective?: string) => void;
  files: (project: Project) => void;
  manage: (tab: string) => void;
  update: (
    target: Target,
    changes: Record<string, unknown>,
    remove?: boolean,
  ) => Promise<SessionUpdateResult>;
  listPage?: RecordPage;
  listTrail?: boolean;
  listBusy?: boolean;
  listQuery?: string;
  changeListQuery?: (value: string) => void;
  listNavigate?: (direction: 'older' | 'newer' | 'latest') => void;
  projectCounts?: Record<string, number>;
  listDynamic?: boolean;
  listError?: string;
  listReadCoverage?: { complete: boolean; unavailable: number };
  inspectUnreadable?: () => void;
  listWindowLimited?: boolean;
}) {
  const { surface: localSurface, api } = useSurfaceClient();
  const surfaceRoot = useSurfaceRoot();
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{ target: Target; x: number; y: number; trigger: HTMLElement } | null>(
    null,
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [archiveConsent, setArchiveConsent] = useState<ProjectArchiveDeleteConsent>();
  const dialogRef = useRef<Dialog | null>(null);
  const conflictDrafts = useRef(new Map<string, string>());
  dialogRef.current = dialog;
  const [clipboardError, setClipboardError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const treeAnchor = useRef<ReturnType<typeof captureHistoryAnchor>>(undefined);
  const lastTreeScroll = useRef(0);
  const olderRequested = useRef('');
  const treeIntentUntil = useRef(0);
  const touchY = useRef(0);
  const listIdentity = `${spaceId}:${listQuery || ''}`;
  const previousListIdentity = useRef(listIdentity);
  const previousListBefore = useRef(listPage?.before);
  /**
   * 查询/空间变化或返回最新页时从顶部开始；同一窗口数据更新才恢复旧锚点。
   * EN: Reset to top after query/space changes or latest-page return; restore anchors only for updates within one window.
   */
  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const resetToLatest = !listPage?.before && !!previousListBefore.current;
    previousListBefore.current = listPage?.before;
    if (previousListIdentity.current !== listIdentity || resetToLatest) {
      previousListIdentity.current = listIdentity;
      tree.scrollTop = 0;
      treeAnchor.current = undefined;
      olderRequested.current = '';
    } else restoreHistoryAnchor(tree, treeAnchor.current);
    lastTreeScroll.current = tree.scrollTop;
    treeAnchor.current = captureHistoryAnchor(tree);
  }, [runs, projects, listIdentity, listPage?.before]);
  /**
   * 接近列表底部时请求更早记录，检查加载、错误、窗口上限及游标状态。同一游标只发起一次请求，避免滚动事件重复翻页。
   * EN: Request older records near the list bottom after checking loading, errors, window limits, and cursor identity; deduplicate requests for the same cursor.
   */
  const requestOlderList = () => {
    /**
     * 仅在列表可见且接近底部时请求下一页，同一游标不重复触发。
     * EN: Load more only while visible near bottom and do not repeat the same cursor.
     */
    const tree = treeRef.current;
    const cursor = listPage?.nextBefore;
    if (
      !listDynamic ||
      !listNavigate ||
      busy ||
      listBusy ||
      listError ||
      listWindowLimited ||
      !cursor ||
      olderRequested.current === cursor ||
      !historyViewportVisible(tree) ||
      tree!.scrollHeight - tree!.clientHeight - tree!.scrollTop > 120
    )
      return;
    olderRequested.current = cursor;
    listNavigate('older');
  };
  /**
   * 把缓存中的严格布尔 true 解释为启用状态，缺失值或字符串不会误启用侧栏偏好。
   * EN: Treat only the cached boolean true as enabled; missing values and strings do not activate sidebar preferences.
   */
  const flag = (key: string) => entries[key]?.value === true;
  const terminal = localSurface === 'terminal';
  /**
   * 识别原生界面中的旧 Docker 终端记录，使菜单与快捷键遵循其只读限制。
   * EN: Identify legacy Docker terminal records on the native surface so menus and shortcuts honor their read-only state.
   */
  const readOnlyRun = (run: RunListItem) => !terminal && run.execution?.kind === 'docker-agent';
  /**
   * 统一返回项目名称或会话标题，缺失会话标题时回退到目标文本，用于菜单和确认提示。
   * EN: Resolve project names or run titles, falling back to the objective for menu and confirmation labels.
   */
  const title = (target: Target) =>
    target.kind === 'project' ? target.item.name : target.item.title || target.item.objective;
  const searchValue = changeListQuery ? listQuery || '' : search;
  /**
   * 清除当前搜索并保留输入焦点，沿用父级服务端筛选或本地筛选的状态来源。
   * EN: Clear the current search and retain input focus, preserving the parent/local query owner.
   */
  const clearSearch = () => {
    if (changeListQuery) changeListQuery('');
    else setSearch('');
    searchInput.current?.focus({ preventScroll: true });
  };
  const query = searchValue.trim().toLocaleLowerCase();
  /**
   * 服务端搜索时采用记录的匹配标记，本地模式才比较标题和目标，避免仅用已加载片段重复筛选。
   * EN: Honor server match flags for remote search; compare title and objective only in local mode to avoid filtering incomplete projections again.
   */
  const matches = (run: RunListItem) =>
    changeListQuery
      ? !('matchesQuery' in run) || run.matchesQuery !== false
      : `${run.title} ${run.objective}`.toLocaleLowerCase().includes(query);
  /**
   * 读取项目的服务端会话计数；计数尚未提供时显示未知标记，避免把未加载误报成零。
   * EN: Read server-provided project run counts and display an unknown marker when counts have not been loaded.
   */
  const projectCount = (id: string) => (projectCounts ? (projectCounts[id] ?? 0) : '—');
  const activeProjects = projects.filter((p) => !p.archived && p.spaceId === spaceId);
  const visibleRuns = runs.filter(
    /**
     * 归档运行不进入常规侧栏；终端入口只展示任务。
     * EN: Exclude archived runs from ordinary sidebar; terminal surface shows task runs only.
     */
    (r) =>
      !r.archived &&
      (!terminal || r.kind === 'task') &&
      (r.kind === 'chat' || activeProjects.some((p) => p.id === r.projectId)),
  );
  /**
   * 复制记录后按创建时间倒序排列，保持最新会话优先且不修改父组件传入的数组。
   * EN: Sort a copied list by descending creation time, keeping recent runs first without mutating parent-owned arrays.
   */
  const ordered = (list: RunListItem[]) => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pinned = ordered(visibleRuns.filter((r) => flag(`pinned:run:${r.id}`) && matches(r)));
  const chats = ordered(visibleRuns.filter((r) => r.kind === 'chat' && matches(r)));
  /**
   * 项目列表尚未读到的任务单独保留，不能把未观测所属误当作任务不存在。
   * EN: Keep tasks whose project is not yet loaded; unobserved ownership does not mean task absence.
   */
  const pendingProjectRuns = ordered(
    runs.filter(
      (r) => !r.archived && r.kind === 'task' && !projects.some((p) => p.id === r.projectId) && matches(r),
    ),
  );
  /**
   * 关闭右键菜单，并按调用需要把焦点还给仍连接到文档的触发按钮。
   * EN: Close the context menu and optionally restore focus to its trigger when that element remains attached.
   */
  const closeMenu = (restore = false) => {
    if (restore && menu?.trigger.isConnected) menu.trigger.focus({ preventScroll: true });
    setMenu(null);
  };
  /**
   * 保存触发元素用于菜单关闭后恢复焦点；鼠标右键与按钮点击分别采用指针或按钮坐标。
   * EN: Keep opener for focus restore. Context-menu coordinates come from pointer while button menus anchor to button.
   */
  const openMenu = (event: React.MouseEvent<HTMLElement>, target: Target) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setClipboardError('');
    setMenu({
      target,
      trigger: event.currentTarget,
      x: event.type === 'contextmenu' ? event.clientX : rect.right,
      y: event.type === 'contextmenu' ? event.clientY : rect.bottom,
    });
  };
  /**
   * 以实体类型、标识和操作组成对话框草稿键，使不同对象及改名、移动输入相互隔离。
   * EN: Build a dialog draft key from entity kind, ID, and action to isolate edits across targets and operations.
   */
  const draftKey = (target: Target, action: Dialog['action']) => `${target.kind}:${target.item.id}:${action}`;
  /**
   * 关闭确认框并清理该次冲突草稿、引用及删除同意状态，防止下次操作沿用旧确认。
   * EN: Close the dialog and clear its conflict draft, reference, and archive consent so later actions cannot reuse stale confirmation.
   */
  const closeDialog = () => {
    if (dialogRef.current)
      conflictDrafts.current.delete(draftKey(dialogRef.current.target, dialogRef.current.action));
    dialogRef.current = null;
    setDialog(null);
    setArchiveConsent(undefined);
  };
  /**
   * 只更新仍属于当前弹窗实例的输入，避免异步冲突处理改写后来打开的目标。
   * EN: Update inputs only for the same dialog instance so async conflicts cannot rewrite a later target.
   */
  const changeDialogValue = (source: Dialog, value: string) => {
    if (dialogRef.current !== source) return;
    const next = { ...source, value };
    dialogRef.current = next;
    setDialog(next);
  };
  const canSubmitDialog =
    dialog &&
    !busy &&
    (dialog.action === 'rename'
      ? !!dialog.value.trim()
      : dialog.action === 'move'
        ? spaces.some((space) => space.id === dialog.value)
        : dialog.target.kind !== 'project' ||
          terminal ||
          archiveConsent?.projectId === dialog.target.item.id);
  /**
   * 打开指定实体的操作框，优先恢复同一目标的冲突输入，并重置删除确认；重试时保留用户已编辑内容。
   * EN: Open a target action, restoring its conflict draft when present and resetting deletion consent so retries preserve user edits.
   */
  const showDialog = (target: Target, action: Dialog['action']) => {
    /**
     * 并发冲突后恢复同一目标与操作的输入草稿，避免用户重新填写。
     * EN: Retain rename/move input after conflict for the same target/action.
     */
    setArchiveConsent(undefined);
    const next: Dialog = {
      target,
      action,
      value:
        conflictDrafts.current.get(draftKey(target, action)) ??
        (action === 'rename'
          ? title(target)
          : action === 'move' && target.kind === 'project'
            ? target.item.spaceId
            : ''),
    };
    dialogRef.current = next;
    setDialog(next);
  };
  /**
   * 异步复制文本到剪贴板；浏览器拒绝访问时把错误反馈到侧栏，便于用户重新处理。
   * EN: Copy text asynchronously and surface clipboard-access failures in the sidebar for recovery.
   */
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setClipboardError('无法复制，请检查剪贴板权限后重试。');
    }
  };
  /**
   * 列表目标可能被截断；复制目标或据此新建前先读取完整运行头信息。
   * EN: List targets may be truncated; read complete run header before copying or deriving a new task.
   */
  async function fullObjective(run: RunListItem, action: (run: Run) => void | Promise<void>) {
    try {
      const full = await api<Run>(`/runs/${run.id}/header`);
      await action(full);
    } catch (issue) {
      setClipboardError(issue instanceof Error ? issue.message : '无法读取完整目标，请重试。');
    }
  }
  /**
   * 按目标类型构建菜单；原生入口中的旧终端记录只保留查看和本地标记操作。
   * EN: Build menu by target kind; legacy terminal records in native surface permit view/local markers only.
   */
  const actions = (target: Target): MenuAction[] => {
    const item = target.item;
    const common: MenuAction[] = [
      { label: '重命名', icon: 'edit', shortcut: 'Ctrl+Alt+R', /** 打开当前目标的改名输入框，实际版本校验和提交留给统一确认流程。 EN: Open rename input for the current target; the shared confirmation flow performs revision checks and submission. */ action: () => showDialog(target, 'rename') },
    ];
    if (target.kind === 'run') {
      const run = target.item;
      common.push(
        {
          label: flag(`pinned:run:${run.id}`) ? '取消置顶' : '置顶',
          icon: 'pin',
          shortcut: 'Ctrl+Alt+P',
          /**
           * 切换当前会话的置顶偏好，按会话标识保存，不改变服务端会话内容。
           * EN: Toggle the run-specific pin preference without changing the server-side conversation content.
           */
          action: () => setValue(`pinned:run:${run.id}`, !flag(`pinned:run:${run.id}`)),
        },
        {
          label: flag(`unread:run:${run.id}`) ? '标记为已读' : '标记为未读',
          icon: 'eye',
          shortcut: 'Ctrl+Shift+U',
          /**
           * 切换当前会话的未读偏好，使列表的未读标记与缓存保持一致。
           * EN: Toggle the run-specific unread preference so the sidebar marker follows cached state.
           */
          action: () => setValue(`unread:run:${run.id}`, !flag(`unread:run:${run.id}`)),
        },
        { label: '打开对话', icon: 'chat', /** 选择当前会话，通过父组件的导航流程处理详情切换和离开保护。 EN: Select the run through parent navigation, which handles detail switching and leave protection. */ action: () => selectRun(run) },
        {
          label: '以此目标新建',
          icon: 'plus',
          /**
           * 先读取完整目标再创建同项目的新会话，避免从列表截断摘要复制任务意图。
           * EN: Load the full objective before creating another run in the same project, avoiding truncated list projections.
           */
          action: () => void fullObjective(run, (full) => create(full.projectId || '', full.objective)),
        },
        { label: '复制名称', icon: 'copy', /** 复制当前会话标题或其目标回退文本，复用统一剪贴板错误处理。 EN: Copy the run title or objective fallback using the shared clipboard error handling. */ action: () => void copy(title(target)) },
        {
          label: '复制目标',
          icon: 'copy',
          /**
           * 先取得完整目标再复制，确保剪贴板包含原始任务要求而非列表摘要。
           * EN: Load the complete objective before copying so the clipboard receives the original request rather than a list summary.
           */
          action: () => void fullObjective(run, (full) => copy(full.objective)),
        },
      );
    } else {
      const project = target.item;
      common.push(
        { label: terminal ? '新建终端任务' : '新建项目对话', icon: 'plus', /** 在当前项目中新建会话，项目标识随动作传递以维持正确归属。 EN: Create a new conversation in the current project, carrying its ID to preserve ownership. */ action: () => create(project.id) },
        {
          label: flag(`collapsed:project:${project.id}`) ? '展开项目' : '收起项目',
          icon: 'chevron',
          /**
           * 切换当前项目的折叠偏好，并通过工作台缓存保存以便后续恢复。
           * EN: Toggle the project collapse preference through the workbench cache for later restoration.
           */
          action: () => setValue(`collapsed:project:${project.id}`, !flag(`collapsed:project:${project.id}`)),
        },
        { label: '浏览项目资料', icon: 'folder', /** 打开项目文件入口，交由父组件协调文件视图及导航状态。 EN: Open project files through the parent callback that coordinates the file view and navigation. */ action: () => files(project) },
        { label: '移动到项目空间', icon: 'grid', /** 为当前项目打开移动对话框，待用户选择目标空间后再提交。 EN: Open the project move dialog and defer submission until a destination space is selected. */ action: () => showDialog(target, 'move') },
        { label: '复制文件夹路径', icon: 'copy', /** 复制当前项目资料目录的完整路径，便于在外部工具中定位资料。 EN: Copy the complete project workspace path for locating its files in external tools. */ action: () => void copy(project.workspaceRoot) },
      );
    }
    common.push(
      {
        label: item.archived ? '恢复归档' : '归档',
        icon: 'archive',
        shortcut: 'Ctrl+Shift+A',
        /**
         * 翻转当前目标的归档状态，复用带版本检查的更新流程处理并发修改。
         * EN: Toggle archive state through the revision-checked update flow to handle concurrent edits.
         */
        action: () => void update(target, { archived: !item.archived }),
      },
      { label: '永久删除', icon: 'trash', danger: true, /** 打开永久删除确认，保持具体删除与版本核对集中在统一对话框流程。 EN: Open permanent-deletion confirmation, leaving deletion and revision validation to the shared dialog flow. */ action: () => showDialog(target, 'delete') },
    );
    return target.kind === 'run' && readOnlyRun(target.item)
      ? common.filter((action) => !['重命名', '归档', '恢复归档', '永久删除'].includes(action.label))
      : common;
  };
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const node = menuRef.current;
    const rect = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    node.querySelector<HTMLButtonElement>('button')?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    /**
     * 指针落在菜单外部时关闭菜单，点击菜单内部时保留当前交互。
     * EN: Dismiss the menu on outside pointer input while preserving interaction inside it.
     */
    const dismiss = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    /**
     * 滚动或窗口尺寸改变后关闭菜单，避免菜单继续停留在已失效的屏幕坐标。
     * EN: Close the menu after scrolling or resizing so it cannot remain at stale screen coordinates.
     */
    const resized = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('scroll', resized, true);
    window.addEventListener('resize', resized);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('scroll', resized, true);
      window.removeEventListener('resize', resized);
    };
  }, [menu]);
  useEffect(() => {
    if (busy) setMenu(null);
  }, [busy]);
  /**
   * 快捷键按当前菜单目标或所选实体执行；输入法、表单和任一可见弹窗活跃时完全让出。
   * EN: Keys use current menu/selection; IME/forms/visible dialogs take complete precedence.
   */
  useEffect(() => {
    /**
     * 处理侧栏改名、置顶、未读和归档快捷键。输入法、表单和可见对话框优先，旧终端只读限制同样适用，避免快捷键触发意外修改。
     * EN: Handle rename, pin, unread, and archive shortcuts while yielding to IME, form inputs, and visible dialogs; enforce legacy-terminal read-only restrictions.
     */
    const hotkey = (event: KeyboardEvent) => {
      if (
        busy ||
        dialog ||
        event.isComposing ||
        [...(surfaceRoot?.current || document).querySelectorAll<HTMLElement>('[role="dialog"]')].some(
          (node) => node.getClientRects().length && !node.closest('[inert]'),
        ) ||
        (event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]')
      )
        return;
      const run = runs.find((r) => r.id === runId);
      const project = projects.find((p) => p.id === projectId);
      const target: Target | undefined =
        menu?.target ||
        (run ? { kind: 'run', item: run } : project ? { kind: 'project', item: project } : undefined);
      if (!target) return;
      const key = event.key.toLowerCase();
      let action: (() => void) | undefined;
      if (
        event.ctrlKey &&
        event.altKey &&
        !event.shiftKey &&
        key === 'r' &&
        (target.kind !== 'run' || !readOnlyRun(target.item))
      )
        action = () => showDialog(target, 'rename');
      if (event.ctrlKey && event.altKey && !event.shiftKey && key === 'p' && target.kind === 'run')
        action = () => setValue(`pinned:run:${target.item.id}`, !flag(`pinned:run:${target.item.id}`));
      if (event.ctrlKey && event.shiftKey && !event.altKey && key === 'u' && target.kind === 'run')
        action = () => setValue(`unread:run:${target.item.id}`, !flag(`unread:run:${target.item.id}`));
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        key === 'a' &&
        (target.kind !== 'run' || !readOnlyRun(target.item))
      )
        action = () => void update(target, { archived: !target.item.archived });
      if (action) {
        event.preventDefault();
        setMenu(null);
        action();
      }
    };
    document.addEventListener('keydown', hotkey);
    return () => document.removeEventListener('keydown', hotkey);
  });
  /**
   * 绘制单条会话的选中、状态、未读、置顶与草稿信息，并同时提供鼠标和键盘菜单入口。
   * EN: Render a run row with selection, status, unread, pin, and draft indicators, plus mouse and keyboard menu access.
   */
  const runRow = (run: RunListItem, section = 'run') => (
    <div
      data-history-anchor={`${section}:${run.id}`}
      className={
        'session-row' +
        (run.id === runId ? ' selected' : '') +
        (flag(`unread:run:${run.id}`) ? ' unread' : '')
      }
      key={run.id}
      onContextMenu={(e) => openMenu(e, { kind: 'run', item: run })}
    >
      <button
        className="history-item"
        title={run.title || run.objective}
        aria-current={run.id === runId ? 'page' : undefined}
        onClick={() => selectRun(run)}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({
              target: { kind: 'run', item: run },
              x: rect.right,
              y: rect.bottom,
              trigger: e.currentTarget,
            });
          }
        }}
      >
        <span className={'status-dot ' + run.status.toLowerCase()} aria-hidden="true" />
        <span className="session-run-label">
          <span className="session-run-title">{run.title || run.objective}</span>
          <span className="session-run-meta">
            <small>
              {{
                DRAFT: '待开始',
                READY: '就绪',
                RUNNING: '执行中',
                WAITING: '等待',
                VERIFYING: '待验收',
                DONE: '已完成',
                FAILED: '失败',
                CANCELLED: '已取消',
              }[run.status] || '状态未知'}
            </small>
            {readOnlyRun(run) && <small>旧终端 · 只读</small>}
            {flag(`pinned:run:${run.id}`) && (
              <small>
                <Icon name="pin" size={12} />
                置顶
              </small>
            )}
            {typeof entries[`draft:run:${run.id}`]?.value === 'string' &&
              entries[`draft:run:${run.id}`].value && <small>草稿</small>}
            {flag(`unread:run:${run.id}`) && (
              <small>
                <i className="unread-dot" aria-hidden="true" />
                未读
              </small>
            )}
          </span>
        </span>
      </button>
      <button
        className="session-more"
        aria-label={`对话 ${run.title || run.objective} 的更多选项`}
        aria-haspopup="menu"
        disabled={busy}
        onClick={(e) => openMenu(e, { kind: 'run', item: run })}
      >
        <Icon name="more" size={16} />
      </button>
    </div>
  );
  /**
   * 绘制可折叠分组标题、计数和附加按钮；展开状态统一由缓存偏好驱动。
   * EN: Render a collapsible group heading, count, and optional actions with expansion controlled by cached preferences.
   */
  const heading = (key: string, label: string, count: number, extra?: React.ReactNode) => (
    <div className="side-heading session-heading">
      <button
        className="group-toggle"
        aria-expanded={!flag(`collapsed:${key}`)}
        onClick={() => setValue(`collapsed:${key}`, !flag(`collapsed:${key}`))}
      >
        <Icon name="chevron" size={13} />
        <span>{label}</span>
        <small>{count}</small>
      </button>
      {extra}
    </div>
  );
  return (
    <>
      <div className="session-navigation">
        <div className="session-search">
          <Icon name="search" size={15} />
          <input
            ref={searchInput}
            type="search"
            aria-label="搜索会话"
            maxLength={200}
            placeholder="搜索会话…"
            value={searchValue}
            onChange={(e) => (changeListQuery ? changeListQuery(e.target.value) : setSearch(e.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && searchValue && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                clearSearch();
              }
            }}
          />
          {!!searchValue && (
            <button
              type="button"
              className="session-search-clear"
              aria-label="清除会话搜索"
              title="清除会话搜索 · Esc"
              onClick={clearSearch}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
        {clipboardError && (
          <p className="session-error" role="alert" aria-label="会话操作失败详情" tabIndex={0}>
            {clipboardError}
          </p>
        )}
        <div
          className="session-tree"
          ref={treeRef}
          aria-busy={listBusy || undefined}
          onScroll={(event) => {
            const tree = event.currentTarget;
            const downward = tree.scrollTop > lastTreeScroll.current;
            lastTreeScroll.current = tree.scrollTop;
            treeAnchor.current = captureHistoryAnchor(tree);
            if (downward && performance.now() < treeIntentUntil.current) requestOlderList();
          }}
          onWheel={(event) => {
            if (event.deltaY <= 0) return;
            treeIntentUntil.current = performance.now() + 1000;
            requestOlderList();
          }}
          onPointerDown={() => {
            treeIntentUntil.current = performance.now() + 2000;
          }}
          onTouchStart={(event) => {
            touchY.current = event.touches[0]?.clientY || 0;
          }}
          onTouchMove={(event) => {
            const next = event.touches[0]?.clientY ?? touchY.current;
            if (next < touchY.current) {
              treeIntentUntil.current = performance.now() + 1000;
              requestOlderList();
            }
            touchY.current = next;
          }}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) return;
            treeIntentUntil.current = performance.now() + 1000;
            requestOlderList();
          }}
        >
          {!!pinned.length && (
            <section>
              {heading('pinned', '置顶', pinned.length)}
              {(!flag('collapsed:pinned') || query) && (
                <div>{pinned.map((run) => runRow(run, 'pinned'))}</div>
              )}
            </section>
          )}
          <section>
            {heading(
              'projects',
              '项目',
              activeProjects.length,
              <div className="heading-actions">
                <button aria-label="管理项目" title="管理项目" onClick={() => manage('projects')}>
                  <Icon name="more" size={16} />
                </button>
                <button aria-label="添加项目" title="添加项目" onClick={() => manage('new-project')}>
                  <Icon name="plus" size={15} />
                </button>
              </div>,
            )}
            {(!flag('collapsed:projects') || query) && (
              <nav className="project-list" aria-label="项目">
                {activeProjects.map((project) => {
                  const children = ordered(
                    visibleRuns.filter((r) => r.projectId === project.id && matches(r)),
                  );
                  if (query && !project.name.toLocaleLowerCase().includes(query) && !children.length)
                    return null;
                  const collapsed = flag(`collapsed:project:${project.id}`) && !query;
                  return (
                    <div className="project-group" key={project.id}>
                      <div
                        data-history-anchor={`project:${project.id}`}
                        className={'project-row' + (project.id === projectId ? ' selected' : '')}
                        onContextMenu={(e) => openMenu(e, { kind: 'project', item: project })}
                      >
                        <button
                          className="project-toggle"
                          aria-label={`${collapsed ? '展开' : '收起'}项目 ${project.name}`}
                          aria-expanded={!collapsed}
                          onClick={() => setValue(`collapsed:project:${project.id}`, !collapsed)}
                        >
                          <Icon name="chevron" size={13} />
                        </button>
                        <button
                          className="project-item"
                          title={project.name}
                          aria-current={project.id === projectId ? 'true' : undefined}
                          onClick={() => selectProject(project.id)}
                        >
                          <Icon name="folder" size={16} />
                          <span>{project.name}</span>
                          <small>{projectCount(project.id)}</small>
                        </button>
                        <button
                          className="session-more"
                          aria-label={`项目 ${project.name} 的更多选项`}
                          aria-haspopup="menu"
                          disabled={busy}
                          onClick={(e) => openMenu(e, { kind: 'project', item: project })}
                        >
                          <Icon name="more" size={16} />
                        </button>
                      </div>
                      {!collapsed && (
                        <div className="project-sessions">
                          {children.map((run) => runRow(run))}
                          {!children.length && (
                            <button className="empty-session" onClick={() => create(project.id)}>
                              <Icon name="plus" size={13} />
                              {terminal ? '新建终端任务' : '新建项目对话'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {!activeProjects.length && (
                  <button className="empty-project" onClick={() => manage('new-project')}>
                    打开本机文件夹 <Icon name="plus" size={14} />
                  </button>
                )}
              </nav>
            )}
          </section>
          {pendingProjectRuns.length > 0 && (
            <section aria-label="项目对话">
              {heading('pending-projects', '项目对话', pendingProjectRuns.length)}
              {(!flag('collapsed:pending-projects') || query) && (
                <div className="history-list">{pendingProjectRuns.map((run) => runRow(run))}</div>
              )}
            </section>
          )}
          {!terminal && (
            <section>
              {heading(
                'chats',
                '独立对话',
                chats.length,
                <button aria-label="新建独立对话" title="新建独立对话" onClick={() => create('')}>
                  <Icon name="plus" size={15} />
                </button>,
              )}
              {(!flag('collapsed:chats') || query) && (
                <div className="history-list">
                  {chats.map((run) => runRow(run))}
                  {!chats.length && (
                    <p className="sidebar-muted">{query ? '没有匹配的独立对话' : '从一个问题开始对话。'}</p>
                  )}
                </div>
              )}
            </section>
          )}
          {query &&
            !visibleRuns.some(matches) &&
            !activeProjects.some((p) => p.name.toLocaleLowerCase().includes(query)) && (
              <p className="sidebar-muted">没有匹配的项目或会话。</p>
            )}
        </div>
        {listReadCoverage && !listReadCoverage.complete && (
          <div className="session-pagination" role="status">
            <span>{listReadCoverage.unavailable} 个会话暂不可读取，列表和计数可能不完整。</span>
            {inspectUnreadable && <button onClick={inspectUnreadable}>在任务中心检查</button>}
          </div>
        )}
        {listPage && listNavigate && (listPage.total > 0 || listBusy || listError) && (
          <nav className="session-pagination" aria-label="会话列表分页">
            <span role="status">
              {listBusy
                ? '读取会话…'
                : `${listDynamic ? '已载入' : '本页'} ${runs.length} / ${listReadCoverage && !listReadCoverage.complete ? '已知' : '共'} ${listPage.total} 个会话`}
            </span>
            {listError && (
              <span className="session-error" role="alert" aria-label="会话列表读取失败详情" tabIndex={0}>
                {listError}
              </span>
            )}
            {listWindowLimited && <span>已达本段上限，可点击加载更早会话继续。</span>}
            <div>
              {!listDynamic && (
                <button disabled={busy || listBusy || !listTrail} onClick={() => listNavigate('newer')}>
                  更新会话
                </button>
              )}
              {(!listDynamic || listPage.nextBefore || listError || listBusy) && (
                <button
                  disabled={busy || listBusy || !listPage.nextBefore}
                  onClick={() => listNavigate('older')}
                >
                  {listError ? '重试加载' : listDynamic ? '加载更早会话' : '更早会话'}
                </button>
              )}
              {(listPage.before || (listDynamic && (listTrail || listWindowLimited))) && (
                <button disabled={busy || listBusy} onClick={() => listNavigate('latest')}>
                  返回最新
                </button>
              )}
            </div>
          </nav>
        )}
      </div>
      {menu &&
        createPortal(
          <div
            className="session-context-menu"
            ref={menuRef}
            style={{ left: menu.x, top: menu.y }}
            role="menu"
            aria-label={title(menu.target) + ' 的菜单'}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'Tab') {
                if (event.key === 'Escape') event.preventDefault();
                closeMenu(true);
                return;
              }
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              let next: number | undefined;
              if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
              if (event.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length;
              if (event.key === 'Home') next = 0;
              if (event.key === 'End') next = buttons.length - 1;
              if (next !== undefined) {
                event.preventDefault();
                buttons[next]?.focus();
              }
            }}
          >
            {actions(menu.target).map((action) => (
              <button
                key={action.label}
                role="menuitem"
                className={action.danger ? 'danger' : ''}
                onClick={() => {
                  closeMenu(true);
                  action.action();
                }}
              >
                <Icon name={action.icon} size={17} />
                <span>{action.label}</span>
                {action.shortcut && <kbd>{action.shortcut}</kbd>}
              </button>
            ))}
          </div>,
          surfaceRoot?.current || document.body,
        )}
      {dialog &&
        createPortal(
          <Modal
            className="session-dialog"
            title={
              dialog.action === 'rename'
                ? `重命名${dialog.target.kind === 'project' ? '项目' : '对话'}`
                : dialog.action === 'move'
                  ? '移动项目空间'
                  : `永久删除${dialog.target.kind === 'project' ? '项目' : '对话'}？`
            }
            close={closeDialog}
            busy={busy}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                /**
                 * 固定提交时的弹窗实例，异步结果不能关闭后来为另一个目标打开的新弹窗。
                 * EN: Freeze submitting dialog identity; async success cannot close a newer dialog for another target.
                 */
                const submitted = dialog;
                if (!canSubmitDialog || dialogRef.current !== submitted) return;
                void update(
                  dialog.target,
                  dialog.action === 'rename'
                    ? { [dialog.target.kind === 'project' ? 'name' : 'title']: dialog.value.trim() }
                    : dialog.action === 'move'
                      ? { spaceId: dialog.value }
                      : dialog.target.kind === 'project' &&
                          !terminal &&
                          archiveConsent?.projectId === dialog.target.item.id
                        ? { expectedArchiveSetHash: archiveConsent.setHash }
                        : {},
                  dialog.action === 'delete',
                ).then((result) => {
                  if (result === false || dialogRef.current !== submitted) return;
                  if (result === 'conflict' && submitted.action === 'delete') return;
                  const key = draftKey(submitted.target, submitted.action);
                  /**
                   * 版本冲突保留重命名/移动文字，删除则留在原确认流程要求重新核对。
                   * EN: Keep rename/move text on conflict; deletion stays in confirmation for renewed review.
                   */
                  if (result === 'conflict' && submitted.action !== 'delete')
                    conflictDrafts.current.set(key, submitted.value);
                  else conflictDrafts.current.delete(key);
                  dialogRef.current = null;
                  setDialog(null);
                });
              }}
            >
              <div className="form-body">
                {error && (
                  <p className="session-error" role="alert" aria-label="保存失败详情" tabIndex={0}>
                    {error}
                  </p>
                )}
                {dialog.action !== 'rename' && (
                  <div className="session-dialog-target">
                    <span>{dialog.target.kind === 'project' ? '项目名称' : '对话名称'}</span>
                    <p role="region" aria-label="完整操作对象名称" tabIndex={0}>
                      {title(dialog.target)}
                    </p>
                  </div>
                )}
                {dialog.action === 'rename' && (
                  <label className="session-dialog-field">
                    名称
                    <input
                      autoFocus
                      maxLength={dialog.target.kind === 'project' ? 80 : 160}
                      value={dialog.value}
                      disabled={busy}
                      onChange={(e) => changeDialogValue(dialog, e.target.value)}
                    />
                  </label>
                )}
                {dialog.action === 'move' && (
                  <>
                    <label className="session-dialog-field">
                      目标空间
                      <select
                        value={dialog.value}
                        disabled={busy}
                        onChange={(e) => changeDialogValue(dialog, e.target.value)}
                      >
                        {!spaces.some((space) => space.id === dialog.value) && (
                          <option value={dialog.value} disabled>
                            原目标空间已不存在，请重新选择
                          </option>
                        )}
                        {spaces.map((space) => (
                          <option key={space.id} value={space.id}>
                            {space.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {spaces.some((space) => space.id === dialog.value) && (
                      <p
                        className="field-help session-space-name"
                        role="region"
                        aria-label="已选空间完整名称"
                        tabIndex={0}
                      >
                        已选空间：{spaces.find((space) => space.id === dialog.value)?.name}
                      </p>
                    )}
                  </>
                )}
                {dialog.action === 'delete' && (
                  <>
                    <p>
                      {dialog.target.kind === 'project'
                        ? `此项目及${projectCounts ? `其 ${projectCount(dialog.target.item.id)} 个` : '关联'}对话、消息和产物登记将被永久删除。`
                        : '此对话、消息、调用和产物登记将被永久删除。'}
                      无法恢复，原始项目资料目录会保留。
                      {dialog.target.kind === 'project' &&
                        localSurface === 'native' &&
                        '项目交付计划、冻结清单和已保存文件包也会删除，请先导出需要保留的内容。'}
                    </p>
                    {dialog.target.kind === 'project' && !terminal && (
                      <ProjectArchiveDeleteNotice
                        key={dialog.target.item.id}
                        projectId={dialog.target.item.id}
                        disabled={busy}
                        onConsent={setArchiveConsent}
                      />
                    )}
                  </>
                )}
              </div>
              <footer className="modal-footer">
                <button type="button" className="secondary" disabled={busy} onClick={closeDialog}>
                  {dialog.action === 'delete' ? '保留' : '取消'}
                </button>
                <button
                  className={'primary' + (dialog.action === 'delete' ? ' danger-confirm' : '')}
                  disabled={!canSubmitDialog}
                >
                  {busy ? '正在保存…' : dialog.action === 'delete' ? '确认永久删除' : '保存'}
                </button>
              </footer>
            </form>
          </Modal>,
          surfaceRoot?.current || document.body,
        )}
    </>
  );
}
