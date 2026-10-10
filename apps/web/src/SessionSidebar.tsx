import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project, ProjectSpace, Run } from '../../../packages/contracts/src/index';
import { Icon } from './Icon';
import { Modal } from './Modal';
import type { CacheEntry } from './WorkbenchCache';
import './sessions.css';
import { useSurfaceClient, useSurfaceRoot } from './SurfaceClientContext';

type Target = { kind: 'project'; item: Project } | { kind: 'run'; item: Run };
export type SessionTarget = Target;
export type SessionUpdateResult = boolean | 'conflict';
type Dialog = { target: Target; action: 'rename' | 'delete' | 'move'; value: string };
type MenuAction = { label: string; icon: string; shortcut?: string; danger?: boolean; action: () => void };
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
}: {
  projects: Project[];
  spaces: ProjectSpace[];
  runs: Run[];
  spaceId: string;
  projectId: string;
  runId: string;
  entries: Record<string, CacheEntry>;
  busy: boolean;
  error: string;
  setValue: (key: string, value: string | boolean) => void;
  selectProject: (id: string) => void;
  selectRun: (run: Run) => void;
  create: (projectId: string, objective?: string) => void;
  files: (project: Project) => void;
  manage: (tab: string) => void;
  update: (
    target: Target,
    changes: Record<string, unknown>,
    remove?: boolean,
  ) => Promise<SessionUpdateResult>;
}) {
  const { surface: localSurface } = useSurfaceClient();
  const surfaceRoot = useSurfaceRoot();
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<{ target: Target; x: number; y: number; trigger: HTMLElement } | null>(
    null,
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const dialogRef = useRef<Dialog | null>(null);
  const conflictDrafts = useRef(new Map<string, string>());
  dialogRef.current = dialog;
  const [clipboardError, setClipboardError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const flag = (key: string) => entries[key]?.value === true;
  const terminal = localSurface === 'terminal';
  const readOnlyRun = (run: Run) => !terminal && run.execution?.kind === 'docker-agent';
  const title = (target: Target) =>
    target.kind === 'project' ? target.item.name : target.item.title || target.item.objective;
  const query = search.trim().toLocaleLowerCase();
  const matches = (run: Run) => `${run.title} ${run.objective}`.toLocaleLowerCase().includes(query);
  const activeProjects = projects.filter((p) => !p.archived && p.spaceId === spaceId);
  const visibleRuns = runs.filter(
    (r) =>
      !r.archived &&
      (!terminal || r.kind === 'task') &&
      (r.kind === 'chat' || activeProjects.some((p) => p.id === r.projectId)),
  );
  const ordered = (list: Run[]) => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pinned = ordered(visibleRuns.filter((r) => flag(`pinned:run:${r.id}`) && matches(r)));
  const chats = ordered(visibleRuns.filter((r) => r.kind === 'chat' && matches(r)));
  const closeMenu = (restore = false) => {
    if (restore && menu?.trigger.isConnected) menu.trigger.focus({ preventScroll: true });
    setMenu(null);
  };
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
  const draftKey = (target: Target, action: Dialog['action']) => `${target.kind}:${target.item.id}:${action}`;
  const closeDialog = () => {
    if (dialogRef.current)
      conflictDrafts.current.delete(draftKey(dialogRef.current.target, dialogRef.current.action));
    dialogRef.current = null;
    setDialog(null);
  };
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
        : true);
  const showDialog = (target: Target, action: Dialog['action']) => {
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
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setClipboardError('无法复制，请检查剪贴板权限后重试。');
    }
  };
  const actions = (target: Target): MenuAction[] => {
    const item = target.item;
    const common: MenuAction[] = [
      { label: '重命名', icon: 'edit', shortcut: 'Ctrl+Alt+R', action: () => showDialog(target, 'rename') },
    ];
    if (target.kind === 'run') {
      const run = target.item;
      common.push(
        {
          label: flag(`pinned:run:${run.id}`) ? '取消置顶' : '置顶',
          icon: 'pin',
          shortcut: 'Ctrl+Alt+P',
          action: () => setValue(`pinned:run:${run.id}`, !flag(`pinned:run:${run.id}`)),
        },
        {
          label: flag(`unread:run:${run.id}`) ? '标记为已读' : '标记为未读',
          icon: 'eye',
          shortcut: 'Ctrl+Shift+U',
          action: () => setValue(`unread:run:${run.id}`, !flag(`unread:run:${run.id}`)),
        },
        { label: '打开对话', icon: 'chat', action: () => selectRun(run) },
        { label: '以此目标新建', icon: 'plus', action: () => create(run.projectId || '', run.objective) },
        { label: '复制名称', icon: 'copy', action: () => void copy(title(target)) },
        { label: '复制目标', icon: 'copy', action: () => void copy(run.objective) },
      );
    } else {
      const project = target.item;
      common.push(
        { label: terminal ? '新建终端任务' : '新建项目对话', icon: 'plus', action: () => create(project.id) },
        {
          label: flag(`collapsed:project:${project.id}`) ? '展开项目' : '收起项目',
          icon: 'chevron',
          action: () => setValue(`collapsed:project:${project.id}`, !flag(`collapsed:project:${project.id}`)),
        },
        { label: '浏览项目资料', icon: 'folder', action: () => files(project) },
        { label: '移动到项目空间', icon: 'grid', action: () => showDialog(target, 'move') },
        { label: '复制文件夹路径', icon: 'copy', action: () => void copy(project.workspaceRoot) },
      );
    }
    common.push(
      {
        label: item.archived ? '恢复归档' : '归档',
        icon: 'archive',
        shortcut: 'Ctrl+Shift+A',
        action: () => void update(target, { archived: !item.archived }),
      },
      { label: '永久删除', icon: 'trash', danger: true, action: () => showDialog(target, 'delete') },
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
    const dismiss = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
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
  useEffect(() => {
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
  const runRow = (run: Run) => (
    <div
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
        <span className={'status-dot ' + run.status.toLowerCase()} />
        <span>{run.title || run.objective}</span>
        {readOnlyRun(run) && <small>旧终端 · 只读</small>}
        {flag(`pinned:run:${run.id}`) && <Icon name="pin" size={12} />}
        {typeof entries[`draft:run:${run.id}`]?.value === 'string' &&
          entries[`draft:run:${run.id}`].value && <small>草稿</small>}
        {flag(`unread:run:${run.id}`) && <i className="unread-dot" aria-label="未读" />}
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
            type="search"
            aria-label="搜索会话"
            placeholder="搜索会话…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {clipboardError && (
          <p className="sidebar-muted" role="alert">
            {clipboardError}
          </p>
        )}
        <div className="session-tree">
          {!!pinned.length && (
            <section>
              {heading('pinned', '置顶', pinned.length)}
              {(!flag('collapsed:pinned') || query) && <div>{pinned.map(runRow)}</div>}
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
                          <small>{children.length}</small>
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
                          {children.map(runRow)}
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
                  {chats.map(runRow)}
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
            title={
              dialog.action === 'rename'
                ? `重命名${dialog.target.kind === 'project' ? '项目' : '对话'}`
                : dialog.action === 'move'
                  ? '移动项目空间'
                  : `永久删除「${title(dialog.target)}」？`
            }
            close={closeDialog}
            busy={busy}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const submitted = dialog;
                if (!canSubmitDialog || dialogRef.current !== submitted) return;
                void update(
                  dialog.target,
                  dialog.action === 'rename'
                    ? { [dialog.target.kind === 'project' ? 'name' : 'title']: dialog.value.trim() }
                    : dialog.action === 'move'
                      ? { spaceId: dialog.value }
                      : {},
                  dialog.action === 'delete',
                ).then((result) => {
                  if (result === false || dialogRef.current !== submitted) return;
                  const key = draftKey(submitted.target, submitted.action);
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
                  <p className="inline-warning" role="alert">
                    {error}
                  </p>
                )}
                {dialog.action === 'rename' && (
                  <label>
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
                  <label>
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
                )}
                {dialog.action === 'delete' && (
                  <p>
                    {dialog.target.kind === 'project'
                      ? `此项目及其 ${runs.filter((r) => r.projectId === dialog.target.item.id).length} 个对话、消息和产物登记将被永久删除。`
                      : '此对话、消息、调用和产物登记将被永久删除。'}
                    无法恢复，原始项目资料目录会保留。
                  </p>
                )}
              </div>
              <footer>
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
