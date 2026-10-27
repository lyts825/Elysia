// 协调工具调用、权限检查、执行和结果处理。
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
export { cleanEnv, Processes } from './processes.js';
export class ToolGateway {
  processes = new Processes();
  readonly commandRunner: CommandRunner;
  readonly mcp = new McpClient();
  readonly planAlignment: PlanAlignmentHost;
  private readonly tools: ReturnType<typeof builtinTools>;
  private closing?: Promise<void>;
  private closed = false;
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
    this.planAlignment = new PlanAlignmentHost(
      { propose: kernel.propose.bind(kernel), accept: kernel.accept.bind(kernel) },
      options.planAlignmentLoader,
    );
    this.tools = builtinTools(pluginServices(this, this.catalogueBudget.bind(this)), this.planAlignment);
  }
  async cancelCommands(taskIds?: Set<string>) {
    const results = await Promise.allSettled([
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
    // Revalidate the resolved cwd at the execution boundary.
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
    // Partial file-write grants must never become a writable mount of the entire workspace.
    const writable = permission.write && allowedWrites.some((root) => root === workspace);
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
        timeout: args.timeout,
        outputLimit: args.outputLimit,
        writable,
        backend,
      },
      signal,
    );
  }
  pluginManifests() {
    return this.tools.describe();
  }
  toolPolicy(name: string) {
    return this.tools.get(name)?.policy;
  }
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
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([
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
  private catalogueBudget(task: Task) {
    const agent = this.store.require<Agent>('agents', task.agentId),
      factor = agent.providerBinding.authMode === 'codex' ? 2 : 1;
    // Leave most of the instance window for fixed prompts and recent complete tool groups.
    return Math.max(
      1024,
      Math.min(MCP_CATALOGUE_BYTES, Math.floor(effectiveContextWindowTokens(agent) / 32 / factor)),
    );
  }
  get store() {
    return this.kernel.store;
  }
  /**
   * 核验中断后结果不明的操作：容器清理只记录停止结果；文件写入只有实际哈希等于
   * 写入前或写入后证据时才判定结果，其他情况继续等待用户核验。
   */
  async recoverOperations() {
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
      // Stopping a container never proves its side effects were undone. Keep UNCERTAIN.
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
        /* 无法证明结果，保留用户核验入口。 */
      }
    }
  }
  /** Synchronous view of active contributions; runtime callers prepare them first. */
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
    if (permission.read) names.push('list', 'read', 'read_artifact', 'search');
    if (permission.urls.length) names.push('fetch_url');
    if (task.phase === 'executing') {
      names.push(
        ...(task.peerReview ? ['read_peer_evidence', 'submit_peer_review'] : ['join_tasks', 'submit_result']),
      );
      if (task.spec.role !== 'reviewer') {
        names.push('spawn_task', 'allocate_context');
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
        if (permission.exec) names.push('exec');
      }
    }
    return names.map((name) => this.tools.require(name).definition());
  }
  /**
   * 将任务输入解析为实际路径并检查权限。读取可访问授权的项目源目录；写入必须同时
   * 位于任务工作区和允许写入的路径内，原始路径与解析路径均禁止访问 .git。
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
  /** 为项目任务准备工作区；已有基线时创建分离的 Git worktree，再保存任务状态。 */
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
  private uncertainCall(task: Task, message: string): never {
    this.kernel.wait(this.store.require<Task>('tasks', task.id), 'verification');
    throw new AppError('OPERATION_UNCERTAIN', message);
  }
  /** 将工具调用绑定到唯一的已记录模型消息，防止同一调用 ID 被更换参数重用。 */
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
  /** 查找同一消息的既有操作；旧记录缺少消息 ID 时，必须依靠回执或请求证据唯一配对。 */
  private previousCall(task: Task, call: ToolCall, assistantMessageId: string) {
    const operations = this.store
      .all<Operation>('tool_operations', task.runId)
      .filter((operation) => operation.taskId === task.id && operation.toolCallId === call.id);
    const current = operations.filter((operation) => operation.assistantMessageId === assistantMessageId);
    const legacy = operations.filter((operation) => !operation.assistantMessageId);
    if (legacy.length) {
      // Legacy operations have no response identity. A paired operation receipt or a
      // unique original request/attempt proves ownership; raw provider IDs alone do not.
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
    // Load outside SQLite transactions; re-read state after the asynchronous boundary.
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
    const scope = () => {
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
    const begin = () => {
      this.store.put('tool_operations', operation);
      this.kernel.event(
        task.runId,
        'tool.started',
        { operationId: operation.id, name, args },
        task.id,
        attempt.id,
      );
    };
    const finish = (result: unknown) => {
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
  snapshot(task: Task, source: string, content: Buffer) {
    const object = this.store.object(content),
      previous = this.store.all<Snapshot>('snapshots', task.runId).filter((s) => s.source === source);
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
        version:
          this.store
            .all<Artifact>('artifacts', task.runId)
            .filter((a) => a.taskId === task.id && a.name === name).length + 1,
        verified: false,
        mediaType: fileMediaType(name, Buffer.from(content)),
      });
      this.kernel.event(task.runId, 'artifact.created', artifact, task.id);
      return artifact;
    });
  }
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
  async submit(
    task: Task,
    args: { summary: string; evidence: Evidence[]; incomplete: string[] },
    signal: AbortSignal,
  ) {
    task = this.store.require<Task>('tasks', task.id);
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
            operation.name === 'exec' &&
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
      ); // 每个跳转必须重新获得 URL 授权，fetch 不自动重定向。
      invariant(allowed.includes(url.href), 'REDIRECT_DENIED', '跳转 URL 未授权，请追加到授权列表');
      // 固定到已经检查的 DNS 地址，避免检查与连接之间的 DNS rebinding。
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
