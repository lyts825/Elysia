/**
 * 注册模型路由配置接口。
 * 读写项目角色到模型的路由，写入受版本/可变性约束；配置只影响后续冻结，既有代理继续使用自己的绑定。
 * EN: Registers model-routing configuration endpoints. Reads/writes revision-guarded project role routing for future freezing while existing agents retain bindings.
 */
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

/**
 * 管理项目当前角色路由策略，读取视图只返回连接的可选能力摘要。 保存以独立路由 revision 做并发校验且经过项目可变性守卫；已有任务的冻结绑定保持原身份。
 * EN: Manages current project role routing with read views exposing only selectable capability summaries. Writes use independent routing revisions and project-mutability guards; existing tasks retain frozen binding identity.
 */
export function registerModelRouting(
  app: FastifyInstance,
  store: Store,
  assertMutable: (runId: string | null, projectId?: string | null) => void,
) {
  /**
   * 先确认项目存在，再组合角色路由和未归档模型的公开选择信息；verified 仅表示保存版本一致。
   * EN: Requires the project then combines role routing with public non-archived model choices; verified means matching saved revision only.
   */
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
