import {
  UsageSchema,
  AppError,
  Contract,
  Plan,
  TaskSpec,
  invariant,
  type Run,
  type Task,
  type Agent,
  type Attempt,
  type ProviderConfig,
  type Project,
  type Message,
  type RequestRecord,
  type Usage,
  type Permissions,
} from '../../contracts/src/index.js';
import { Store, id, now, stable } from '../../storage/src/index.js';
export class Kernel {
  constructor(public store: Store) {}
  event(runId: string, type: string, payload: unknown, taskId?: string, attemptId?: string) {
    return this.store.event(runId, type, payload, taskId, attemptId);
  }
  updateTask(task: Task, status: Task['status'], extra: Partial<Task> = {}) {
    return this.store.tx(() => {
      const next = this.store.put('tasks', { ...task, ...extra, status }, task.revision);
      this.event(task.runId, 'task.updated', next, task.id);
      const agent = this.store.require<Agent>('agents', task.agentId);
      this.store.put('agents', { ...agent, status });
      return next;
    });
  }
  updateRun(run: Run, extra: Partial<Run>) {
    return this.store.tx(() => {
      const next = this.store.put('runs', { ...run, ...extra }, run.revision);
      this.event(run.id, 'run.updated', next);
      return next;
    });
  }
  createRun(
    project: Project,
    objective: string,
    provider: ProviderConfig,
    contract: Contract,
    limits: Run['limits'],
  ) {
    return this.store.tx(() => {
      invariant(
        provider.checkedRevision === provider.revision,
        'PROVIDER_UNCHECKED',
        '请先在设置页验证模型连通性',
      );
      const runId = id(),
        taskId = id(),
        agentId = id();
      const run = this.store.put<Run>('runs', {
        id: runId,
        revision: 0,
        projectId: project.id,
        objective,
        contract,
        plan: null,
        status: 'READY',
        coordinatorAgentId: agentId,
        rootTaskId: taskId,
        limits,
        authorized: false,
        acceptedPlanVersion: null,
        startedAt: null,
        createdAt: now(),
      });
      const spec = TaskSpec.parse({
        key: 'root',
        title: objective.slice(0, 60),
        objective,
        mode: contract.mode,
        role: 'coordinator',
        providerId: provider.id,
        deliverables: contract.deliverables,
        acceptanceCriteria: contract.acceptanceCriteria,
      });
      this.store.put<Agent>('agents', {
        id: agentId,
        revision: 0,
        runId,
        parentAgentId: null,
        taskId,
        providerId: provider.id,
        providerBinding: provider,
        sessionId: id(),
        status: 'READY',
        profileVersion: '1',
      });
      this.store.put<Task>('tasks', {
        contractVersion: contract.version,
        id: taskId,
        revision: 0,
        runId,
        parentTaskId: null,
        agentId,
        spec,
        status: 'READY',
        phase: 'planning',
        depth: 0,
        workspace: null,
        baseline: project.baseline,
        waitingFor: [],
      });
      this.event(runId, 'run.updated', run);
      return run;
    });
  }
  permissions(task: Task): Permissions {
    const run = this.store.require<Run>('runs', task.runId);
    if (task.phase === 'planning' || task.spec.role === 'reviewer')
      return { ...run.contract.permissionProfile, write: false, exec: false };
    invariant(
      run.authorized && run.acceptedPlanVersion === run.plan?.version,
      'NOT_AUTHORIZED',
      '尚未接受当前计划',
    );
    return run.contract.permissionProfile;
  }
  ancestors(task: Task): Task[] {
    const result = [task];
    let current = task;
    while (current.parentTaskId) {
      current = this.store.require<Task>('tasks', current.parentTaskId);
      invariant(!result.some((t) => t.id === current.id), 'CYCLE', '父子关系存在环');
      result.push(current);
    }
    return result;
  }
  descendants(task: Task): Task[] {
    return this.store
      .all<Task>('tasks', task.runId)
      .filter((t) => this.ancestors(t).some((a) => a.id === task.id));
  }
  dependencies(task: Task): string[] {
    return this.store.db
      .prepare('SELECT dependency_id id FROM task_edges WHERE task_id=?')
      .all(task.id)
      .map((r: any) => r.id);
  }
  checkGraph(tasks: { id: string; deps: string[] }[]) {
    const graph = new Map(tasks.map((t) => [t.id, t.deps]));
    const visited = new Set<string>(),
      active = new Set<string>();
    const visit = (key: string) => {
      invariant(graph.has(key), 'DEPENDENCY_MISSING', `依赖 ${key} 不存在`);
      invariant(!active.has(key), 'CYCLE', '任务依赖或等待关系存在环');
      if (visited.has(key)) return;
      active.add(key);
      for (const dep of graph.get(key)!) visit(dep);
      active.delete(key);
      visited.add(key);
    };
    for (const task of tasks) visit(task.id);
  }
  graph(runId: string, addition?: { id: string; deps: string[] }) {
    const tasks = this.store.all<Task>('tasks', runId);
    const graph = tasks.map((t) => ({
      id: t.id,
      deps: [
        ...this.dependencies(t),
        ...t.waitingFor,
        ...tasks.filter((c) => c.parentTaskId === t.id && c.spec.required).map((c) => c.id),
      ],
    }));
    if (addition) {
      const existing = graph.find((t) => t.id === addition.id);
      if (existing) existing.deps.push(...addition.deps);
      else graph.push(addition);
    }
    return graph;
  }
  propose(task: Task, rawContract: unknown, rawPlan: unknown) {
    return this.store.tx(() => {
      const run = this.store.require<Run>('runs', task.runId);
      invariant(task.id === run.rootTaskId, 'ROLE_DENIED', '只有总代理可以提出计划');
      invariant(task.phase === 'planning', 'PHASE_DENIED', '计划只能在需求检查点提出');
      const contract = Contract.parse(rawContract),
        plan = Plan.parse(rawPlan);
      invariant(
        contract.version === run.contract.version &&
          plan.contractVersion === contract.version &&
          plan.version === (run.plan?.version ?? 0) + 1,
        'PLAN_VERSION',
        '约定或计划版本不匹配',
      );
      invariant(
        stable(contract.permissionProfile) === stable(run.contract.permissionProfile) &&
          stable(contract.budget) === stable(run.contract.budget) &&
          contract.mode === run.contract.mode,
        'PLAN_ESCALATION',
        '计划不能改变用户授权、预算和根模式',
      );
      invariant(
        plan.tasks.length + this.store.all<Agent>('agents', run.id).length <= run.limits.maxAgents,
        'AGENT_LIMIT',
        '计划超出代理总量',
      );
      const keys = plan.tasks.map((t) => t.key);
      invariant(
        new Set(keys).size === keys.length && !keys.includes('root'),
        'TASK_KEYS',
        '任务 key 必须唯一且不能是 root',
      );
      this.checkGraph(plan.tasks.map((t) => ({ id: t.key, deps: t.dependsOn })));
      for (const child of plan.tasks) {
        const binding = this.store.require<ProviderConfig>('providers', child.providerId);
        invariant(
          binding.checkedRevision === binding.revision,
          'PROVIDER_UNCHECKED',
          `模型 ${binding.label} 未验证`,
        );
        if (child.budget) this.checkBudgetSubset(child.budget, contract.budget);
      }
      for (const snapshotId of plan.snapshotIds)
        invariant(
          this.store.get<any>('snapshots', snapshotId)?.runId === run.id,
          'SNAPSHOT_SCOPE',
          '资料快照越界',
        );
      const next = this.updateRun(run, {
        contract,
        plan,
        authorized: false,
        status: 'WAITING',
        reason: 'plan',
      });
      this.wait(task, 'plan');
      this.event(run.id, 'plan.proposed', { contract, plan });
      return {
        runId: run.id,
        planVersion: plan.version,
        waiting: true,
        revision: this.store.require<Run>('runs', run.id).revision,
      };
    });
  }
  checkBudgetSubset(child: Run['contract']['budget'], parent: Run['contract']['budget']) {
    invariant(
      child.maxRequests <= parent.maxRequests &&
        child.maxTokens <= parent.maxTokens &&
        (parent.maxCost === null || (child.maxCost !== null && child.maxCost <= parent.maxCost)),
      'BUDGET_ESCALATION',
      '子任务预算不得扩大祖先预算',
    );
  }
  spawn(parent: Task, raw: unknown) {
    return this.store.tx(() => {
      parent = this.store.require<Task>('tasks', parent.id);
      const run = this.store.require<Run>('runs', parent.runId);
      this.permissions(parent);
      invariant(
        parent.phase === 'executing' && parent.spec.role !== 'reviewer',
        'SPAWN_DENIED',
        '当前阶段禁止委派',
      );
      invariant(parent.depth < run.limits.maxDepth, 'DEPTH_LIMIT', '委派深度达到上限');
      invariant(
        this.store.all<Agent>('agents', run.id).length < run.limits.maxAgents,
        'AGENT_LIMIT',
        '代理数量达到上限',
      );
      const spec = TaskSpec.parse(raw);
      invariant(
        !this.store.all<Task>('tasks', run.id).some((t) => t.spec.key === spec.key),
        'TASK_KEY_EXISTS',
        '任务 key 已存在',
      );
      const binding = this.store.require<ProviderConfig>('providers', spec.providerId);
      invariant(binding.checkedRevision === binding.revision, 'PROVIDER_UNCHECKED', '模型尚未验证');
      if (spec.budget)
        for (const ancestor of this.ancestors(parent))
          this.checkBudgetSubset(spec.budget, ancestor.spec.budget ?? run.contract.budget);
      const taskId = id(),
        agentId = id();
      const deps = spec.dependsOn.map((key) => {
        const t = this.store.all<Task>('tasks', run.id).find((t) => t.id === key || t.spec.key === key);
        invariant(t, 'DEPENDENCY_MISSING', `依赖 ${key} 不存在`);
        invariant(
          !this.ancestors(parent).some((a) => a.id === t.id),
          'CYCLE',
          '子任务不能依赖尚待子任务交付的祖先',
        );
        return t.id;
      });
      const child = this.store.put<Task>('tasks', {
        contractVersion: run.contract.version,
        id: taskId,
        revision: 0,
        runId: run.id,
        parentTaskId: parent.id,
        agentId,
        spec,
        depth: parent.depth + 1,
        status: 'READY',
        phase: 'executing',
        workspace: null,
        baseline: parent.baseline,
        waitingFor: [],
      });
      this.store.put<Agent>('agents', {
        id: agentId,
        revision: 0,
        runId: run.id,
        parentAgentId: parent.agentId,
        taskId,
        providerId: spec.providerId,
        providerBinding: binding,
        sessionId: id(),
        status: 'READY',
        profileVersion: '1',
      });
      for (const dep of deps) this.store.db.prepare('INSERT INTO task_edges VALUES(?,?)').run(taskId, dep);
      this.checkGraph(this.graph(run.id));
      this.event(run.id, 'task.updated', child, taskId);
      return { taskId, agentId, key: spec.key };
    });
  }
  accept(runId: string, version: number, expectedRevision: number) {
    return this.store.tx(() => {
      let run = this.store.require<Run>('runs', runId);
      invariant(run.revision === expectedRevision, 'REVISION_CONFLICT', '记录已更新，请刷新');
      invariant(run.plan?.version === version, 'PLAN_VERSION', '计划版本不匹配');
      invariant(run.status === 'WAITING' && run.reason === 'plan', 'INVALID_STATE', '当前未等待计划接受');
      run = this.updateRun(run, {
        authorized: true,
        acceptedPlanVersion: version,
        status: 'READY',
        reason: undefined,
        startedAt: run.startedAt ?? Date.now(),
      });
      let root = this.store.require<Task>('tasks', run.rootTaskId);
      root = this.updateTask(root, 'READY', {
        contractVersion: run.contract.version,
        phase: 'executing',
        waitReason: undefined,
        spec: {
          ...root.spec,
          deliverables: run.contract.deliverables,
          acceptanceCriteria: run.contract.acceptanceCriteria,
        },
      });
      const created = new Map<string, string>();
      const pending = [...run.plan!.tasks];
      while (pending.length) {
        const index = pending.findIndex((t) => t.dependsOn.every((key) => created.has(key)));
        invariant(index >= 0, 'CYCLE', '计划依赖成环');
        const spec = pending.splice(index, 1)[0];
        const child = this.spawn(root, { ...spec, dependsOn: spec.dependsOn.map((key) => created.get(key)) });
        created.set(spec.key, child.taskId);
      }
      this.appendMessage(
        root,
        'user',
        '用户已接受计划 v' +
          version +
          '。请按验收项执行；子任务已由内核创建，请先等待其交付，然后集成并核验。',
      );
      return run;
    });
  }
  appendMessage(task: Task, role: Message['role'], text: string, extra: Partial<Message> = {}) {
    const agent = this.store.require<Agent>('agents', task.agentId);
    const ordinal =
      this.store.all<Message>('messages', task.runId).filter((m) => m.sessionId === agent.sessionId).length +
      1;
    const message = this.store.put<Message>('messages', {
      id: id(),
      revision: 0,
      runId: task.runId,
      sessionId: agent.sessionId,
      ordinal,
      role,
      text,
      ...extra,
    });
    this.event(task.runId, 'message.completed', message, task.id);
    return message;
  }
  claim(taskId: string) {
    return this.store.tx(() => {
      const task = this.store.require<Task>('tasks', taskId),
        run = this.store.require<Run>('runs', task.runId);
      invariant(
        task.status === 'READY' && ['READY', 'RUNNING'].includes(run.status),
        'INVALID_STATE',
        '任务当前不可执行',
      );
      invariant(
        this.dependencies(task).every((key) => this.store.require<Task>('tasks', key).status === 'DONE'),
        'DEPENDENCIES_PENDING',
        '依赖尚未完成',
      );
      let attempt = this.store
        .all<Attempt>('attempts', task.runId)
        .find((a) => a.taskId === task.id && ['ACTIVE', 'WAITING'].includes(a.status));
      if (!attempt)
        attempt = {
          id: id(),
          revision: 0,
          runId: task.runId,
          taskId: task.id,
          agentId: task.agentId,
          sequence:
            this.store.all<Attempt>('attempts', task.runId).filter((a) => a.taskId === task.id).length + 1,
          status: 'ACTIVE',
          lease: null,
          steps: 0,
          checkpointRef: null,
        };
      attempt = this.store.put<Attempt>('attempts', {
        ...attempt,
        status: 'ACTIVE',
        lease: Date.now() + 120000,
      });
      this.updateTask(task, 'RUNNING', { waitReason: undefined });
      if (run.status !== 'RUNNING') this.updateRun(run, { status: 'RUNNING' });
      this.event(
        task.runId,
        'agent.started',
        { agentId: task.agentId, attemptId: attempt.id },
        task.id,
        attempt.id,
      );
      return attempt;
    });
  }
  checkpoint(attemptId: string) {
    return this.store.tx(() => {
      const a = this.store.require<Attempt>('attempts', attemptId),
        task = this.store.require<Task>('tasks', a.taskId);
      const checkpoint = this.store.put('checkpoints', {
        id: id(),
        revision: 0,
        runId: task.runId,
        taskId: task.id,
        attemptId,
        taskRevision: task.revision,
        messageCount: this.history(task).length,
        waitingFor: task.waitingFor,
        pending: this.store
          .all<any>('tool_operations', task.runId)
          .filter((o) => o.attemptId === attemptId && !['DONE', 'FAILED'].includes(o.status))
          .map((o) => o.id),
        createdAt: now(),
      });
      return this.store.put('attempts', {
        ...a,
        checkpointRef: checkpoint.id,
        lease: a.status === 'ACTIVE' ? Date.now() + 120000 : null,
      });
    });
  }
  history(task: Task) {
    const agent = this.store.require<Agent>('agents', task.agentId);
    return this.store.all<Message>('messages', task.runId).filter((m) => m.sessionId === agent.sessionId);
  }
  wait(task: Task, reason: string, ids: string[] = []) {
    return this.store.tx(() => {
      for (const key of ids)
        invariant(
          this.store.get<Task>('tasks', key)?.runId === task.runId && key !== task.id,
          'WAIT_SCOPE',
          '等待对象越界或为自身',
        );
      this.checkGraph(this.graph(task.runId, { id: task.id, deps: ids }));
      this.updateTask(this.store.require('tasks', task.id), 'WAITING', {
        waitReason: reason,
        waitingFor: ids,
      });
      const a = this.store
        .all<Attempt>('attempts', task.runId)
        .find((a) => a.taskId === task.id && a.status === 'ACTIVE');
      if (a) {
        this.store.put('attempts', { ...a, status: 'WAITING', lease: null });
        this.checkpoint(a.id);
      }
      if (reason !== 'children') {
        const run = this.store.require<Run>('runs', task.runId);
        if (task.id === run.rootTaskId) this.updateRun(run, { status: 'WAITING', reason });
        this.event(task.runId, 'decision.required', { taskId: task.id, reason }, task.id);
      }
      return { waiting: true, reason };
    });
  }
  reserve(
    task: Task,
    attempt: Attempt,
    provider: ProviderConfig,
    manifest: Record<string, unknown>,
    tokens: number,
    logicalId: string,
  ) {
    return this.store.tx(() => {
      const run = this.store.require<Run>('runs', task.runId);
      invariant(['READY', 'RUNNING'].includes(run.status), 'STOPPED', '运行已停止');
      invariant(
        !run.startedAt || Date.now() - run.startedAt < run.limits.maxMinutes * 60000,
        'TIME_BUDGET',
        '运行时间达到上限',
      );
      const requests = this.store.all<RequestRecord>('requests', run.id);
      const price = provider.prices;
      const reservedCost = price
        ? (tokens * (Math.max(price.input, price.cacheRead) + (price.cacheWrite ?? 0)) +
            provider.outputLimit * price.output) /
          1e6
        : null;
      for (const ancestor of this.ancestors(task)) {
        const budget = ancestor.spec.budget ?? run.contract.budget,
          descendants = new Set(this.descendants(ancestor).map((t) => t.id));
        const scoped = requests.filter((r) => descendants.has(r.taskId));
        invariant(scoped.length < budget.maxRequests, 'REQUEST_BUDGET', '模型请求次数达到上限');
        const totalTokens = scoped.reduce(
          (sum, r) =>
            sum +
            (r.status === 'RELEASED'
              ? 0
              : r.status === 'SETTLED'
                ? (r.usage?.inputTotal ?? r.reservedTokens) + (r.usage?.outputTotal ?? 0)
                : r.reservedTokens),
          0,
        );
        invariant(
          totalTokens + tokens + provider.outputLimit <= budget.maxTokens,
          'TOKEN_BUDGET',
          'Token 预算不足',
        );
        if (budget.maxCost !== null) {
          invariant(
            reservedCost !== null &&
              scoped.every((r) => r.providerBinding.prices?.currency === price?.currency),
            'PRICE_UNKNOWN',
            '货币预算需要全部模型价格与相同币种',
          );
          invariant(
            scoped.reduce(
              (sum, r) => sum + (r.status === 'RELEASED' ? 0 : (r.usage?.cost ?? r.reservedCost ?? 0)),
              0,
            ) +
              reservedCost <=
              budget.maxCost,
            'COST_BUDGET',
            '货币预算不足',
          );
        }
      }
      const request = this.store.put<RequestRecord>('requests', {
        id: id(),
        revision: 0,
        runId: run.id,
        taskId: task.id,
        attemptId: attempt.id,
        logicalId,
        providerId: provider.id,
        providerBinding: provider,
        manifest,
        reservedTokens: tokens + provider.outputLimit,
        reservedCost,
        status: 'RESERVED',
        usage: null,
        startedAt: Date.now(),
      });
      return request;
    });
  }
  settle(requestId: string, usage: Usage | null, error?: string, rejected = false) {
    if (usage) UsageSchema.parse(usage);
    return this.store.tx(() => {
      const r = this.store.require<RequestRecord>('requests', requestId);
      if (r.status !== 'RESERVED' && r.status !== 'UNKNOWN') return r;
      const next = this.store.put('requests', {
        ...r,
        status:
          usage?.inputTotal !== null && usage?.inputTotal !== undefined && usage?.outputTotal !== null
            ? ('SETTLED' as const)
            : rejected
              ? ('RELEASED' as const)
              : ('UNKNOWN' as const),
        usage,
        error,
      });
      this.event(r.runId, 'usage.updated', next, r.taskId, r.attemptId);
      return next;
    });
  }
  action(runId: string, action: 'start' | 'pause' | 'resume' | 'cancel', taskId?: string) {
    return this.store.tx(() => {
      const run = this.store.require<Run>('runs', runId);
      invariant(!['DONE', 'CANCELLED'].includes(run.status), 'INVALID_STATE', '运行已结束');
      const root = this.store.require<Task>('tasks', taskId ?? run.rootTaskId);
      invariant(root.runId === runId, 'TASK_SCOPE', '任务不属于此运行');
      const tasks = this.descendants(root);
      if (action === 'cancel') {
        for (const t of tasks.filter((t) => !['DONE', 'CANCELLED'].includes(t.status))) {
          this.updateTask(t, 'CANCELLED', { waitReason: undefined });
          for (const a of this.store
            .all<Attempt>('attempts', runId)
            .filter((a) => a.taskId === t.id && ['ACTIVE', 'WAITING'].includes(a.status)))
            this.store.put('attempts', { ...a, status: 'CANCELLED', lease: null });
        }
        if (!taskId || taskId === run.rootTaskId)
          this.updateRun(run, { status: 'CANCELLED', reason: 'user' });
      } else if (action === 'pause') {
        for (const t of tasks.filter((t) => ['READY', 'RUNNING'].includes(t.status))) this.wait(t, 'paused');
        if (!taskId || taskId === run.rootTaskId)
          this.updateRun(this.store.require('runs', runId), { status: 'WAITING', reason: 'paused' });
      } else {
        invariant(run.authorized || root.phase === 'planning', 'NOT_AUTHORIZED', '请先接受具体计划');
        for (const t of tasks.filter(
          (t) =>
            t.status === 'FAILED' ||
            (t.status === 'WAITING' &&
              ['paused', 'interrupted', 'limit', 'rate_limit'].includes(t.waitReason ?? '')),
        )) {
          if (t.status === 'FAILED') {
            const agent = this.store.require<Agent>('agents', t.agentId);
            this.store.put('agents', { ...agent, sessionId: id() });
          }
          this.updateTask(t, 'READY', { waitReason: undefined });
        }
        this.updateRun(this.store.require('runs', runId), { status: 'READY', reason: undefined });
      }
      return this.store.require<Run>('runs', runId);
    });
  }
  inbox(runId: string, text: string) {
    return this.store.put('inbox', {
      id: id(),
      revision: 0,
      runId,
      text,
      status: 'PENDING',
      createdAt: now(),
    });
  }
  applyInbox(runId: string) {
    return this.store.tx(() => {
      let run = this.store.require<Run>('runs', runId);
      const incoming = this.store.all<any>('inbox', runId).filter((m) => m.status === 'PENDING');
      if (!incoming.length) return;
      // 收件箱只在工具配对闭合后应用。
      const tasks = this.store
        .all<Task>('tasks', runId)
        .filter((t) => !['DONE', 'CANCELLED'].includes(t.status));
      if (
        tasks.some((t) => {
          const history = this.history(t);
          const resolved = new Set(history.filter((m) => m.role === 'tool').map((m) => m.callId));
          return history.some((m) => m.calls?.some((c) => !resolved.has(c.id)));
        })
      )
        return;
      invariant(!['DONE', 'CANCELLED'].includes(run.status), 'INVALID_STATE', '运行已结束');
      for (const m of incoming) {
        for (const t of this.store
          .all<Task>('tasks', runId)
          .filter((t) => !['DONE', 'CANCELLED'].includes(t.status)))
          this.appendMessage(t, 'user', m.text);
        this.store.put('inbox', { ...m, status: 'APPLIED' });
      }
      const root = this.store.require<Task>('tasks', run.rootTaskId);
      if (run.authorized || run.plan) {
        for (const t of this.descendants(root).filter(
          (t) => t.id !== root.id && !['DONE', 'CANCELLED'].includes(t.status),
        ))
          this.updateTask(t, 'CANCELLED');
        for (const a of this.store
          .all<Attempt>('attempts', runId)
          .filter((a) => a.taskId !== root.id && ['ACTIVE', 'WAITING'].includes(a.status)))
          this.store.put('attempts', { ...a, status: 'CANCELLED', lease: null });
        run = this.updateRun(run, {
          contract: { ...run.contract, version: run.contract.version + 1 },
          authorized: false,
          acceptedPlanVersion: null,
        });
        this.updateTask(root, 'READY', {
          phase: 'planning',
          contractVersion: run.contract.version,
          waitReason: undefined,
          waitingFor: [],
        });
      } else if (root.status === 'WAITING' && ['user', 'plan'].includes(root.waitReason ?? ''))
        this.updateTask(root, 'READY', { waitReason: undefined });
      this.updateRun(this.store.require('runs', runId), { status: 'READY', reason: undefined });
    });
  }
  wakeChildren(runId: string) {
    this.store.tx(() => {
      for (const task of this.store
        .all<Task>('tasks', runId)
        .filter((t) => t.status === 'WAITING' && t.waitReason === 'children')) {
        const children = task.waitingFor.map((key) => this.store.require<Task>('tasks', key));
        if (children.every((c) => ['DONE', 'FAILED', 'CANCELLED'].includes(c.status))) {
          this.appendMessage(
            task,
            'user',
            '等待的子任务已结束：' +
              stable(children.map((c) => ({ id: c.id, status: c.status, result: c.result }))),
          );
          this.updateTask(task, 'READY', { waitingFor: [], waitReason: undefined });
        }
      }
    });
  }
  recover() {
    this.store.tx(() => {
      for (const r of this.store.all<RequestRecord>('requests').filter((r) => r.status === 'RESERVED'))
        this.settle(r.id, null, '服务中断，用量待核验');
      for (const op of this.store.all<any>('tool_operations').filter((o) => o.status === 'INTENT')) {
        this.store.put('tool_operations', { ...op, status: 'UNCERTAIN' });
        this.event(
          op.runId,
          'decision.required',
          { operationId: op.id, reason: '副作用结果待核验' },
          op.taskId,
        );
      }
      for (const task of this.store
        .all<Task>('tasks')
        .filter((t) => t.status === 'RUNNING' || t.status === 'VERIFYING')) {
        const pending = this.store
          .all<any>('tool_operations', task.runId)
          .some((o) => o.taskId === task.id && o.status === 'UNCERTAIN');
        this.wait(task, pending ? 'verification' : 'interrupted');
      }
      for (const a of this.store.all<Attempt>('attempts').filter((a) => a.status === 'ACTIVE'))
        this.store.put('attempts', { ...a, status: 'WAITING', lease: null });
      for (const run of this.store.all<Run>('runs').filter((r) => r.status === 'RUNNING'))
        this.updateRun(run, { status: 'WAITING', reason: 'interrupted' });
    });
  }
}
