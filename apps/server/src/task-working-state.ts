import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  Command,
  Evidence,
  invariant,
  type Agent,
  type Run,
  type Task,
} from '../../../packages/contracts/src/index.js';
import type { TaskWorkingStateView } from '../../../packages/contracts/src/working-state.js';
import {
  approveTaskWorkingState,
  captureTaskWorkingState,
  readTaskWorkingState,
  saveTaskWorkingState,
  validateTaskWorkingState,
  WORKING_STATE_REQUIREMENTS_MAX_CHARS,
} from '../../../packages/context/src/working-state.js';
import { validatePairs } from '../../../packages/context/src/index.js';
import type { Kernel } from '../../../packages/kernel/src/index.js';
import type { Store } from '../../../packages/storage/src/index.js';

type Params = { runId: string; taskId: string };

export function registerTaskWorkingStateRoutes(
  app: FastifyInstance,
  store: Store,
  kernel: Kernel<Store>,
  assertMutable: (runId: string | null, projectId?: string | null) => void,
  assertExecutionReadable: (runId: string) => void,
) {
  function entities(params: Params) {
    const runId = z.string().uuid().parse(params.runId);
    const taskId = z.string().uuid().parse(params.taskId);
    assertExecutionReadable(runId);
    const run = store.require<Run>('runs', runId);
    const task = store.require<Task>('tasks', taskId);
    invariant(task.runId === runId, 'WORKING_STATE_SCOPE', '工作状态不属于当前对话');
    const agent = store.require<Agent>('agents', task.agentId);
    invariant(
      agent.runId === runId && agent.taskId === taskId,
      'WORKING_STATE_SCOPE',
      '任务的会话归属不一致',
    );
    return { run, task, agent, history: store.sessionMessages(runId, agent.sessionId) };
  }

  function view(params: Params): TaskWorkingStateView {
    const { run, task, agent, history } = entities(params);
    const record = readTaskWorkingState(store, run.id, task.id);
    const rawEvidence =
      task.result && typeof task.result === 'object'
        ? (task.result as { evidence?: unknown }).evidence
        : undefined;
    const evidence = rawEvidence === undefined ? [] : z.array(Evidence).parse(rawEvidence);
    const draft = captureTaskWorkingState({
      run,
      task,
      history,
      evidence,
      children: store.all<Task>('tasks', run.id),
      sessionId: agent.sessionId,
      revision: record.revision + 1,
      capturedAt: new Date().toISOString(),
    });
    const projection = kernel.contextSnapshot(run.id).agents.find((item) => item.agentId === agent.id);
    let reason = projection?.safeToConfigure
      ? null
      : (projection?.configureReason ?? '无法确认任务的安全操作边界');
    if (run.execution?.kind === 'docker-agent') reason = '外部 Agent 自行管理上下文，当前工作状态仅供查看';
    try {
      assertMutable(run.id, run.projectId);
      validatePairs(history);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      reason = error.message;
    }
    const validation = record.approved
      ? validateTaskWorkingState(record.approved, { run, task, history, sessionId: agent.sessionId })
      : null;
    return {
      ...record,
      draft,
      canApprove: reason === null,
      reason,
      approvedValid: validation?.valid === true,
      approvedInvalidReason: validation && !validation.valid ? validation.reason : null,
    };
  }

  const route = '/api/runs/:runId/tasks/:taskId/working-state';
  app.get<{ Params: Params }>(route, (request) => view(request.params));
  const approve = Command.extend({
    expectedRevision: z.number().int().nonnegative(),
    expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    currentRequirements: z
      .string()
      .min(1)
      .max(WORKING_STATE_REQUIREMENTS_MAX_CHARS)
      .refine((text) => !!text.trim()),
    confirmed: z.literal(true),
    action: z.literal('approve').optional(),
  }).strict();
  const revoke = Command.extend({
    expectedRevision: z.number().int().nonnegative(),
    action: z.literal('revoke'),
  }).strict();

  app.post<{ Params: Params }>(route, (request) => {
    const body = z.union([approve, revoke]).parse(request.body);
    return store.command(body.commandId, { route, params: request.params, body }, () => {
      const current = view(request.params);
      const { run, task } = entities(request.params);
      assertMutable(run.id, run.projectId);
      invariant(current.canApprove, 'WORKING_STATE_BOUNDARY', current.reason ?? '请先暂停任务并完成核验');
      if (current.revision !== body.expectedRevision)
        throw new AppError('REVISION_CONFLICT', '工作状态已被更新，请重新核对', false, null, 409);
      if (body.action === 'revoke') {
        saveTaskWorkingState(store, run.id, task.id, body.expectedRevision, null);
      } else {
        if (current.draft.snapshotHash !== body.expectedSnapshotHash)
          throw new AppError(
            'WORKING_STATE_STALE',
            '任务或原始消息已改变，请重新核对当前工作状态',
            false,
            null,
            409,
          );
        const approved = approveTaskWorkingState(current.draft, {
          confirmed: body.confirmed,
          currentRequirements: body.currentRequirements,
          commandId: body.commandId,
          approvedAt: new Date().toISOString(),
        });
        saveTaskWorkingState(store, run.id, task.id, body.expectedRevision, approved);
      }
      kernel.event(
        run.id,
        'task.working-state.updated',
        {
          taskId: task.id,
          revision: current.revision + 1,
          action: body.action ?? 'approve',
          snapshotHash: body.action === 'revoke' ? null : current.draft.snapshotHash,
        },
        task.id,
      );
      return view(request.params);
    });
  });
}
