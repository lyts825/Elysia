/** 注册模型路由配置接口。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  Command,
  invariant,
  type Project,
  type ProviderConfig,
} from '../../../packages/contracts/src/index.js';
import { RoleRoutingPolicy, type RoleRoutingView } from '../../../packages/contracts/src/model-routing.js';
import { readRoleRouting, saveRoleRouting } from '../../../packages/kernel/src/model-routing.js';
import type { Store } from '../../../packages/storage/src/index.js';

/** 注册项目角色模型路由的读取和保存接口，变更前检查项目可写状态。 */
export function registerModelRouting(
  app: FastifyInstance,
  store: Store,
  assertMutable: (runId: string | null, projectId?: string | null) => void,
) {
  const view = (projectId: string): RoleRoutingView => {
    store.require<Project>('projects', projectId);
    return {
      ...readRoleRouting(store, projectId),
      providers: store
        .all<ProviderConfig>('providers')
        .filter((p) => !p.archived)
        .map((p) => ({
          id: p.id,
          label: p.label,
          model: p.model,
          contextLimit: p.contextLimit,
          verified: p.checkedRevision === p.revision,
          priceKnown: p.prices !== null,
          currency: p.prices?.currency ?? null,
        })),
    };
  };
  app.get<{ Params: { id: string } }>('/api/projects/:id/model-routing', (request) =>
    view(z.string().uuid().parse(request.params.id)),
  );
  app.put<{ Params: { id: string } }>('/api/projects/:id/model-routing', (request) => {
    const projectId = z.string().uuid().parse(request.params.id);
    const body = Command.extend({
      expectedRevision: z.number().int().nonnegative(),
      policy: RoleRoutingPolicy,
    })
      .strict()
      .parse(request.body);
    return store.command(body.commandId, { route: `/projects/${projectId}/model-routing`, body }, () => {
      const project = store.require<Project>('projects', projectId);
      assertMutable(null, projectId);
      invariant(!project.archived, 'PROJECT_ARCHIVED', '请先恢复已归档的项目');
      saveRoleRouting(store, projectId, body.expectedRevision, body.policy);
      return view(projectId);
    });
  });
}
