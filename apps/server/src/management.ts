/**
 * 注册管理功能的服务端接口。
 * 协调项目/运行/空间的归档、删除、恢复与迁移，等待宿主停止并持有删除锁；保存包集合确认使用完整哈希而非数量。
 * EN: Registers server management endpoints. Coordinates archive/delete/restore/space moves with host shutdown and deletion locks; saved-archive acknowledgement binds full set hashes rather than counts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  Command,
  invariant,
  type ProjectSpace,
  type Project,
  type Run,
} from '../../../packages/contracts/src/index.js';
import { Store, id, hash, stable } from '../../../packages/storage/src/index.js';
import { Kernel } from '../../../packages/kernel/src/index.js';
import { NativeExecutor } from '../../../packages/runtime/src/index.js';
import { projectDeliveryArchiveSummary } from './project-delivery-archive.js';

const mutation = Command.extend({ expectedRevision: z.number().int().nonnegative() });
/**
 * 注册项目、运行和空间的管理操作；写入检查版本并协调执行器及事件流。
 * EN: Registers project, run, and space management, checking write revisions and coordinating executors and event streams.
 */
export function registerManagement(
  app: FastifyInstance,
  store: Store,
  kernel: Kernel<Store>,
  executor: NativeExecutor,
  closeStreams: (runId: string) => void,
  deletedProject?: (projectId: string) => void,
) {
  const deleting = new Set<string>();
  /**
   * 拒绝修改正在删除的运行或项目；该进程内门防止等待宿主停止期间发生并发写入。
   * EN: Rejects mutations of runs/projects being deleted, guarding concurrent writes while host shutdown is awaited.
   */
  const assertMutable = (runId?: string | null, projectId?: string | null) => {
    invariant(
      (!runId || !deleting.has('run:' + runId)) && (!projectId || !deleting.has('project:' + projectId)),
      'DELETE_IN_PROGRESS',
      '正在删除，请等待操作完成',
    );
  };
  /**
   * 核对覆盖式管理命令的实体版本，冲突携带当前版本返回 409。
   * EN: Checks entity revisions for replacement management commands and returns 409 with current revision on conflict.
   */
  const revision = (body: { expectedRevision: number }, entity: { revision: number }) => {
    if (body.expectedRevision !== entity.revision)
      throw new AppError(
        'REVISION_CONFLICT',
        '记录已更新，请刷新后重试',
        false,
        { currentRevision: entity.revision },
        409,
      );
  };
  /**
   * 将路由及原始正文绑定到 commandId，由存储提供幂等事务与结果重放。
   * EN: Binds route/body to commandId and delegates idempotent transactions/result replay to storage.
   */
  const command = <T>(body: any, route: string, work: () => T) =>
    store.command(body.commandId, { route, body }, work);
  /**
   * 以完整交付包集合哈希核对用户删除确认；集合变化或未确认时拒绝项目删除并返回当前摘要。
   * EN: Checks deletion acknowledgement against the complete archive-set hash; changed/unacknowledged sets block project deletion with current summary.
   */
  const acknowledgeArchives = (projectId: string, expected?: string) => {
    /**
     * 项目删除会影响已保存交付包，必须绑定用户查看过的完整集合哈希，不能只核对数量。
     * EN: Project deletion affects saved delivery archives and must bind the full set hash the user reviewed, not just a count.
     */
    const summary = projectDeliveryArchiveSummary(store, projectId);
    if ((summary.count > 0 || expected !== undefined) && expected !== summary.setHash)
      throw new AppError(
        'PROJECT_DELIVERY_ARCHIVES_CHANGED',
        '项目已保存的交付包尚未确认或已经变化，请查看、导出并重新确认删除',
        false,
        { archiveCount: summary.count, totalBytes: summary.totalBytes, setHash: summary.setHash },
        409,
      );
  };
  /**
   * 防止并发重试两次中断或删除同一活动对话。
   * EN: Prevent concurrent retries from interrupting/deleting the same running conversation twice.
   */
  const pending = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  /**
   * 删除生命周期先占用进程内实体锁并暂停/取消运行，再等待实际执行停止，最后幂等删除。 同一命令并发重试共享 Promise，避免两次中断或一方清理另一方仍使用的数据。
   * EN: Deletion first takes an in-process entity lock, pauses/cancels the run, waits for actual execution to stop, then deletes idempotently. Concurrent retries share a promise, avoiding duplicate interrupts or cleaning data still used by another attempt.
   */
  const lifecycle = async (
    body: any,
    route: string,
    prepare: (lock: (key: string) => void) => string[],
    finish: () => unknown,
  ) => {
    const payload = { route, body },
      fingerprint = hash(stable(payload));
    const old = store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId);
    if (old) return store.command(body.commandId, payload, finish);
    const current = pending.get(body.commandId);
    if (current) {
      invariant(current.fingerprint === fingerprint, 'COMMAND_REUSE', '同一命令 ID 不得用于不同内容');
      return current.result;
    }
    const held: string[] = [];
    /**
     * 占用一个唯一删除键并记录本次持有集合，重复占用抛错供 finally 统一释放。
     * EN: Acquires a unique deletion key and records ownership for finally cleanup; duplicate acquisition throws.
     */
    const lock = (key: string) => {
      invariant(!deleting.has(key), 'DELETE_IN_PROGRESS', '正在删除，请等待操作完成');
      deleting.add(key);
      held.push(key);
    };
    const result = (async () => {
      const runs = store.tx(() => prepare(lock));
      await Promise.all(runs.map((runId) => executor.interrupt(runId)));
      return command(body, route, finish);
    })().finally(() => {
      pending.delete(body.commandId);
      for (const key of held) deleting.delete(key);
    });
    pending.set(body.commandId, { fingerprint, result });
    return result;
  };
  /**
   * 归档暂停保留已有计划/提问等待原因，恢复归档后仍能继续原来的用户决定。
   * EN: Archival pauses preserve pending plan/question reasons so restoring the archive retains the original user decision.
   */
  const pauseKeepingDecision = (runId: string) => {
    const run = store.require<Run>('runs', runId);
    kernel.action(runId, 'pause');
    /**
     * 归档不能把待接受计划或待答问题改成普通暂停， 恢复归档后仍显示相同决定并允许接受该计划。
     * EN: Archival must not replace a pending plan/question with a generic pause: restoring the archive should still show the same decision and allow accepting that plan.
     */
    if ((run.status === 'WAITING' && run.reason !== 'rate_limit') || run.status === 'FAILED')
      kernel.updateRun(store.require('runs', runId), { status: run.status, reason: run.reason });
  };
  /**
   * 先归档运行，未结束时按删除模式取消或保留决定地暂停；已结束运行不再次执行状态动作。
   * EN: Archives a run and cancels or decision-preservingly pauses unfinished work according to removal mode; finished runs receive no extra state action.
   */
  const halt = (runId: string, remove = false) => {
    const run = store.require<Run>('runs', runId);
    kernel.updateRun(run, { archived: true });
    if (!['DONE', 'CANCELLED'].includes(run.status)) {
      if (remove) kernel.action(runId, 'cancel');
      else pauseKeepingDecision(runId);
    }
  };
  app.get('/api/spaces', () => store.all<ProjectSpace>('project_spaces'));
  app.post('/api/spaces', (request) => {
    const body = Command.extend({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    return command(body, request.url, () =>
      store.put<ProjectSpace>('project_spaces', { id: id(), revision: 0, name: body.name, protected: false }),
    );
  });
  app.patch<{ Params: { id: string } }>('/api/spaces/:id', (request) => {
    const body = mutation.extend({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    return command(body, request.url, () => {
      const space = store.require<ProjectSpace>('project_spaces', request.params.id);
      revision(body, space);
      invariant(!space.protected, 'SPACE_PROTECTED', '初始项目空间不能改名');
      return store.put('project_spaces', { ...space, name: body.name });
    });
  });
  /**
   * 校验来源空间非保护项和目标存在，将可修改项目迁移后删除空来源；不允许原地合并。
   * EN: Validates an unprotected source and existing distinct target, moves mutable projects and removes the source space.
   */
  const moveSpace = (source: ProjectSpace, targetId: string) => {
    invariant(!source.protected, 'SPACE_PROTECTED', '初始项目空间不能删除或合并');
    invariant(source.id !== targetId, 'SPACE_TARGET', '请选择另一个目标空间');
    store.require<ProjectSpace>('project_spaces', targetId);
    for (const project of store.all<Project>('projects').filter((p) => p.spaceId === source.id)) {
      assertMutable(null, project.id);
      store.put('projects', { ...project, spaceId: targetId });
    }
    store.delete('project_spaces', source.id);
    return { ok: true, targetId };
  };
  app.post<{ Params: { id: string } }>('/api/spaces/:id/merge', (request) => {
    const body = mutation.extend({ targetId: z.string().min(1) }).parse(request.body);
    return command(body, request.url, () => {
      const source = store.require<ProjectSpace>('project_spaces', request.params.id);
      revision(body, source);
      return moveSpace(source, body.targetId);
    });
  });
  app.delete<{ Params: { id: string } }>('/api/spaces/:id', (request) => {
    const body = mutation.parse(request.body);
    return command(body, request.url, () => {
      const source = store.require<ProjectSpace>('project_spaces', request.params.id);
      revision(body, source);
      return moveSpace(source, 'default');
    });
  });
  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request) => {
    const body = mutation
      .extend({
        name: z.string().trim().min(1).max(80).optional(),
        spaceId: z.string().min(1).optional(),
        archived: z.boolean().optional(),
      })
      .parse(request.body);
    const replayed = !!store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId);
    const result = command(body, request.url, () => {
      const project = store.require<Project>('projects', request.params.id);
      assertMutable(null, project.id);
      revision(body, project);
      if (body.spaceId) store.require<ProjectSpace>('project_spaces', body.spaceId);
      if (body.archived === true)
        for (const run of store.all<Run>('runs').filter((r) => r.projectId === project.id && !r.archived)) {
          /**
           * 项目归档暂停执行，对话归档标记仍独立保存。
           * EN: Project archival pauses execution; conversation archive flags stay independent.
           */
          if (!['DONE', 'CANCELLED'].includes(run.status)) pauseKeepingDecision(run.id);
        }
      const { commandId: _commandId, expectedRevision: _revision, ...changes } = body;
      return store.put('projects', { ...project, ...changes });
    });
    if (body.archived === true && !replayed)
      await Promise.all(
        store
          .all<Run>('runs')
          .filter((r) => r.projectId === request.params.id)
          .map((r) => executor.interrupt(r.id)),
      );
    return result;
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id', (request) => {
    const body = mutation
      .extend({
        expectedArchiveSetHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(request.body);
    return lifecycle(
      body,
      request.url,
      (lock) => {
        const project = store.require<Project>('projects', request.params.id);
        revision(body, project);
        acknowledgeArchives(project.id, body.expectedArchiveSetHash);
        lock('project:' + project.id);
        store.put('projects', { ...project, archived: true });
        const runs = store.all<Run>('runs').filter((r) => r.projectId === project.id);
        for (const run of runs) {
          lock('run:' + run.id);
          halt(run.id, true);
        }
        return runs.map((r) => r.id);
      },
      () => {
        acknowledgeArchives(request.params.id, body.expectedArchiveSetHash);
        const deletedRuns = store.all<Run>('runs').filter((r) => r.projectId === request.params.id);
        for (const run of deletedRuns) {
          closeStreams(run.id);
          store.deleteRun(run.id);
        }
        store.delete('projects', request.params.id);
        deletedProject?.(request.params.id);
        return { ok: true, deletedRunIds: deletedRuns.map((run) => run.id) };
      },
    );
  });
  app.patch<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    const body = mutation
      .extend({ title: z.string().trim().min(1).max(200).optional(), archived: z.boolean().optional() })
      .parse(request.body);
    const replayed = !!store.db.prepare('SELECT id FROM commands WHERE id=?').get(body.commandId);
    const result = command(body, request.url, () => {
      const run = store.require<Run>('runs', request.params.id);
      assertMutable(run.id, run.projectId);
      revision(body, run);
      if (body.archived === true) halt(run.id);
      const { commandId: _commandId, expectedRevision: _revision, ...changes } = body;
      return kernel.updateRun(store.require('runs', run.id), changes);
    });
    if (body.archived === true && !replayed) await executor.interrupt(request.params.id);
    return result;
  });
  app.delete<{ Params: { id: string } }>('/api/runs/:id', (request) => {
    const body = mutation.parse(request.body);
    return lifecycle(
      body,
      request.url,
      (lock) => {
        const run = store.require<Run>('runs', request.params.id);
        revision(body, run);
        assertMutable(run.id, run.projectId);
        lock('run:' + run.id);
        halt(run.id, true);
        return [run.id];
      },
      () => {
        closeStreams(request.params.id);
        store.deleteRun(request.params.id);
        return { ok: true };
      },
    );
  });
  return { assertMutable };
}
