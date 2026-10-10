import type { Project, ProjectSpace, Run } from '../../../packages/contracts/src/index';
import { defaultSurfaceClient, type SurfaceClient } from './api';

export type NavigationState = { spaceId: string; projectId: string; runId: string };
export const initialNavigation: NavigationState = { spaceId: 'default', projectId: '', runId: '' };

export function navigationKey(scope: string | undefined, client: SurfaceClient = defaultSurfaceClient) {
  return scope ? client.surfaceStorageKey(`elysia.navigation.v1:${scope}`) : undefined;
}

export function readNavigation(key: string | undefined): NavigationState | undefined {
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
    // Storage may be unavailable; navigation still works without persistence.
  }
}

export function writeNavigation(key: string | undefined, value: NavigationState) {
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A disabled or full session store must not block navigation.
  }
}

export function resolveNavigation(
  value: NavigationState,
  projects: Project[],
  runs: Run[],
  spaces: ProjectSpace[],
  restoring = false,
): NavigationState {
  const spaceId = spaces.some((space) => space.id === value.spaceId)
    ? value.spaceId
    : spaces.find((space) => space.protected)?.id || spaces[0]?.id || 'default';
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
