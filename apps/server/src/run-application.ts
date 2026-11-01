/**
 * 协调运行操作与应用服务。
 * 把事务内领域状态修改与提交后宿主停止/唤醒分开，核对版本、hold 和活动请求；模型切换不得接纳旧请求响应。
 * EN: Coordinates run actions and application services. Separates transactional state changes from post-commit host stop/wake with revision/hold/activity checks; switches cannot admit old responses.
 */
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
/**
 * 协调领域修改和运行时边界；命令事务由调用方提供。 协调运行控制命令、内核状态和执行器操作。
 * EN: Coordinates domain mutations and runtime boundaries; callers provide the command transaction. Coordinates run control commands, kernel state and executor actions.
 */
export class RunApplicationService {
  /**
   * 绑定内核、宿主执行器及可变性守卫；领域事务与宿主副作用分别由 execute/afterCommit 阶段协调。
   * EN: Binds kernel, host executor and mutation guard; execution phases coordinate domain transactions separately from host effects.
   */
  constructor(
    private readonly kernel: Kernel<Store>,
    private readonly executor: NativeExecutor,
    private readonly assertMutable: (runId: string, projectId: string | null) => void,
  ) {}
  /**
   * 检查当前宿主执行登记是否包含运行或指定任务，不以持久状态推测实际子进程已经停止。
   * EN: Checks live host execution entries for a run/optional task instead of assuming persisted state proves process shutdown.
   */
  private hasActive(runId: string, taskId?: string) {
    return this.executor.hasActiveWork(runId, taskId);
  }
  /**
   * 在调用方命令事务内校验版本、归档和活动边界并修改领域状态。 显式恢复把持久停止解除与状态动作一同提交；结束运行的恢复只解除 hold，不重新执行任务。 模型切换只能发生在该代理没有活动请求时，避免旧模型响应写入新会话。
   * EN: Validates revision, archival and activity boundaries within the caller's command transaction. Explicit resume releases a persistent hold atomically with the action; finished runs only release the hold. Model changes require no active request so old responses cannot enter the new session.
   */
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
        invariant(
          !executor.gateway.backgroundJobs.hasUnsettled(run.id),
          'BACKGROUND_JOB_UNSETTLED',
          '后台命令尚未结束或结果未核验，请先处理后台作业，再恢复执行',
        );
        if (store.getExecutionHold(run.id)) {
          invariant(!this.hasActive(run.id), 'STOP_IN_PROGRESS', '当前执行尚未停止，请稍后再恢复');
          if (store.getExecutionHold(run.id)?.reason === 'recovery_unreadable') kernel.recover(run.id);
        }
        /**
         * 解除 hold 与获准动作必须一同提交或一同回滚。
         * EN: The hold release and the authorized action commit together, or both roll back.
         */
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
        /**
         * 旧版 providerId 加 pause 仍表示保存暂停，不会暂停后代。
         * EN: Legacy providerId + pause still means a saved pause, without pausing descendants.
         */
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
  /**
   * 状态提交后的宿主副作用：暂停/取消等待进程停止，允许继续的动作才触发调度。
   * EN: Performs post-commit host effects: pause/cancel waits for process shutdown, and only continuation actions wake scheduling.
   */
  async afterAction(runId: string, body: RunAction, releasedFinishedHold: boolean) {
    const switching = body.action === 'switch_model' || body.providerId !== undefined;
    if (!switching && ['pause', 'cancel'].includes(body.action))
      await this.executor.interrupt(runId, body.taskId);
    if (!releasedFinishedHold && (!switching || body.action === 'resume' || body.switchMode === 'resume'))
      this.executor.resume(runId);
  }
}
