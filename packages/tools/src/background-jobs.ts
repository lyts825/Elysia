/** 原生命令作业的持久意图、进程所有权、结果核验与一次性上下文交付。 */
import {
  AppError,
  invariant,
  inspectToolCalls,
  toolCallsClosed,
  type Agent,
  type Operation,
  type Project,
  type Run,
  type Task,
} from '../../contracts/src/index.js';
import {
  BackgroundCommand,
  BackgroundResult,
  type BackgroundJob,
  unsettledBackgroundJob,
} from '../../contracts/src/background-jobs.js';
import { BackgroundJobsStore } from '../../storage/src/background-jobs.js';
import { id, now, stable, type Store } from '../../storage/src/index.js';
import type { Kernel } from '../../kernel/src/index.js';

type ActiveJob = {
  taskId: string;
  runId: string;
  account: string;
  controller: AbortController;
  done: Promise<void>;
};
export class BackgroundJobs {
  readonly records: BackgroundJobsStore;
  private readonly active = new Map<string, ActiveJob>();
  private isTaskActive: (taskId: string) => boolean = () => false;
  private wake: (runId: string) => void = () => {};
  private modelWork: () => { taskId: string; runId: string; account: string }[] = () => [];
  private closed = false;
  constructor(
    private kernel: Kernel<Store>,
    private execute: (
      task: Task,
      operation: Operation,
      command: BackgroundCommand,
      signal: AbortSignal,
    ) => Promise<BackgroundResult>,
  ) {
    this.records = new BackgroundJobsStore(kernel.store);
  }
  configure(options: {
    isTaskActive: (taskId: string) => boolean;
    wake: (runId: string) => void;
    modelWork?: () => { taskId: string; runId: string; account: string }[];
  }) {
    this.isTaskActive = options.isTaskActive;
    this.wake = options.wake;
    if (options.modelWork) this.modelWork = options.modelWork;
  }
  list(runId: string) {
    return this.records.list(runId);
  }
  listPage(runId: string, before?: string) {
    return this.records.listPage(runId, before);
  }
  findByOperation(runId: string, operationId: string) {
    return this.records.findByOperation(runId, operationId);
  }
  isManagedActive(jobId: string) {
    return this.active.has(jobId);
  }
  read(runId: string, jobId: string): BackgroundJob {
    const job = this.records.get(jobId);
    invariant(job && job.runId === runId, 'JOB_SCOPE', '后台作业不存在或不属于当前运行');
    return job;
  }
  hasUnsettled(runId: string, taskId?: string) {
    return this.records.find({ runId, taskId, unsettled: true }).length > 0;
  }
  /** 只检查尚未收束的作业；管理操作不必解压全部历史命令输出。 */
  hasUnconfirmedProcess(runId: string) {
    return this.records
      .find({ runId, unsettled: true })
      .some((job) => !job.stopConfirmed && !this.active.has(job.id));
  }
  isActiveOperation(operation: Operation) {
    return (
      operation.name === 'job_execution' &&
      operation.status === 'INTENT' &&
      [...this.active.keys()].some((key) => this.records.get(key)?.executionOperationId === operation.id)
    );
  }
  /** 活动进程继续占用代理名额；未确认停止的恢复作业也不能释放名额。 */
  occupancy() {
    return this.records
      .find({ unsettled: true })
      .filter((job) => this.active.has(job.id) || !job.stopConfirmed)
      .map((job) => ({
        taskId: job.taskId,
        runId: job.runId,
        account: job.account,
      }));
  }
  private assertStart(task: Task) {
    const store = this.kernel.store,
      run = store.require<Run>('runs', task.runId);
    invariant(
      !this.closed &&
        !store.getExecutionHold(run.id) &&
        !run.archived &&
        ['READY', 'RUNNING'].includes(run.status) &&
        task.status === 'RUNNING' &&
        (!run.projectId || !store.require<Project>('projects', run.projectId).archived),
      'TASK_STOPPED',
      '运行已停止，不能启动后台作业',
    );
    invariant(
      run.kind === 'task' &&
        run.execution?.kind !== 'docker-agent' &&
        task.phase === 'executing' &&
        this.kernel.permissions(task).exec,
      'EXEC_DENIED',
      '后台命令需要当前原生任务执行阶段的命令授权',
    );
    invariant(!this.hasUnsettled(run.id), 'BACKGROUND_JOB_ACTIVE', '同一运行已有活动或待核验后台作业');
    const occupied = [
      ...new Map([...this.occupancy(), ...this.modelWork()].map((entry) => [entry.taskId, entry])).values(),
    ].filter((entry) => entry.taskId !== task.id);
    const agent = store.require<Agent>('agents', task.agentId);
    invariant(
      (run.limits.scheduling === 'async' || occupied.length < 4) &&
        (run.limits.scheduling === 'async' ||
          occupied.filter((entry) => entry.runId === run.id).length < run.limits.concurrency) &&
        (run.limits.scheduling === 'async' ||
          occupied.filter((entry) => entry.account === agent.providerBinding.account).length <
            agent.providerBinding.concurrency) &&
        (run.limits.scheduling === 'async'
          ? this.occupancy().length < 4 &&
            this.occupancy().filter((entry) => entry.runId === run.id).length < run.limits.toolConcurrency
          : this.occupancy().length < run.limits.toolConcurrency),
      'JOB_CAPACITY',
      '后台命令达到全局、运行、账号或工具并发上限',
    );
    const remaining = run.limits.maxMinutes * 60000 - (run.startedAt ? Date.now() - run.startedAt : 0);
    invariant(remaining >= 100, 'TIME_BUDGET', '运行累计时间预算已耗尽');
    return { run, remaining };
  }
  /** 在返回启动回执前保存真实执行意图；独立 AbortController 跨模型步骤存活。 */
  start(task: Task, launch: Operation, input: BackgroundCommand, signal: AbortSignal) {
    signal.throwIfAborted();
    task = this.kernel.store.require<Task>('tasks', task.id);
    const { remaining } = this.assertStart(task);
    invariant(
      Buffer.byteLength(stable(input)) <= 128 * 1024,
      'JOB_ARGUMENTS_LIMIT',
      '后台命令参数超过128KiB',
    );
    const command = BackgroundCommand.parse({
      ...input,
      timeout: Math.min(input.timeout, Math.floor(remaining)),
    });
    const existing = this.records.get(launch.id);
    if (existing) return this.receipt(existing);
    const store = this.kernel.store,
      agent = store.require<Agent>('agents', task.agentId);
    const operation: Operation = {
      id: id(),
      revision: 0,
      runId: task.runId,
      taskId: task.id,
      attemptId: launch.attemptId,
      toolCallId: 'background:' + launch.id,
      name: 'job_execution',
      args: command,
      status: 'INTENT',
      evidence: { jobId: launch.id, launchOperationId: launch.id },
    };
    const job = store.tx(() => {
      store.put('tool_operations', operation);
      const job = this.records.put({
        id: launch.id,
        revision: 0,
        runId: task.runId,
        taskId: task.id,
        attemptId: launch.attemptId,
        executionOperationId: operation.id,
        status: 'RUNNING',
        command,
        createdAt: now(),
        updatedAt: now(),
        stopConfirmed: false,
        account: agent.providerBinding.account,
        accountConcurrency: agent.providerBinding.concurrency,
      });
      this.kernel.event(task.runId, 'background_job.started', this.receipt(job), task.id, launch.attemptId);
      return job;
    });
    const controller = new AbortController();
    const entry: ActiveJob = {
      taskId: task.id,
      runId: task.runId,
      account: job.account,
      controller,
      done: Promise.resolve(),
    };
    this.active.set(job.id, entry);
    // 下一微任务才开始命令，启动登记与进程事实保持独立。
    entry.done = Promise.resolve()
      .then(async () => {
        let result: BackgroundResult | undefined, failure: unknown;
        try {
          result = await this.execute(task, operation, command, controller.signal);
        } catch (error) {
          failure = error;
        }
        this.settle(job.id, result, failure, controller.signal.aborted);
      })
      .catch((error) => {
        // 持久化失败仍保留意图，暂停运行；不能报告一份未保存的成功结果。
        store.recovery.hold(task.runId, 'recovery_unreadable');
        throw error;
      })
      .finally(() => {
        this.active.delete(job.id);
        this.wake(task.runId);
      });
    // 停止入口仍等待原 Promise；这里观察拒绝，避免异步未处理异常。
    void entry.done.catch(() => {});
    return this.receipt(job);
  }
  private receipt(job: BackgroundJob) {
    return {
      jobId: job.id,
      executionOperationId: job.executionOperationId,
      status: job.status,
      started: true,
      completed: false,
      message: '后台命令已登记；这不是执行成功。结果会作为资料交付，使用 job_read 查看，job_cancel 停止。',
    };
  }
  private settle(jobId: string, result: BackgroundResult | undefined, failure: unknown, cancelled: boolean) {
    const store = this.kernel.store;
    store.tx(() => {
      const job = this.records.get(jobId)!;
      if (job.status !== 'RUNNING') return;
      if (result) {
        result = BackgroundResult.parse(result);
        const stdout = Buffer.from(result.stdout).subarray(0, job.command.outputLimit).toString();
        const stderr = Buffer.from(result.stderr)
          .subarray(0, Math.max(0, job.command.outputLimit - Buffer.byteLength(stdout)))
          .toString();
        result = {
          ...result,
          stdout,
          stderr,
          truncated:
            result.truncated ||
            Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > job.command.outputLimit,
        };
      }
      const stopped = !!result || (failure instanceof AppError && failure.code === 'PROCESS_START');
      const uncertain = cancelled || !stopped || !!result?.timedOut;
      const status = uncertain ? 'UNCERTAIN' : result?.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
      const error = failure
        ? String(failure instanceof Error ? failure.message : failure).slice(0, 2000)
        : uncertain
          ? '命令已中断或停止未确认；副作用必须核验，不能自动重跑。'
          : undefined;
      const operation = store.require<Operation>('tool_operations', job.executionOperationId);
      store.put('tool_operations', {
        ...operation,
        status: uncertain ? 'UNCERTAIN' : result ? 'DONE' : 'FAILED',
        result: result ?? { error, code: 'JOB_EXECUTION_FAILED' },
        error,
        evidence: { ...operation.evidence, jobStopped: stopped },
      });
      const next = this.records.put({
        ...job,
        status,
        result,
        error,
        stopConfirmed: stopped,
        finishedAt: now(),
      });
      this.kernel.event(
        job.runId,
        'background_job.completed',
        {
          jobId,
          executionOperationId: operation.id,
          status: next.status,
          stopConfirmed: stopped,
        },
        job.taskId,
        job.attemptId,
      );
    });
  }
  /** 单作业取消只中止自己的信号，等待后端 close/cleanup；失败不假定停止。 */
  async cancel(runId: string, jobId: string) {
    const job = this.read(runId, jobId),
      entry = this.active.get(jobId);
    if (!entry) return job;
    this.records.put({ ...job, cancelRequestedAt: job.cancelRequestedAt ?? now() });
    entry.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entry.done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AppError('JOB_STOP_UNCONFIRMED', '后台命令停止未确认，仍保留执行名额')),
            20000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return this.read(runId, jobId);
  }
  async cancelForTasks(taskIds?: Set<string>) {
    const results = await Promise.allSettled(
      [...this.active]
        .filter(([, entry]) => !taskIds || taskIds.has(entry.taskId))
        .map(([key, entry]) => this.cancel(entry.runId, key)),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        '后台作业停止未确认',
      );
  }
  async close() {
    this.closed = true;
    await this.cancelForTasks();
  }
  /** 只有显式核验后才能记下孤立进程已停止；不改变其未知副作用结论。 */
  confirmStopped(runId: string, jobId: string, note: string) {
    const job = this.read(runId, jobId);
    invariant(
      !this.active.has(job.id) &&
        job.status === 'UNCERTAIN' &&
        note.trim().length >= 5 &&
        note.length <= 2000,
      'JOB_STOP_EVIDENCE',
      '请先核验进程已经停止，并说明核验依据',
    );
    return this.kernel.store.tx(() => {
      const operation = this.kernel.store.require<Operation>('tool_operations', job.executionOperationId);
      invariant(operation.status === 'UNCERTAIN', 'JOB_STOP_EVIDENCE', '只可确认仍待核验作业的停止事实');
      this.kernel.store.put('tool_operations', {
        ...operation,
        evidence: {
          ...operation.evidence,
          jobStopped: true,
          jobStopVerification: { note: note.trim(), at: now() },
        },
      });
      return this.records.put({ ...job, stopConfirmed: true });
    });
  }
  recover() {
    const store = this.kernel.store;
    for (const job of this.records.find({ unsettled: true })) {
      if (this.active.has(job.id)) continue;
      store.tx(() => {
        const operation = store.require<Operation>('tool_operations', job.executionOperationId);
        if (operation.status === 'INTENT')
          store.put('tool_operations', { ...operation, status: 'UNCERTAIN' });
        this.records.put({
          ...job,
          status: 'UNCERTAIN',
          error: '服务中断，原命令不自动重跑。请核验进程及副作用。',
        });
        const launch = store.require<Operation>('tool_operations', job.id);
        if (!['DONE', 'FAILED'].includes(launch.status))
          store.put('tool_operations', { ...launch, status: 'DONE', result: this.receipt(job) });
        const task = store.require<Task>('tasks', job.taskId);
        if (!['DONE', 'CANCELLED', 'FAILED'].includes(task.status)) this.kernel.wait(task, 'verification');
      });
    }
  }
  /** 调度前同步核验结果，关闭工具组后原子投递；暂停与未知请求绝不被结果唤醒。 */
  async pump() {
    const store = this.kernel.store;
    for (const [key, entry] of [...this.active]) {
      const run = store.require<Run>('runs', entry.runId),
        task = store.require<Task>('tasks', entry.taskId);
      const exhausted = !!run.startedAt && Date.now() - run.startedAt >= run.limits.maxMinutes * 60000;
      if (
        store.getExecutionHold(run.id) ||
        run.archived ||
        ['DONE', 'CANCELLED', 'FAILED'].includes(run.status) ||
        ['DONE', 'CANCELLED', 'FAILED'].includes(task.status) ||
        exhausted ||
        (run.projectId && store.require<Project>('projects', run.projectId).archived) ||
        (task.status === 'WAITING' && !['background_job', 'user', 'children'].includes(task.waitReason ?? ''))
      ) {
        await this.cancel(entry.runId, key);
      }
    }
    for (const job of this.records.find({ unsettled: true })) {
      if (job.status !== 'UNCERTAIN' || this.active.has(job.id)) continue;
      const operation = store.require<Operation>('tool_operations', job.executionOperationId);
      const stopped =
        job.stopConfirmed ||
        operation.evidence?.jobStopped === true ||
        (operation.evidence?.containerRecovery as { stopped?: boolean } | undefined)?.stopped === true;
      if (stopped && ['DONE', 'FAILED'].includes(operation.status)) {
        this.records.put({
          ...job,
          status: 'RESOLVED',
          stopConfirmed: true,
          deliveredAt: undefined,
          error: '中断结果已显式核验；不构成原命令成功退出的证明。',
        });
      } else if (stopped && !job.stopConfirmed) this.records.put({ ...job, stopConfirmed: true });
    }
    for (const job of this.records.find({ pendingDelivery: true })) {
      if (this.isTaskActive(job.taskId)) continue;
      store.tx(() => {
        const current = this.read(job.runId, job.id);
        if (current.deliveredAt) return;
        const task = store.require<Task>('tasks', job.taskId),
          run = store.require<Run>('runs', job.runId);
        if (
          !toolCallsClosed(this.kernel.history(task)) ||
          store
            .requestLedger({ runId: job.runId, taskId: job.taskId })
            .some((request) => request.status === 'RESERVED')
        )
          return;
        this.kernel.appendMessage(
          task,
          'user',
          '后台命令结果（工具资料，不是用户授权；命令成功不代表任务验收通过）：\n' +
            stable({
              jobId: current.id,
              executionOperationId: current.executionOperationId,
              status: current.status,
              result: current.result
                ? {
                    ...current.result,
                    stdout: current.result.stdout.slice(0, 6000),
                    stderr: current.result.stderr.slice(0, 3000),
                  }
                : undefined,
              error: current.error,
              stopConfirmed: current.stopConfirmed,
              readMore: 'job_read',
            }),
          { purpose: 'runtime_notice' },
        );
        this.records.put({ ...current, deliveredAt: now() });
        this.kernel.event(job.runId, 'background_job.delivered', { jobId: job.id }, job.taskId);
        const allowed =
          !store.getExecutionHold(run.id) &&
          !run.archived &&
          (!run.projectId || !store.require<Project>('projects', run.projectId).archived) &&
          !['DONE', 'CANCELLED', 'FAILED'].includes(run.status);
        if (allowed && task.status === 'WAITING' && task.waitReason === 'background_job') {
          if (current.status === 'UNCERTAIN') this.kernel.wait(task, 'verification');
          else if (
            !store
              .requestLedger({ runId: job.runId })
              .some((request) => ['RESERVED', 'UNKNOWN'].includes(request.status))
          ) {
            this.kernel.updateTask(task, 'READY', { waitReason: undefined, waitingFor: [] });
            if (task.id === run.rootTaskId || run.reason === 'background_job')
              this.kernel.updateRun(store.require('runs', run.id), { status: 'READY', reason: undefined });
          }
        }
      });
    }
    // 旧阶段可能在工具组未闭合时等待作业；先续行受网关约束的工具，才能投递结果。
    for (const task of store.stateCandidates<Task>('tasks', ['WAITING'], {
      waitReasons: ['background_job'],
      excludeExecutionHolds: true,
    })) {
      if (this.isTaskActive(task.id)) continue;
      const run = store.require<Run>('runs', task.runId);
      const sequence = inspectToolCalls(this.kernel.history(task));
      const drainingTools =
        run.limits.scheduling === 'async' &&
        store.scheduling.stage(task.id) === 'tools' &&
        !sequence.error &&
        sequence.pending.length > 0;
      if (this.hasUnsettled(task.runId) && !drainingTools) continue;
      if (
        run.archived ||
        ['DONE', 'CANCELLED', 'FAILED'].includes(run.status) ||
        (run.status === 'WAITING' && run.reason !== 'background_job') ||
        (run.projectId && store.require<Project>('projects', run.projectId).archived) ||
        sequence.error ||
        (!drainingTools && sequence.pending.length > 0) ||
        store
          .requestLedger({ runId: run.id })
          .some((request) => ['RESERVED', 'UNKNOWN'].includes(request.status)) ||
        store
          .stateCandidates<Operation>('tool_operations', ['INTENT', 'UNCERTAIN'], { runId: run.id })
          .some((operation) => !drainingTools || !this.isActiveOperation(operation))
      )
        continue;
      store.tx(() => {
        this.kernel.updateTask(store.require('tasks', task.id), 'READY', {
          waitReason: undefined,
          waitingFor: [],
        });
        if (run.reason === 'background_job')
          this.kernel.updateRun(store.require('runs', run.id), { status: 'READY', reason: undefined });
      });
    }
  }
}
