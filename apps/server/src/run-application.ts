/** 协调运行操作与应用服务。 */
import {
  invariant,
  type Run,
  type Task,
  type Project,
  type ProviderConfig,
} from '../../../packages/contracts/src/index.js';
import type { Store } from '../../../packages/storage/src/index.js';
import type { Kernel } from '../../../packages/kernel/src/index.js';
import type { NativeExecutor } from '../../../packages/runtime/src/index.js';

export interface RunAction {
  expectedRevision: number;
  action: 'start' | 'pause' | 'resume' | 'cancel' | 'switch_model' | 'resume_task' | 'stop_current';
  taskId?: string;
  providerId?: string;
  switchMode?: 'apply' | 'resume';
}
/** Coordinates domain mutations and runtime boundaries; callers provide the command transaction. */
export class RunApplicationService {
  constructor(
    private readonly kernel: Kernel<Store>,
    private readonly executor: NativeExecutor,
    private readonly assertMutable: (runId: string, projectId: string | null) => void,
  ) {}
  private hasActive(runId: string, taskId?: string) {
    return [...this.executor.active.entries()].some(
      ([id, active]) => active.runId === runId && (!taskId || id === taskId),
    );
  }
  apply(runId: string, body: RunAction, binding?: ProviderConfig) {
    const { kernel, executor } = this,
      store = kernel.store;
    const switching = body.action === 'switch_model' || body.providerId !== undefined;
    let releasedFinishedHold = false;
    const result = (() => {
      const run = store.require<Run>('runs', runId);
      invariant(body.expectedRevision === run.revision, 'REVISION_CONFLICT', '版本已变化，请刷新后重试');
      this.assertMutable(run.id, run.projectId);
      invariant(
        !run.archived && (!run.projectId || !store.require<Project>('projects', run.projectId).archived),
        'ARCHIVED',
        '请先恢复归档的对话或项目',
      );
      if (
        body.action === 'resume' &&
        !switching &&
        !body.taskId &&
        ['DONE', 'CANCELLED'].includes(run.status) &&
        store.getExecutionHold(run.id)
      ) {
        invariant(!this.hasActive(run.id), 'STOP_IN_PROGRESS', '当前执行尚未停止，请稍后再恢复');
        executor.releaseLocalStop(run.id);
        releasedFinishedHold = true;
        return run;
      }
      if (['start', 'resume', 'resume_task'].includes(body.action) || body.switchMode === 'resume') {
        if (store.getExecutionHold(run.id)) {
          invariant(!this.hasActive(run.id), 'STOP_IN_PROGRESS', '当前执行尚未停止，请稍后再恢复');
          if (store.getExecutionHold(run.id)?.reason === 'recovery_unreadable') kernel.recover(run.id);
        }
        // The hold release and the authorized action commit together, or both roll back.
        executor.releaseLocalStop(run.id);
      }
      if (body.action === 'resume_task') {
        invariant(
          body.taskId && !this.hasActive(run.id, body.taskId),
          'TASK_RESUME_BOUNDARY',
          '请选择已暂停或失败的代理，并等待当前操作结束',
        );
        return kernel.resumeTask(run.id, body.taskId);
      }
      if (binding) {
        invariant(
          body.taskId && !this.hasActive(run.id, body.taskId),
          'MODEL_SWITCH_BOUNDARY',
          '该代理仍在执行，请先暂停并等待当前操作结束',
        );
        const switched = kernel.switchModel(
          run.id,
          body.taskId,
          binding,
          body.action === 'switch_model' ? body.switchMode! : body.action === 'resume' ? 'resume' : 'apply',
        );
        // Legacy providerId + pause still means a saved pause, without pausing descendants.
        if (body.action === 'pause') {
          const task = store.require<Task>('tasks', body.taskId);
          if (task.waitReason === 'user' && run.kind === 'chat') kernel.wait(task, 'paused');
          return store.require<Run>('runs', run.id);
        }
        return switched;
      }
      invariant(body.action !== 'switch_model', 'MODEL_SWITCH_CHOICE', '模型选择未完成');
      invariant(body.action !== 'stop_current', 'STOP_RUN_SCOPE', '停止当前执行需使用本机停止入口');
      return kernel.action(run.id, body.action, body.taskId);
    })();
    return { result, releasedFinishedHold };
  }
  async afterAction(runId: string, body: RunAction, releasedFinishedHold: boolean) {
    const switching = body.action === 'switch_model' || body.providerId !== undefined;
    if (!switching && ['pause', 'cancel'].includes(body.action))
      await this.executor.interrupt(runId, body.taskId);
    if (!releasedFinishedHold && (!switching || body.action === 'resume' || body.switchMode === 'resume'))
      this.executor.resume(runId);
  }
}
