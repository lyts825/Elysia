/**
 * 保存、读取并解析工作区导航状态。
 * 按工作台作用域恢复空间、项目和会话选择，并在当前目录中重新解析有效目标；浏览器保存失败不阻止导航。
 * EN: Saves, restores, and resolves workspace navigation. Restores space/project/run selections by workbench scope and resolves them again against current catalogs; browser persistence failure does not block navigation.
 */
import type { Project, ProjectSpace, Run } from '../../../packages/contracts/src/index';
import { defaultSurfaceClient, type SurfaceClient } from './api';

export type NavigationState = { spaceId: string; projectId: string; runId: string };
export const initialNavigation: NavigationState = { spaceId: 'default', projectId: '', runId: '' };

/**
 * 认证选择范围与入口共同生成存储键；范围未知时不恢复或写入导航。
 * EN: Key navigation by authentication scope and surface; do not restore/write before scope is known.
 */
export function navigationKey(scope: string | undefined, client: SurfaceClient = defaultSurfaceClient) {
  return scope ? client.surfaceStorageKey(`elysia.navigation.v1:${scope}`) : undefined;
}

/**
 * 从指定sessionStorage键恢复有限长度的导航标识；缺少键、损坏结构或浏览器存储异常时返回undefined。
 * EN: Restores bounded navigation identifiers from a sessionStorage key, returning undefined for an absent key, malformed data, or storage failure.
 */
export function readNavigation(key: string | undefined): NavigationState | undefined {
  /**
   * 恢复时仅接受长度有界的字符串字段，损坏或不可用的存储直接忽略。
   * EN: Restore bounded string fields only and ignore corrupt/unavailable storage.
   */
  if (!key) return;
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (
      value &&
      ['spaceId', 'projectId', 'runId'].every(
        (field) => typeof value[field] === 'string' && value[field].length <= 200,
      )
    )
      return { spaceId: value.spaceId, projectId: value.projectId, runId: value.runId };
  } catch {
    /**
     * 存储不可用时，导航仍可工作但不持久保存。
     * EN: Storage may be unavailable; navigation still works without persistence.
     */
  }
}

/**
 * 尽力保存当前导航选择；缺少作用域键时跳过，存储配额或权限失败不阻止导航操作。
 * EN: Best-effort persists the current navigation choice, skipping an absent scope key and tolerating quota or permission failures without blocking navigation.
 */
export function writeNavigation(key: string | undefined, value: NavigationState) {
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /**
     * 禁用或已满的会话存储不能阻止导航。
     * EN: A disabled or full session store must not block navigation.
     */
  }
}

/**
 * 把缓存选择解析为当前可访问的空间、项目和运行。运行必须归属有效项目，聊天则脱离项目；
 * 恢复旧导航时排除归档项，普通刷新可保留用户当前正在查看的归档记录。
 * EN: Resolve cache against accessible spaces/projects/runs. Runs require valid project ownership, while chat is projectless. Exclude archived entries during restoration; refresh may retain an archived record already being viewed.
 */
export function resolveNavigation(
  value: NavigationState,
  projects: Project[],
  runs: Pick<Run, 'id' | 'kind' | 'projectId' | 'archived'>[],
  spaces: ProjectSpace[],
  restoring = false,
): NavigationState {
  /**
   * 先验证空间和项目，再验证运行归属；恢复时不重新选择已归档实体。
   * EN: Validate space/project before run ownership; restore does not reselect archived entities.
   */
  const spaceId = spaces.some((space) => space.id === value.spaceId)
    ? value.spaceId
    : spaces.find((space) => space.protected)?.id || spaces[0]?.id || 'default';
  /**
   * 在当前项目和空间目录中解析项目ID；恢复模式排除归档项，防止恢复到已失效的父级。
   * EN: Resolves a project ID against the current project and space catalogs, excluding archived projects during restoration to avoid an invalid parent selection.
   */
  const validProject = (id: string | null | undefined) =>
    projects.find(
      (project) =>
        project.id === id &&
        (!restoring || !project.archived) &&
        spaces.some((space) => space.id === project.spaceId),
    );
  const project = validProject(value.projectId);
  const fallback = { spaceId: project?.spaceId || spaceId, projectId: project?.id || '', runId: '' };
  const run = runs.find((run) => run.id === value.runId && (!restoring || !run.archived));
  if (!run) return fallback;
  if (run.kind === 'chat') return { spaceId, projectId: '', runId: run.id };
  const owner = validProject(run.projectId);
  return owner ? { spaceId: owner.spaceId, projectId: owner.id, runId: run.id } : fallback;
}
