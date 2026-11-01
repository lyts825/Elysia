/**
 * 协调工具调用、权限检查、执行和结果处理。
 * EN: Coordinate tool calls, permission checks, execution, and result persistence.
 *
 * 解析工具输入后按策略核对权限，调用插件并登记结果；命令、文件、网络与 MCP 能力共享调用入口，各自仍保留独立限制。
 * EN: Parse inputs, check policy and permissions, invoke plugins, and record results through a shared entry while preserving capability-specific restrictions.
 */
import { pluginServices } from './plugin-services.js';
import { reviewToolRules, type ReviewModel } from './tool-review.js';
import type { ToolReviewReceipt } from '../../contracts/src/execution-policy.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Processes } from './processes.js';
import { ConfiguredCommandRunner, type CommandRunner } from './command-runner.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  AppError,
  Evidence,
  effectiveContextWindowTokens,
  invariant,
  inspectToolCalls,
  type Agent,
  type Task,
  type Run,
  type Project,
  type Operation,
  type Attempt,
  type Artifact,
  type Snapshot,
  type ToolCall,
  type Message,
} from '../../contracts/src/index.js';
import { Store, id, hash, stable, now } from '../../storage/src/index.js';
import { Kernel } from '../../kernel/src/index.js';
import { gatePeerReview } from '../../kernel/src/peer-review.js';
import type { ToolDefinition } from '../../context/src/index.js';
import { scopedLocalItems } from '../../context/src/local-library.js';
import { McpClient } from './mcp-client.js';
import { fileMediaType } from '../../contracts/src/files.js';
import { PlanAlignmentHost, type PlanAlignmentLoader } from './module-host.js';
import { builtinTools } from './plugins/index.js';
import { MCP_CATALOGUE_BYTES } from './catalogue.js';
import { contained, resolved } from './path-policy.js';
import { BackgroundJobs } from './background-jobs.js';
export { cleanEnv, Processes } from './processes.js';
/**
 * 模型工具调用的统一宿主：按角色计算工具清单，核验调用身份和参数，管理审核与操作账本。
 * 插件只提供具体动作；授权、重放、事务和不确定副作用始终由网关控制。
 * EN: Host model tool calls by computing role-specific catalogues, validating call identity and
 * arguments, and managing reviews and the operation ledger. Plugins supply actions; authorization,
 * replay, transactions, and uncertain side effects remain gateway responsibilities.
 */
export class ToolGateway {
  processes = new Processes();
  readonly commandRunner: CommandRunner;
  readonly backgroundJobs: BackgroundJobs;
  readonly mcp = new McpClient();
  readonly planAlignment: PlanAlignmentHost;
  private readonly tools: ReturnType<typeof builtinTools>;
  private closing?: Promise<void>;
  private closed = false;
  /**
   * 装配命令后端、计划模块与固定工具贡献；可注入审核模型和命令实现供宿主替换基础设施。
   * EN: Compose the command backend, plan module, and fixed contributions. The host may inject command
   * infrastructure and a review-model implementation.
   */
  constructor(
    public kernel: Kernel<Store>,
    private readonly options: {
      planAlignmentLoader?: PlanAlignmentLoader;
      commandRunner?: CommandRunner;
      reviewModel?: ReviewModel;
    } = {},
  ) {
    this.commandRunner =
      options.commandRunner ?? new ConfiguredCommandRunner(this.processes, kernel.store.directory);
    this.backgroundJobs = new BackgroundJobs(kernel, this.runCommand.bind(this));
    kernel.backgroundJobs = this.backgroundJobs;
    this.planAlignment = new PlanAlignmentHost(
      { propose: kernel.propose.bind(kernel), accept: kernel.accept.bind(kernel) },
      options.planAlignmentLoader,
    );
    this.tools = builtinTools(pluginServices(this, this.catalogueBudget.bind(this)), this.planAlignment);
  }
  /**
   * 同时停止本机子进程和命令后端；未传 taskIds 时处理所有任务，空集合不匹配任务。
   * 等待两种清理全部收束并汇总失败，不因一个后端报错而跳过另一个。
   * EN: Stop both local processes and the command backend. Omitted taskIds means all tasks; an empty
   * set matches none. Await both cleanup paths and aggregate failures instead of skipping one after
   * the other fails.
   */
  async cancelCommands(taskIds?: Set<string>) {
    const results = await Promise.allSettled([
      this.backgroundJobs.cancelForTasks(taskIds),
      this.processes.cancel(taskIds),
      this.commandRunner.cancel(taskIds),
    ]);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length)
      throw new AggregateError(
        failed.map((r) => r.reason),
        '命令停止未确认',
      );
  }
  /**
   * 执行模型声明的命令，后端取运行创建时冻结的合同配置。
   * 再次解析工作目录并限定在任务目录；仅整目录写入授权能转为容器可写挂载。
   * 后端和容器名称先写入操作证据，供中断后恢复核验；本机模式不提供操作系统隔离。
   * EN: Execute the model command with the backend frozen at run creation. Resolve cwd again and
   * restrict it to the task workspace; only whole-directory write grants allow a writable container
   * mount. Persist backend/container evidence before execution for recovery. Local mode is not OS
   * isolation.
   */
  async runCommand(
    task: Task,
    operation: Operation,
    args: { program: string; args: string[]; cwd: string; timeout: number; outputLimit: number },
    signal: AbortSignal,
  ) {
    const run = this.store.require<Run>('runs', task.runId),
      permission = this.kernel.permissions(task),
      backend = run.contract.commandBackend ?? { kind: 'local' as const };
    invariant(permission.exec, 'EXEC_DENIED', '命令未授权');
    if (operation.name !== 'job_execution') this.assertBackgroundBoundary(task, 'exec');
    // 在实际执行边界重新核验解析后的工作目录。
    // EN: Revalidate the resolved working directory at the execution boundary.
    const cwd = await this.path(task, args.cwd);
    invariant(
      task.workspace && contained(await fs.realpath(task.workspace), cwd),
      'EXEC_SCOPE',
      '命令 cwd 必须在任务目录',
    );
    const workspace = await fs.realpath(task.workspace);
    const allowedWrites = permission.write
      ? await Promise.all(permission.writePaths.map((p) => resolved(path.resolve(workspace, p))))
      : [];
    // 部分文件写入授权不能变成整个工作区的可写挂载。
    // EN: Partial file-write grants must never become a writable mount of the entire workspace.
    const writable = permission.write && allowedWrites.some((root) => root === workspace);
    signal.throwIfAborted();
    const latestTask = this.store.require<Task>('tasks', task.id),
      latestRun = this.store.require<Run>('runs', run.id);
    const background = operation.name === 'job_execution';
    invariant(
      !this.closed &&
        !this.store.getExecutionHold(run.id) &&
        !latestRun.archived &&
        (['READY', 'RUNNING'].includes(latestRun.status) ||
          (background &&
            latestRun.status === 'WAITING' &&
            ['background_job', 'user'].includes(latestRun.reason ?? ''))) &&
        (latestTask.status === 'RUNNING' ||
          (background &&
            (latestTask.status === 'READY' ||
              (latestTask.status === 'WAITING' &&
                ['background_job', 'user'].includes(latestTask.waitReason ?? ''))))),
      'TASK_STOPPED',
      '命令启动前运行已停止',
    );
    const remaining =
      latestRun.limits.maxMinutes * 60000 - (latestRun.startedAt ? Date.now() - latestRun.startedAt : 0);
    invariant(remaining >= 100, 'TIME_BUDGET', '命令启动前累计运行时间已耗尽');
    const current = this.store.require<Operation>('tool_operations', operation.id);
    this.store.put('tool_operations', {
      ...current,
      evidence: {
        ...current.evidence,
        commandBackend: backend,
        containerWritable: backend.kind === 'docker' ? writable : undefined,
        containerName: backend.kind === 'docker' ? 'elysia-cmd-' + operation.id : undefined,
      },
    });
    return this.commandRunner.run(
      {
        operationId: operation.id,
        taskId: task.id,
        workspace: task.workspace,
        cwd,
        program: args.program,
        args: args.args,
        timeout: Math.min(args.timeout, Math.floor(remaining)),
        outputLimit: args.outputLimit,
        writable,
        backend,
      },
      signal,
    );
  }
  /**
   * 返回固定注册的工具插件清单，供宿主检查身份和版本；不代表当前任务获得了其权限。
   * EN: Return fixed plugin identities and versions for host inspection; registration does not grant
   * those tools to a task.
   */
  pluginManifests() {
    return this.tools.describe();
  }
  /**
   * 查询工具的串行、事务、副作用和进展属性；未知工具返回 undefined 供运行时保守处理。
   * EN: Return transaction, serial, mutation, and progress properties. Unknown tools return undefined
   * for conservative runtime handling.
   */
  toolPolicy(name: string) {
    return this.tools.get(name)?.policy;
  }
  /**
   * 规划阶段按需加载计划模块后返回可用定义；加载发生在事务外。
   * 异步加载前后检查取消，之后重读任务，避免用旧状态生成权限清单。
   * EN: Load the plan module on demand during planning, outside SQLite transactions. Check
   * cancellation before and after loading, then reread the task before building its
   * permission-dependent catalogue.
   */
  async prepareDefinitions(task: Task, signal?: AbortSignal): Promise<ToolDefinition[]> {
    invariant(!this.closed, 'MODULE_DISPOSED', '工具插件已释放');
    signal?.throwIfAborted();
    task = this.store.require<Task>('tasks', task.id);
    if (
      this.store.require<Run>('runs', task.runId).kind !== 'chat' &&
      this.store.require<Run>('runs', task.runId).planMode !== false &&
      task.spec.role === 'coordinator' &&
      task.phase === 'planning'
    )
      await this.planAlignment.load();
    signal?.throwIfAborted();
    return this.definitions(this.store.require<Task>('tasks', task.id));
  }
  /**
   * 禁止新调用并共享一次释放 Promise；命令、MCP 和计划模块均尝试关闭，最终汇总错误。
   * EN: Reject new calls and share one disposal promise. Attempt command, MCP, and plan-module
   * cleanup, then aggregate failures.
   */
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([
        this.backgroundJobs.close(),
        Promise.resolve().then(() => this.cancelCommands()),
        Promise.resolve().then(() => this.mcp.close()),
        this.planAlignment.dispose(),
      ]);
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          '工具插件释放失败',
        );
    })();
    return this.closing;
  }
  /**
   * 按代理上下文窗口给目录分配有限预算；Codex 传输额外折半，保留固定指导和近期历史空间。
   * EN: Allocate bounded catalogue space from the agent context window, halving it again for Codex
   * transport and reserving room for fixed guidance and recent history.
   */
  private catalogueBudget(task: Task) {
    const agent = this.store.require<Agent>('agents', task.agentId),
      factor = agent.providerBinding.authMode === 'codex' ? 2 : 1;
    // 大部分实例窗口留给固定提示与近期完整工具组。
    // EN: Leave most of the instance window for fixed prompts and recent complete tool groups.
    return Math.max(
      1024,
      Math.min(MCP_CATALOGUE_BYTES, Math.floor(effectiveContextWindowTokens(agent) / 32 / factor)),
    );
  }
  /**
   * 通过内核取得当前Store，插件不会因这个内部访问器直接获得完整网关。
   * EN: Access the Store through the kernel; this internal getter does not expose the whole gateway to plugins.
   */
  get store() {
    return this.kernel.store;
  }
  /**
   * 核验中断后结果不明的操作：容器清理只记录停止结果；文件写入只有实际哈希等于
   * 写入前或写入后证据时才判定结果，其他情况继续等待用户核验。
   * EN: Verify interrupted operations with unknown outcomes. Container cleanup records stopping only;
   * resolve file writes only when current hashes match before/after evidence. Otherwise keep the user
   * verification path.
   */
  async recoverOperations() {
    this.backgroundJobs.recover();
    const containers: Operation[] = [];
    for (const key of this.store.recovery.candidates('tool_operations', ['UNCERTAIN']))
      this.store.recovery.apply<Operation>('tool_operations', key, (operation) => {
        if ((operation.evidence?.commandBackend as { kind?: string } | undefined)?.kind === 'docker')
          containers.push(operation);
      });
    if (containers.length) {
      let failure: string | undefined;
      try {
        invariant(this.commandRunner.recover, 'COMMAND_RECOVERY', '命令后端未提供恢复能力');
        await this.commandRunner.recover();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      for (const operation of containers)
        this.store.recovery.apply<Operation>('tool_operations', operation.id, (current) => {
          const recovery = { stopped: !failure, checkedAt: now(), ...(failure ? { error: failure } : {}) };
          this.store.put('tool_operations', {
            ...current,
            evidence: { ...current.evidence, containerRecovery: recovery },
          });
          this.kernel.event(
            current.runId,
            'tool.recovery',
            { operationId: current.id, ...recovery },
            current.taskId,
          );
        });
      // 停止容器不能证明副作用已撤销，仍保留UNCERTAIN。
      // EN: Stopping a container does not prove its side effects were undone; retain UNCERTAIN.
    }
    for (const key of this.store.recovery.candidates('tool_operations', ['UNCERTAIN'])) {
      let operation: Operation | undefined, task: Task | undefined;
      this.store.recovery.apply<Operation>('tool_operations', key, (value) => {
        if (
          value.status !== 'UNCERTAIN' ||
          !['write', 'apply_patch', 'materialize_artifact'].includes(value.name)
        )
          return;
        const owner = this.store.recovery.read<Task>('tasks', value.taskId);
        invariant(owner.runId === value.runId, 'RECOVERY_SCOPE', '恢复记录归属不一致');
        task = owner;
        operation = value;
      });
      if (!operation || !task) continue;
      const evidence = operation.evidence;
      if (!evidence || typeof evidence.path !== 'string' || typeof evidence.afterHash !== 'string') continue;
      try {
        const file = await this.path(task, evidence.path);
        let actualHash: string | null = null;
        try {
          actualHash = hash(await fs.readFile(file));
        } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (actualHash !== evidence.afterHash && actualHash !== evidence.beforeHash) continue;
        const applied = actualHash === evidence.afterHash;
        const recoveredTask = task,
          recoveredOperation = operation;
        this.store.recovery.apply<Operation>('tool_operations', operation.id, (currentOperation) => {
          const task = this.store.recovery.read<Task>('tasks', recoveredTask.id);
          if (
            currentOperation.revision !== recoveredOperation.revision ||
            currentOperation.status !== 'UNCERTAIN'
          )
            return;
          const updated = this.store.put('tool_operations', {
            ...currentOperation,
            status: applied ? ('DONE' as const) : ('FAILED' as const),
            result: applied
              ? { source: file, hash: actualHash, recovered: true }
              : { error: '核验原文哈希，写入未应用', recovered: true },
          });
          this.kernel.event(task.runId, 'tool.completed', updated, task.id, currentOperation.attemptId);
          if (
            !this.store.db
              .prepare(
                `SELECT 1 FROM tool_operations WHERE run_id=?
              AND json_extract(data,'$.readModel.taskId')=?
              AND COALESCE(json_extract(data,'$.status'),json_extract(data,'$.readModel.status'))='UNCERTAIN' LIMIT 1`,
              )
              .get(task.runId, task.id) &&
            task.status === 'WAITING' &&
            task.waitReason === 'verification'
          )
            this.kernel.updateTask(task, 'WAITING', { waitReason: 'interrupted' });
        });
      } catch {
        // 无法证明结果，保留用户核验入口。
        // EN: The result cannot be proved, so keep the user verification path available.
      }
    }
  }
  /**
   * 同步计算当前角色、阶段、运行类型与授权允许的工具。调用方先 prepareDefinitions，
   * 保证惰性模块已就绪；聊天、独立评审、规划和执行分别获得与其职责相符的贡献。
   * EN: Synchronously compute tools allowed by current role, phase, run kind, and permissions. Call
   * prepareDefinitions first to activate lazy contributions. Chat, peer-review, planning, and
   * execution receive their appropriate tools.
   */
  definitions(task: Task): ToolDefinition[] {
    invariant(!this.closed, 'MODULE_DISPOSED', '工具插件已释放');
    if (this.store.require<Run>('runs', task.runId).kind === 'chat')
      return (
        [
          'load_skill',
          'list_skills',
          'load_skill_file',
          'recall_context',
          'list_local_memories',
          'recall_local_memory',
        ] as const
      ).map((name) => this.tools.require(name).definition());
    const permission = this.kernel.permissions(task);
    let names: string[] = ['clarify', 'load_skill', 'list_skills', 'load_skill_file', 'recall_context'];
    if (permission.read)
      names.push(
        'list_local_memories',
        'recall_local_memory',
        'list_project_memories',
        'recall_project_memory',
      );
    if (
      task.phase === 'executing' &&
      permission.exec &&
      scopedLocalItems(this.store, this.store.require<Run>('runs', task.runId)).some(
        (item) => item.kind === 'mcp' && item.enabled,
      )
    ) {
      names.push('list_mcp_servers', 'mcp_list_tools');
      if (permission.write && task.spec.role !== 'reviewer') names.push('mcp_call');
    }
    if (
      this.store.require<Run>('runs', task.runId).planMode !== false &&
      task.spec.role === 'coordinator' &&
      task.phase === 'planning' &&
      this.planAlignment.loaded
    )
      names.push('propose_plan');
    if (permission.read) names.push('list', 'read', 'read_artifact', 'list_artifacts', 'search');
    if (permission.urls.length) names.push('fetch_url');
    if (task.phase === 'executing') {
      names.push(
        ...(task.peerReview
          ? ['read_peer_evidence', 'submit_peer_review']
          : ['join_tasks', 'list_children', 'submit_result']),
      );
      if (task.spec.role !== 'reviewer') {
        names.push('spawn_task', 'spawn_tasks', 'allocate_context');
        if (permission.write) {
          names.push('write', 'apply_patch', 'artifact');
          if (permission.read && this.store.require<Run>('runs', task.runId).source)
            names.push('materialize_artifact');
          const project = this.store.require<Project>(
            'projects',
            this.store.require<Run>('runs', task.runId).projectId!,
          );
          if (task.workspace ? task.baseline : project.baseline) names.push('diff', 'integrate_worktrees');
        }
        if (permission.exec) names.push('exec', 'job_start', 'job_read', 'job_cancel');
      }
    }
    return names.map((name) => this.tools.require(name).definition());
  }
  /** 作业执行或结果未知期间，整个运行禁止与其冲突的新副作用和验收。 */
  private assertBackgroundBoundary(task: Task, name: string) {
    if (!this.backgroundJobs.hasUnsettled(task.runId)) return;
    invariant(
      !this.tools.get(name)?.policy.mutating &&
        ![
          'submit_result',
          'submit_peer_review',
          'integrate_worktrees',
          'artifact',
          'diff',
          'spawn_task',
          'spawn_tasks',
          'allocate_context',
          'propose_plan',
        ].includes(name),
      'BACKGROUND_JOB_ACTIVE',
      '后台命令仍在运行或结果待核验；先读取/停止并核验作业，不能开始冲突操作或提交验收',
    );
  }
  /**
   * 将任务输入解析为实际路径并检查权限。读取可访问授权的项目源目录；写入必须同时
   * 位于任务工作区和允许写入的路径内，原始路径与解析路径均禁止访问 .git。
   * EN: Resolve a task input to its real path and check permissions. Reads may access the authorized
   * project source; writes must stay inside both the task workspace and allowed write roots. Reject
   * .git in original and resolved paths.
   */
  async path(task: Task, input: string, write = false) {
    const permission = this.kernel.permissions(task),
      project = this.store.require<Project>(
        'projects',
        this.store.require<Run>('runs', task.runId).projectId!,
      );
    invariant(
      write ? permission.write : permission.read,
      'PERMISSION_DENIED',
      write ? '写入未授权' : '读取未授权',
    );
    invariant(task.workspace, 'WORKSPACE_MISSING', '任务工作区尚未创建');
    const absolute = path.resolve(task.workspace, input);
    invariant(
      !absolute.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git'),
      'PATH_DENIED',
      '禁止访问 .git 内部目录',
    );
    const real = await resolved(absolute);
    invariant(
      !real.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git'),
      'PATH_DENIED',
      '禁止通过链接访问 .git 内部目录',
    );
    const own = await fs.realpath(task.workspace),
      source = await fs.realpath(project.workspaceRoot);
    invariant(
      contained(own, real) || (!write && contained(source, real)),
      'PATH_ESCAPE',
      '目标路径超出授权目录',
    );
    if (write) {
      invariant(contained(own, real), 'PATH_ESCAPE', '写入必须在本任务目录');
      const allowed = await Promise.all(permission.writePaths.map((p) => resolved(path.resolve(own, p))));
      invariant(
        allowed.some((root) => contained(own, root) && contained(root, real)),
        'WRITE_SCOPE',
        '写入超出指定目录',
      );
    }
    return real;
  }
  /**
   * 为项目任务准备工作区；已有基线时创建分离的 Git worktree，再保存任务状态。
   * EN: Prepare a project-task workspace, using a detached Git worktree when a baseline exists, then
   * persist the task workspace state.
   */
  async prepare(task: Task, signal: AbortSignal) {
    if (this.store.require<Run>('runs', task.runId).kind === 'chat') return task;
    if (task.workspace) {
      await fs.access(task.workspace);
      return task;
    }
    const directory = path.join(this.store.directory, 'workspaces', task.runId, task.id);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    const project = this.store.require<Project>(
      'projects',
      this.store.require<Run>('runs', task.runId).projectId!,
    );
    if (project.baseline) {
      try {
        await fs.access(path.join(directory, '.git'));
      } catch {
        const r = await this.processes.run(
          task.id,
          'git',
          ['-C', project.workspaceRoot, 'worktree', 'add', '--detach', directory, project.baseline],
          project.workspaceRoot,
          60000,
          20000,
          signal,
        );
        invariant(r.exitCode === 0, 'WORKTREE_FAILED', '创建 worktree 失败：' + r.stderr);
      }
    } else await fs.mkdir(directory, { recursive: true });
    return this.store.tx(() => {
      const current = this.store.require<Task>('tasks', task.id);
      const next = this.store.put('tasks', {
        ...current,
        workspace: directory,
        baseline: project.baseline,
      });
      this.kernel.event(task.runId, 'task.updated', next, task.id);
      return next;
    });
  }
  /**
   * 身份或副作用无法唯一核实时先持久进入 verification 等待，再抛错阻止自动重放。
   * EN: Persist a verification wait before raising an identity or uncertain-side-effect error,
   * preventing automatic replay.
   */
  private uncertainCall(task: Task, message: string): never {
    this.kernel.wait(this.store.require<Task>('tasks', task.id), 'verification');
    throw new AppError('OPERATION_UNCERTAIN', message);
  }
  /**
   * 将工具调用绑定到唯一的已记录模型消息，防止同一调用 ID 被更换参数重用。
   * EN: Bind the tool call to one recorded model message so a reused call ID cannot change its name or
   * arguments.
   */
  private callSource(task: Task, call: ToolCall, assistantMessageId?: string) {
    const sequence = inspectToolCalls(this.kernel.history(task));
    if (sequence.error) throw new AppError(sequence.error.code, sequence.error.message);
    const pending = sequence.pending.filter((item) => item.call.id === call.id);
    const candidates = assistantMessageId
      ? sequence.occurrences.filter(
          (item) => item.message.id === assistantMessageId && item.call.id === call.id,
        )
      : pending.length
        ? pending
        : sequence.occurrences.filter((item) => item.call.id === call.id);
    invariant(candidates.length === 1, 'TOOL_CALL_CONFLICT', '工具调用必须唯一对应已记录的模型响应');
    const source = candidates[0];
    invariant(
      source.call.name === call.name && source.call.arguments === call.arguments,
      'TOOL_CALL_CONFLICT',
      '不能更改同一条已记录工具调用的名称或参数',
    );
    return source.message.id;
  }
  /**
   * 查找同一消息的既有操作；旧记录缺少消息 ID 时，必须依靠回执或请求证据唯一配对。
   * EN: Find an operation for the same message. Legacy operations without message identity require a
   * unique receipt or original-request/attempt proof.
   */
  private previousCall(task: Task, call: ToolCall, assistantMessageId: string) {
    const operations = this.store.scheduling
      .operationIds(task.id)
      .map((key) => this.store.require<Operation>('tool_operations', key))
      .filter((operation) => operation.taskId === task.id && operation.toolCallId === call.id);
    const current = operations.filter((operation) => operation.assistantMessageId === assistantMessageId);
    const legacy = operations.filter((operation) => !operation.assistantMessageId);
    if (legacy.length) {
      // 旧操作没有回复身份，必须用配对回执或唯一原请求/尝试证明归属，供应商调用ID本身不足以证明。
      // EN: Legacy operations lack response identity. A paired receipt or unique original request/attempt
      // proves ownership; raw provider call IDs alone do not.
      const sessionId = this.store.require<Agent>('agents', task.agentId).sessionId;
      const requests = new Map(
        this.store
          .requestLedger({ runId: task.runId, taskId: task.id })
          .map((request) => [request.id, request]),
      );
      const sessions = new Map<string, Message[]>();
      for (const message of this.store.all<Message>('messages', task.runId)) {
        const messages = sessions.get(message.sessionId) ?? [];
        messages.push(message);
        sessions.set(message.sessionId, messages);
      }
      const occurrences = [...sessions.values()].flatMap((messages) => {
        if (
          messages[0].sessionId !== sessionId &&
          !messages.some((message) => message.requestId && requests.has(message.requestId))
        )
          return [];
        const sequence = inspectToolCalls(messages.sort((a, b) => a.ordinal - b.ordinal));
        if (sequence.error && messages.some((message) => message.calls?.some((item) => item.id === call.id)))
          this.uncertainCall(task, '旧工具调用记录无法唯一配对，请核验操作结果');
        return sequence.occurrences.filter((item) => item.call.id === call.id);
      });
      for (const operation of legacy) {
        const receipts = occurrences.filter((item) => {
          try {
            return item.result && JSON.parse(item.result.text)?.operationId === operation.id;
          } catch {
            return false;
          }
        });
        const candidates = receipts.length
          ? receipts
          : occurrences.filter((item) => {
              const request = item.message.requestId ? requests.get(item.message.requestId) : undefined;
              return request?.attemptId === operation.attemptId && request.taskId === task.id;
            });
        if (candidates.length !== 1)
          this.uncertainCall(task, '旧工具调用身份不明确，请核验已有操作，不能自动重跑');
        if (candidates[0].message.id === assistantMessageId) current.push(operation);
      }
    }
    if (current.length > 1) this.uncertainCall(task, '同一工具调用存在多条操作记录，请核验结果');
    return current[0];
  }
  /**
   * 校验授权、参数和调用来源后执行工具。已完成的同一调用复用结果，未确认的副作用
   * 转入核验，避免因重试重复执行。具体事务、串行和审核策略由工具贡献声明。
   * EN: Validate authorization, arguments, and source identity before executing. Replay completed
   * calls and send unconfirmed side effects to verification rather than executing twice. Contributions
   * declare transaction, serial, and review properties.
   */
  async call(
    task: Task,
    attempt: Attempt,
    call: ToolCall,
    signal: AbortSignal,
    assistantMessageId?: string,
  ): Promise<unknown> {
    task = this.store.require<Task>('tasks', task.id);
    const name = call.name;
    // 模块加载发生在SQLite事务外，跨过异步边界后重新读取状态。
    // EN: Load outside SQLite transactions and reread state after the asynchronous boundary.
    if (name === 'propose_plan') {
      await this.prepareDefinitions(task, signal);
      task = this.store.require<Task>('tasks', task.id);
    }
    invariant(
      this.definitions(task).some((t) => t.name === name),
      'TOOL_DENIED',
      `工具 ${name} 未授权`,
    );
    const contribution = this.tools.require(name);
    let args: Record<string, unknown>;
    try {
      const input = JSON.parse(call.arguments);
      args = contribution.parse(input);
    } catch (e) {
      throw new AppError('TOOL_ARGUMENTS', '工具参数无效：' + (e instanceof Error ? e.message : String(e)));
    }
    invariant(
      attempt.runId === task.runId && attempt.taskId === task.id,
      'TASK_SCOPE',
      '执行尝试不属于当前任务',
    );
    assistantMessageId = this.callSource(task, call, assistantMessageId);
    let previous = this.previousCall(task, call, assistantMessageId);
    if (previous) {
      // 先处理旧操作，再申请新审核；重放不得再次执行动作或再次向审核模型计费。
      // EN: Resolve an existing operation before requesting a new review; replay must neither execute the
      // action again nor charge another review-model request.
      if (!['DONE', 'FAILED'].includes(previous.status))
        this.uncertainCall(task, '副作用结果待核验，请在决定面板处理');
      invariant(
        previous.name === name && stable(previous.args) === stable(args),
        'TOOL_CALL_CONFLICT',
        '已记录调用与工具或参数不一致',
      );
      if (!previous.assistantMessageId)
        previous = this.store.put('tool_operations', { ...previous, assistantMessageId });
      if (previous.status === 'DONE') return { operationId: previous.id, result: previous.result };
      if (previous.status === 'FAILED') {
        const failure = previous.result as { error?: string; code?: string; retryable?: boolean } | undefined;
        throw new AppError(
          failure?.code ?? 'TOOL_ERROR',
          failure?.error ?? previous.error ?? '工具执行失败',
          failure?.retryable === true,
        );
      }
    }
    signal.throwIfAborted();
    this.assertBackgroundBoundary(task, name);
    /**
     * 重新读取所有影响授权的上下文并构造审核指纹输入，检测异步审核期间的变化。
     * EN: Reread authorization-relevant state and build review-fingerprint input to detect changes during asynchronous review.
     */
    const scope = () => {
      // 摘要绑定调用原文及所有影响授权的上下文，异步审核完成后可用同一规则检查变化。
      // EN: Bind the fingerprint to the recorded call and all authorization-relevant context so the same
      // rules can detect changes after asynchronous review.
      const current = this.store.require<Task>('tasks', task.id),
        run = this.store.require<Run>('runs', task.runId);
      return {
        runId: run.id,
        taskId: current.id,
        assistantMessageId,
        call,
        args,
        contract: run.contract,
        authorized: run.authorized,
        planVersion: run.acceptedPlanVersion,
        capabilities: run.capabilities?.hash,
        reviewer: run.toolReviewBinding,
        task: {
          spec: current.spec,
          workspace: current.workspace,
          phase: current.phase,
          contractVersion: current.contractVersion,
        },
        permissions: this.kernel.permissions(current),
      };
    };
    let review: ToolReviewReceipt | undefined;
    const policy = this.store.require<Run>('runs', task.runId).contract.toolReview;
    if (policy && policy.mode !== 'off' && (contribution.policy.mutating || name === 'mcp_list_tools')) {
      const context = scope(),
        fingerprint = hash(stable(context)),
        rules = reviewToolRules(name, args);
      review = { ...rules, fingerprint, mode: 'rules', reviewedAt: now() };
      if (rules.decision === 'allow' && policy.mode === 'model') {
        invariant(this.options.reviewModel, 'TOOL_REVIEW_UNAVAILABLE', '工具审核服务尚未装配，调用未执行');
        review = await this.options.reviewModel(
          { task, attempt, call, args, assistantMessageId, fingerprint, context },
          signal,
        );
      }
      signal.throwIfAborted();
      // 新收件箱要求即使尚未并入任务正文，也会使本次审核失效。
      // EN: Pending inbox requirements invalidate this review even before they are merged into the task
      // body.
      invariant(
        review.fingerprint === fingerprint &&
          hash(stable(scope())) === fingerprint &&
          !this.store.hasPendingInbox(task.runId),
        'TOOL_REVIEW_STALE',
        '审核期间任务、调用或授权已变化，调用未执行',
      );
      this.kernel.event(
        task.runId,
        'tool.reviewed',
        { name, callId: call.id, assistantMessageId, ...review },
        task.id,
        attempt.id,
      );
      if (review.decision !== 'allow') {
        // 拒绝同样登记为终结操作，使相同调用重放时返回原拒绝，而非重复审核。
        // EN: Persist denied decisions as terminal operations, so replay returns the original denial instead
        // of starting another review.
        this.store.put<Operation>('tool_operations', {
          id: id(),
          revision: 0,
          runId: task.runId,
          taskId: task.id,
          attemptId: attempt.id,
          toolCallId: call.id,
          assistantMessageId,
          name,
          args,
          status: 'FAILED',
          review,
          result: { code: 'TOOL_REVIEW_DENIED', error: review.reason },
        });
        throw new AppError('TOOL_REVIEW_DENIED', review.reason);
      }
    }
    task = this.store.require<Task>('tasks', task.id);
    const currentRun = this.store.require<Run>('runs', task.runId);
    // 审核可能跨越用户停止或归档操作，真正产生 INTENT 之前重新验证执行资格。
    // EN: Review can overlap stopping or archiving. Recheck execution eligibility before writing a new
    // INTENT.
    invariant(
      !currentRun.archived &&
        ['READY', 'RUNNING'].includes(currentRun.status) &&
        (!currentRun.projectId || !this.store.require<Project>('projects', currentRun.projectId).archived),
      'TASK_STOPPED',
      '运行或项目已停止',
    );
    invariant(
      this.definitions(task).some((t) => t.name === name),
      'TOOL_DENIED',
      '执行前工具授权已失效',
    );
    invariant(!this.store.getExecutionHold(task.runId), 'TASK_STOPPED', '当前执行已停止');
    invariant(task.status === 'RUNNING', 'TASK_STOPPED', '任务已停止，不能开始新工具操作');
    this.assertBackgroundBoundary(task, name);
    const operation: Operation = {
      id: id(),
      revision: 0,
      runId: task.runId,
      taskId: task.id,
      attemptId: attempt.id,
      toolCallId: call.id,
      assistantMessageId,
      name,
      args,
      status: 'INTENT',
      ...(review ? { review } : {}),
    };
    /**
     * 持久登记INTENT并发出开始事件，必须先于事务外副作用执行。
     * EN: Persist INTENT and its started event before any out-of-transaction side effect.
     */
    const begin = () => {
      // 在外部动作开始前记录意图，崩溃恢复才能区分从未执行与结果待核验。
      // EN: Record intent before external work starts so crash recovery can distinguish unstarted work
      // from an unconfirmed result.
      this.store.put('tool_operations', operation);
      this.kernel.event(
        task.runId,
        'tool.started',
        { operationId: operation.id, name, args },
        task.id,
        attempt.id,
      );
    };
    /**
     * 读取操作最新证据后保存DONE及结果，完成事件与终态同事务提交。
     * EN: Read the latest operation evidence and persist DONE/result together with the completion event.
     */
    const finish = (result: unknown) => {
      // 操作终态和完成事件同事务提交，界面不会先收到无法回查的完成通知。
      // EN: Commit operation terminal state and its completion event together, preventing completion
      // notifications without a persisted receipt.
      const op = this.store.require<Operation>('tool_operations', operation.id);
      this.store.put('tool_operations', { ...op, status: 'DONE', result });
      this.kernel.event(
        task.runId,
        'tool.completed',
        { operationId: op.id, name, result },
        task.id,
        attempt.id,
      );
      return { operationId: operation.id, result };
    };
    // 插件只提供动作；网关仍将内核动作与操作结果放在同一事务。
    // EN: Plugins supply actions only; the gateway keeps kernel changes and operation results in the
    // same transaction.
    const invocation = { task, attempt, operation, signal };
    if (contribution.policy.transaction)
      return this.store.tx(() => {
        begin();
        const result = contribution.execute(invocation, args);
        invariant(
          !(result && typeof (result as Promise<unknown>).then === 'function'),
          'PLUGIN_ASYNC_TRANSACTION',
          '事务工具不能返回异步操作',
        );
        return finish(result);
      });
    this.store.tx(begin);
    try {
      // 文件、网络和进程动作在事务外运行，避免等待 I/O 时占住 SQLite 写锁。
      // EN: Run file, network, and process actions outside SQLite transactions to avoid holding the write
      // lock while awaiting I/O.
      signal.throwIfAborted();
      const pending = contribution.execute(invocation, args);
      const result = pending instanceof Promise ? await pending : pending;
      return this.store.tx(() => finish(result));
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      this.store.tx(() => {
        const op = this.store.require<Operation>('tool_operations', operation.id);
        const uncertainty =
          contribution.policy.mutating &&
          ((name === 'mcp_call' && e instanceof AppError && e.code === 'MCP_CALL_UNCERTAIN') ||
            (name !== 'mcp_call' && signal.aborted) ||
            (e instanceof AppError && ['INTEGRATION_CONFLICT', 'COMMAND_CLEANUP'].includes(e.code)));
        // 取消或清理失败不等于副作用未发生；UNCERTAIN 必须保留给核验流程处理。
        // EN: Cancellation or failed cleanup does not prove that no side effect occurred. Keep UNCERTAIN for
        // the verification flow.
        this.store.put('tool_operations', {
          ...op,
          status: uncertainty ? 'UNCERTAIN' : 'FAILED',
          result: {
            error: e.message,
            code: e instanceof AppError ? e.code : 'TOOL_ERROR',
            retryable: e instanceof AppError ? e.retryable : false,
          },
          error: e.message,
        });
        this.kernel.event(
          task.runId,
          'tool.completed',
          { operationId: op.id, name, error: e.message, uncertain: uncertainty },
          task.id,
        );
        if (uncertainty) this.kernel.wait(this.store.require('tasks', task.id), 'verification');
      });
      throw error;
    }
  }
  /**
   * 保存一次资料来源快照并标记为不可信。相同任务、来源和内容摘要复用旧快照；
   * 新内容按该运行下同一来源的已有快照数递增版本，原文对象按内容摘要去重。
   * EN: Save an untrusted source snapshot. Reuse identical task/source/digest snapshots; new content
   * increments the version across this run source history, while content-addressed objects deduplicate
   * bytes.
   */
  snapshot(task: Task, source: string, content: Buffer) {
    const object = this.store.object(content),
      previous = this.store.scheduling
        .snapshotIds(task.runId, { source })
        .map((key) => this.store.require<Snapshot>('snapshots', key));
    const same = previous.find((s) => s.hash === object.hash && s.taskId === task.id);
    if (same) return same;
    return this.store.put<Snapshot>('snapshots', {
      id: id(),
      revision: 0,
      runId: task.runId,
      taskId: task.id,
      source,
      ...object,
      fetchedAt: now(),
      trust: 'untrusted',
      version: previous.length + 1,
    });
  }
  /**
   * 创建任务产物和可回查对象，同名产物递增版本；初始 verified=false，验收后才标为已核验。
   * EN: Create a task artifact with a retrievable object and increment same-name versions. Start with
   * verified=false and mark it verified only after acceptance.
   */
  artifact(task: Task, name: string, content: Buffer | string, source: string) {
    const object = this.store.object(content);
    return this.store.tx(() => {
      const artifact = this.store.put<Artifact>('artifacts', {
        id: id(),
        revision: 0,
        runId: task.runId,
        taskId: task.id,
        name,
        ...object,
        source,
        version: this.store.scheduling.artifactCount(task.id, name) + 1,
        verified: false,
        mediaType: fileMediaType(name, Buffer.from(content)),
      });
      this.kernel.event(task.runId, 'artifact.created', artifact, task.id);
      return artifact;
    });
  }
  /**
   * 将任务工作区全部变更暂存，再与冻结基线生成含二进制补丁的 changes.diff 产物。
   * 禁用外部 diff/textconv；命令失败或输出截断时拒绝发布不完整补丁。
   * EN: Stage all task-workspace changes and generate a binary-capable changes.diff against the frozen
   * baseline. Disable external diff and textconv; reject failed or truncated output instead of
   * publishing an incomplete patch.
   */
  async diff(task: Task, signal: AbortSignal) {
    invariant(task.baseline, 'GIT_REQUIRED', '当前任务没有 Git 基线，无法生成差异');
    const added = await this.processes.run(
      task.id,
      'git',
      ['add', '--all'],
      task.workspace!,
      10000,
      10000,
      signal,
    );
    invariant(added.exitCode === 0, 'DIFF_FAILED', added.stderr);
    const diff = await this.processes.run(
      task.id,
      'git',
      ['diff', '--cached', '--no-ext-diff', '--no-textconv', task.baseline!, '--binary'],
      task.workspace!,
      10000,
      200000,
      signal,
    );
    invariant(diff.exitCode === 0 && !diff.truncated, 'DIFF_FAILED', 'diff 失败或超过输出上限');
    return this.artifact(task, 'changes.diff', diff.stdout, 'git diff ' + task.baseline);
  }
  /**
   * 核验结果声明：必需子任务已完成、每项验收标准均有证据，且文件/产物/命令可回查。
   * 文件重新校验哈希；命令要求本任务成功且未超时；产物只能来自当前任务，
   * 或当前合同版本下已完成且标记 required 的直属子任务。
   * 若需要独立评分则先走评审门禁，否则同事务完成任务、产物验证标记、执行尝试及根运行。
   * EN: Verify result claims: required children completed, every acceptance criterion has evidence,
   * and files/artifacts/commands are retrievable. Rehash files; require successful, non-timeout
   * commands from this task. Accept artifacts only from this task or completed required direct
   * children in the current contract version. Apply the peer-review gate when required, otherwise
   * finish task, artifact verification, attempt, and root run together.
   */
  async submit(
    task: Task,
    args: { summary: string; evidence: Evidence[]; incomplete: string[] },
    signal: AbortSignal,
  ) {
    task = this.store.require<Task>('tasks', task.id);
    this.assertBackgroundBoundary(task, 'submit_result');
    const run = this.store.require<Run>('runs', task.runId);
    invariant(!args.incomplete.length, 'ACCEPTANCE_INCOMPLETE', '仍有未完成事项，不能验收');
    invariant(!task.peerReview, 'PEER_REVIEW_TOOL', '评审任务必须使用 submit_peer_review 提交逐项评分');
    const children = this.store
      .all<Task>('tasks', run.id)
      .filter(
        (t) => t.parentTaskId === task.id && t.spec.required && t.contractVersion === run.contract.version,
      );
    invariant(
      children.every((c) => c.status === 'DONE'),
      'CHILDREN_INCOMPLETE',
      '必需子任务尚未通过验收',
    );
    const checked = new Set<number>();
    for (const e of args.evidence) {
      invariant(e.criterion < task.spec.acceptanceCriteria.length, 'CRITERION_SCOPE', '验收项下标无效');
      if (e.type === 'file') {
        const p = await this.path(task, e.ref);
        invariant(
          e.hash && hash(await fs.readFile(p)) === e.hash,
          'EVIDENCE_MISMATCH',
          '文件哈希缺失或不匹配',
        );
      } else if (e.type === 'artifact') {
        const a = this.store.require<Artifact>('artifacts', e.ref);
        invariant(
          a.runId === run.id &&
            (a.taskId === task.id || children.some((c) => c.id === a.taskId && c.status === 'DONE')),
          'EVIDENCE_SCOPE',
          '产物越界',
        );
        this.store.readObject(a.objectRef);
      } else {
        const operation = this.store.require<Operation>('tool_operations', e.ref);
        invariant(
          operation.runId === run.id &&
            operation.taskId === task.id &&
            (operation.name === 'exec' || operation.name === 'job_execution') &&
            operation.status === 'DONE' &&
            (operation.result as any)?.exitCode === 0 &&
            !(operation.result as any)?.timedOut,
          'COMMAND_EVIDENCE',
          '命令证据必须来自本任务成功执行',
        );
      }
      checked.add(e.criterion);
    }
    invariant(
      checked.size === task.spec.acceptanceCriteria.length,
      'ACCEPTANCE_MISSING',
      '每个验收项都需要证据',
    );
    signal.throwIfAborted();
    return this.store.tx(() => {
      task = this.store.require<Task>('tasks', task.id);
      invariant(task.status === 'RUNNING', 'STOPPED', '任务已停止');
      // 证据读取包含异步边界，最终状态提交前重新检查任务；评分未通过时不会执行后续完成流程。
      // EN: Evidence reads cross asynchronous boundaries. Recheck task status before terminal persistence;
      // pending peer review prevents the completion path.
      const review = gatePeerReview(this.kernel, task, args);
      if (review) return review;
      this.kernel.updateTask(task, 'VERIFYING');
      const result = {
        summary: args.summary,
        evidence: args.evidence,
        verifiedAt: now(),
        limitation: '已核验文件、引用与命令结果；结论内容需用户复核',
        ...(run.contract.peerReview && task.id === run.rootTaskId
          ? {
              peerReviewCandidateId: this.store.require<Run>('runs', run.id).peerReview?.rounds.at(-1)
                ?.candidate.id,
            }
          : {}),
      };
      this.kernel.updateTask(this.store.require('tasks', task.id), 'DONE', { result });
      for (const e of args.evidence.filter((e) => e.type === 'artifact')) {
        const a = this.store.require<Artifact>('artifacts', e.ref);
        this.store.put('artifacts', { ...a, verified: true });
      }
      const a = this.store
        .all<Attempt>('attempts', run.id)
        .find((a) => a.taskId === task.id && a.status === 'ACTIVE');
      if (a) this.store.put('attempts', { ...a, status: 'DONE', lease: null });
      if (task.id === run.rootTaskId)
        this.kernel.updateRun(this.store.require('runs', run.id), { status: 'DONE', reason: undefined });
      return result;
    });
  }
  /**
   * 获取精确授权的 HTTP(S) 地址，最多跟随三次同样获得授权的跳转，并保存不可信资料快照。
   * 每跳重新检查协议、端口和全部 DNS 地址，再把连接固定到已检查的地址以减少重绑定风险。
   * 响应原文有 2 MiB 上限，返回给模型的文本预览最多 30000 个 UTF-16 单元。
   * EN: Fetch an exactly authorized HTTP(S) URL, following at most three separately authorized
   * redirects and saving an untrusted source snapshot. Recheck protocol, port, and every DNS result
   * per hop, then pin the connection to a verified address to reduce rebinding risk. Bound raw
   * response bytes to 2 MiB and model-visible text to 30000 UTF-16 units.
   */
  async fetch(task: Task, input: string, signal: AbortSignal) {
    const allowed = this.kernel.permissions(task).urls.map((u) => new URL(u).href);
    let url = new URL(input);
    const initial = url.href;
    invariant(allowed.includes(initial), 'URL_DENIED', 'URL 未明确授权');
    for (let redirects = 0; redirects <= 3; redirects++) {
      invariant(url.protocol === 'https:' || url.protocol === 'http:', 'URL_SCHEME', '只允许 HTTP(S)');
      invariant(
        !url.username && !url.password && (!url.port || ['80', '443'].includes(url.port)),
        'URL_DENIED',
        '禁止凭据与非标准端口',
      );
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
      invariant(
        addresses.length && addresses.every(({ address }) => isPublicAddress(address)),
        'URL_PRIVATE',
        '禁止访问本机、私网或保留地址',
      ); /* 每个跳转必须重新获得 URL 授权，fetch 不自动重定向。 EN: Every redirect requires fresh exact-URL authorization; fetch does not follow redirects automatically. */
      invariant(allowed.includes(url.href), 'REDIRECT_DENIED', '跳转 URL 未授权，请追加到授权列表');
      // 固定到已经检查的 DNS 地址，避免检查与连接之间的 DNS rebinding。
      // EN: Pin the connection to the already checked DNS address to reduce rebinding between validation
      // and connection.
      const pinned = addresses.find((a) => isIP(a.address) === 4) ?? addresses[0];
      const response = await pinnedRequest(url, pinned.address, signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.location;
        invariant(location && redirects < 3, 'REDIRECT_LIMIT', '跳转次数超限或缺少地址');
        url = new URL(location, url);
        continue;
      }
      invariant(
        response.status >= 200 && response.status < 300,
        'FETCH_FAILED',
        '网页返回 HTTP ' + response.status,
      );
      const body = response.body;
      const snapshot = this.snapshot(task, url.href, body);
      return {
        source: url.href,
        fetchedAt: snapshot.fetchedAt,
        trust: 'untrusted',
        snapshotId: snapshot.id,
        hash: snapshot.hash,
        content: body.toString('utf8').slice(0, 30000),
        truncated: body.length > 30000,
      };
    }
    throw new AppError('REDIRECT_LIMIT', '跳转超限');
  }
}
/**
 * 使用已核验 IP 发出一次请求，保留 URL 的主机与 TLS 语义；20 秒超时与调用取消共同生效。
 * 不自动跟随重定向，返回 Location 供上层重新授权；普通正文按原始字节累计限制为 2 MiB。
 * EN: Make one request to a verified IP while retaining URL host and TLS semantics. Combine caller
 * cancellation with a twenty-second timeout. Return redirect Location for upper-layer authorization
 * instead of following it, and bound normal body bytes to 2 MiB.
 */
function pinnedRequest(
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<{ status: number; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: {
          Accept: 'text/plain, text/html, application/json, text/csv',
          'Accept-Encoding': 'identity',
        },
        family: isIP(address),
        /**
         * HTTP连接固定返回已验证IP，禁止连接阶段重新进行DNS解析。
         * EN: Return the already verified IP from HTTP lookup, preventing a fresh DNS resolution at connection time.
         */
        lookup: (_host, _options, callback) => callback(null, address, isIP(address)),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          resolve({ status, location: response.headers.location, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            response.destroy(new AppError('FETCH_TOO_LARGE', '网页超过 2 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}
/**
 * 过滤此模块列出的私有、回环、组播及保留地址段；输入应来自 IP 解析而非任意主机名。
 * EN: Reject the private, loopback, multicast, and reserved ranges listed here. Inputs should come
 * from IP parsing rather than arbitrary hostnames.
 */
export function isPublicAddress(address: string) {
  const a = address.toLowerCase();
  if (a.includes(':'))
    return !(/^(::|fc|fd|fe[89ab]|ff)/.test(a) || a.startsWith('2001:db8') || a.startsWith('::ffff:'));
  const parts = a.split('.').map(Number),
    [first, second] = parts;
  return (
    parts.length === 4 &&
    !(
      [0, 10, 127].includes(first) ||
      first >= 224 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && [0, 168].includes(second)) ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 198 && [18, 19, 51].includes(second)) ||
      (first === 203 && second === 0)
    )
  );
}
