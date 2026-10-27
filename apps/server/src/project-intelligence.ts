/** 注册项目智能信息相关接口。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PROJECT_INTELLIGENCE_LIMITS,
  ProjectCapabilitySelection,
  ProjectMemoryContent,
  ProjectMemoryUpdate,
} from '../../../packages/contracts/src/project-intelligence.js';
import type { Store } from '../../../packages/storage/src/index.js';
import {
  createProjectMemory,
  listProjectMemories,
  projectIntelligenceView,
  requireIntelligenceProject,
  updateProjectIntelligence,
  updateProjectMemory,
} from '../../../packages/context/src/project-intelligence.js';

/** Register only in the native API. The terminal surface deliberately has no matching routes. */
/**
 * 原生项目能力/记忆管理入口。所有写入经过项目可变性守卫和幂等命令，更新携带各自版本。
 * 这里修改项目当前配置；已有运行使用创建时冻结的能力快照，不因后续编辑自动获得新资料。
 */
export function registerProjectIntelligenceRoutes(
  app: FastifyInstance,
  store: Store,
  assertMutable: (runId: string | null, projectId?: string) => void,
  surface: 'native' | 'terminal' = 'native',
) {
  if (surface !== 'native') return;
  const params = z.object({ id: z.string().uuid() });
  const command = z.object({ commandId: z.string().uuid() });
  const mutable = (projectId: string) => {
    requireIntelligenceProject(store, projectId);
    assertMutable(null, projectId);
  };
  app.get('/api/projects/:id/intelligence', (request) =>
    projectIntelligenceView(store, params.parse(request.params).id),
  );
  app.put('/api/projects/:id/intelligence', (request) => {
    const { id } = params.parse(request.params);
    const body = ProjectCapabilitySelection.extend({
      commandId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
      .strict()
      .parse(request.body);
    return store.command(body.commandId, { route: `/projects/${id}/intelligence`, body }, () => {
      mutable(id);
      updateProjectIntelligence(store, id, body.expectedRevision, {
        builtinSkillIds: body.builtinSkillIds,
        localItemIds: body.localItemIds,
      });
      return projectIntelligenceView(store, id);
    });
  });
  app.get('/api/projects/:id/memories', (request) => {
    const { id } = params.parse(request.params);
    return { projectId: id, memories: listProjectMemories(store, id), limits: PROJECT_INTELLIGENCE_LIMITS };
  });
  app.post('/api/projects/:id/memories', (request) => {
    const { id } = params.parse(request.params);
    const body = ProjectMemoryContent.extend({ commandId: z.string().uuid() }).strict().parse(request.body);
    return store.command(body.commandId, { route: `/projects/${id}/memories`, body }, () => {
      mutable(id);
      const { commandId: _, ...content } = body;
      return createProjectMemory(store, id, content);
    });
  });
  app.put('/api/projects/:id/memories/:memoryId', (request) => {
    const { id, memoryId } = params.extend({ memoryId: z.string().uuid() }).parse(request.params);
    const body = command
      .extend({
        expectedRevision: z.number().int().positive(),
        ...ProjectMemoryContent.partial().shape,
        restoreRevision: z.number().int().positive().optional(),
      })
      .strict()
      .parse(request.body);
    const { commandId, expectedRevision, ...rawChanges } = body;
    const changes = ProjectMemoryUpdate.parse(rawChanges);
    return store.command(commandId, { route: `/projects/${id}/memories/${memoryId}`, body }, () => {
      mutable(id);
      return updateProjectMemory(store, id, memoryId, expectedRevision, changes);
    });
  });
}
