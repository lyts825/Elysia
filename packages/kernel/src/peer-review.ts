// 协调同行评审轮次、提交和状态转换。
import {
  PeerReviewPolicy,
  PeerReviewSubmission,
  TaskSpec,
  invariant,
  type Agent,
  type Artifact,
  type Attempt,
  type Contract,
  type Evidence,
  type Operation,
  type PeerReviewRound,
  type PeerReviewState,
  type ProviderConfig,
  type Run,
  type Task,
} from '../../contracts/src/index.js';
import { hash, id, now, stable } from '../../contracts/src/identity.js';
import type { KernelStore as Store } from './ports.js';
import type { Kernel } from './index.js';

const modelIdentity = (model: string) => model.trim().toLowerCase();

// 创建时核验权限、代理容量和模型独立性，保存评审连接供后续轮次使用。
export function freezePeerReview(
  store: Store,
  contract: Contract,
  author: ProviderConfig,
  limits: Run['limits'],
  kind: Run['kind'],
  execution: NonNullable<Run['execution']>,
): PeerReviewState | undefined {
  const policy = contract.peerReview;
  if (!policy) return undefined;
  PeerReviewPolicy.parse(policy);
  invariant(
    kind === 'task' && execution.kind === 'native',
    'PEER_REVIEW_SCOPE',
    '评审模式只支持原生项目任务',
  );
  invariant(contract.permissionProfile.read, 'PEER_REVIEW_READ', '评审模式需要工作区读取权限');
  invariant(
    limits.maxDepth >= 1 && limits.maxAgents >= policy.reviewerProviderIds.length + 1,
    'PEER_REVIEW_CAPACITY',
    '代理数量及委派深度不足以容纳执行模型和全部评审模型',
  );
  const bindings = policy.reviewerProviderIds.map((providerId) => {
    const binding = store.require<ProviderConfig>('providers', providerId);
    invariant(
      !binding.archived && binding.checkedRevision === binding.revision,
      'PEER_REVIEW_UNCHECKED',
      `评审模型 ${binding.label} 尚未验证或已归档`,
    );
    return binding;
  });
  invariant(
    new Set([author, ...bindings].map((binding) => modelIdentity(binding.model))).size ===
      bindings.length + 1,
    'PEER_REVIEW_MODEL_CONFLICT',
    '评审模型必须与执行模型及其他评审模型使用不同型号',
  );
  return { bindings, reviewerTaskIds: [], rounds: [] };
}

/** Reserved review slots cannot be consumed by ordinary plan or delegated tasks. */
// 尚未创建的评审任务保留代理名额，普通委派不能占用。
export function peerReviewReservedSlots(run: Run) {
  return Math.max(0, (run.peerReview?.bindings.length ?? 0) - (run.peerReview?.reviewerTaskIds.length ?? 0));
}

// 要求变化时使现有轮次失效；评审正在运行时先等待安全检查点。
export function invalidatePeerReview(kernel: Kernel, run: Run, reason: string) {
  if (!run.peerReview?.rounds.length) return run;
  const latest = run.peerReview.rounds.at(-1)!;
  if (latest.status === 'stale') return run;
  if (latest.status === 'reviewing') {
    invariant(
      run.peerReview.reviewerTaskIds.every(
        (taskId) => !['RUNNING', 'VERIFYING'].includes(kernel.store.require<Task>('tasks', taskId).status),
      ),
      'PEER_REVIEW_BUSY',
      '请等待评审请求到达安全检查点后再更新要求',
    );
    for (const taskId of run.peerReview.reviewerTaskIds) {
      const task = kernel.store.require<Task>('tasks', taskId);
      if (!['DONE', 'CANCELLED'].includes(task.status))
        kernel.updateTask(task, 'CANCELLED', { waitReason: undefined });
      for (const attempt of kernel.store
        .all<Attempt>('attempts', run.id)
        .filter((entry) => entry.taskId === taskId && ['ACTIVE', 'WAITING'].includes(entry.status)))
        kernel.store.put('attempts', { ...attempt, status: 'CANCELLED', lease: null });
    }
    const root = kernel.store.require<Task>('tasks', run.rootTaskId);
    if (root.status === 'WAITING' && root.waitReason === 'children')
      kernel.updateTask(root, 'READY', { waitReason: undefined, waitingFor: [] });
  }
  return kernel.updateRun(run, {
    peerReview: {
      ...run.peerReview,
      rounds: run.peerReview.rounds.map((round, index) =>
        index === run.peerReview!.rounds.length - 1 ? { ...round, status: 'stale', reason } : round,
      ),
    },
  });
}

function candidateFingerprint(
  store: Store,
  run: Run,
  task: Task,
  args: { summary: string; evidence: Evidence[] },
) {
  const agent = store.require<Agent>('agents', task.agentId);
  const references = args.evidence.map((evidence) => {
    if (evidence.type === 'artifact') {
      const artifact = store.require<Artifact>('artifacts', evidence.ref);
      return {
        ref: evidence.ref,
        hash: artifact.hash,
        objectRef: artifact.objectRef,
        version: artifact.version,
      };
    }
    if (evidence.type === 'command') {
      const operation = store.require<Operation>('tool_operations', evidence.ref);
      return {
        ref: evidence.ref,
        revision: operation.revision,
        status: operation.status,
        result: operation.result,
      };
    }
    return evidence;
  });
  return hash(
    stable({
      contract: run.contract,
      task: task.spec,
      author: agent.providerBinding,
      sessionId: agent.sessionId,
      summary: args.summary,
      evidence: args.evidence,
      references,
      inbox: store.all<{ id: string; revision: number; status: string }>('inbox', run.id).map((message) => ({
        id: message.id,
        revision: message.revision,
        status: message.status,
      })),
    }),
  );
}

/** Called only after the gateway has verified every candidate evidence reference. */
// 仅根任务需要进入评审；复用已通过的相同候选，评审中等待，超过轮次则停止推进。
export function gatePeerReview(
  kernel: Kernel,
  original: Task,
  args: { summary: string; evidence: Evidence[]; incomplete?: string[] },
): null | { waiting: true; reason: string; candidateId?: string; round?: number } {
  return kernel.store.tx(() => {
    const store = kernel.store;
    let run = store.require<Run>('runs', original.runId);
    const task = store.require<Task>('tasks', original.id);
    invariant(!task.peerReview, 'PEER_REVIEW_SUBMIT', '评审代理必须使用 submit_peer_review 提交逐项评分');
    if (!run.contract.peerReview || task.id !== run.rootTaskId) return null;
    invariant(run.peerReview, 'PEER_REVIEW_MISSING', '冻结的评审模型配置缺失，不能确认目标');
    invariant(task.status === 'RUNNING', 'STOPPED', '任务已停止');
    invariant(
      !store.stateCandidates<any>('inbox', ['PENDING'], { runId: run.id }).length,
      'PEER_REVIEW_INBOX_PENDING',
      '尚有未应用的用户要求，请先处理新要求再提交候选结果',
    );
    const requirements = store
      .all<{ id: string; revision: number; status: string; text: string }>('inbox', run.id)
      .filter((message) => message.status === 'APPLIED')
      .map(({ id, text }) => ({ id, text }));
    invariant(
      Buffer.byteLength(
        stable({
          summary: args.summary,
          evidence: args.evidence,
          criteria: run.contract.acceptanceCriteria,
          requirements,
        }),
        'utf8',
      ) <=
        64 * 1024,
      'PEER_REVIEW_TOO_LARGE',
      '候选摘要、证据、验收标准和补充要求合计不能超过 64 KiB',
    );
    invariant(
      args.evidence.length <= 200 && run.contract.acceptanceCriteria.length <= 200,
      'PEER_REVIEW_TOO_LARGE',
      '评审模式最多支持 200 条证据和 200 项验收标准',
    );
    invariant(
      store
        .all<Task>('tasks', run.id)
        .every(
          (child) =>
            child.id === task.id ||
            child.peerReview ||
            ['DONE', 'FAILED', 'CANCELLED'].includes(child.status),
        ),
      'PEER_REVIEW_EXECUTION_PENDING',
      '请等待其余执行代理停止后再提交评审候选',
    );
    const fingerprint = candidateFingerprint(store, run, task, args);
    const previous = run.peerReview.rounds.at(-1);
    if (previous?.candidate.fingerprint === fingerprint && previous.status === 'passed') return null;
    if (previous?.candidate.fingerprint === fingerprint && previous.status === 'reviewing') {
      kernel.wait(task, 'children', run.peerReview.reviewerTaskIds);
      return {
        waiting: true,
        reason: 'peer_review',
        candidateId: previous.candidate.id,
        round: previous.candidate.round,
      };
    }
    if (previous?.status === 'reviewing')
      invariant(false, 'PEER_REVIEW_PENDING', '请等待当前独立评审全部结束后再修订候选');
    if (run.peerReview.rounds.length >= run.contract.peerReview.maxRounds) {
      kernel.wait(task, 'peer_review_limit');
      return { waiting: true, reason: 'peer_review_limit' };
    }
    invariant(
      previous?.candidate.fingerprint !== fingerprint || previous.status !== 'changes_requested',
      'PEER_REVIEW_UNCHANGED',
      '候选尚未修订，请先根据评审意见处理问题再提交',
    );
    const author = store.require<Agent>('agents', task.agentId);
    const round: PeerReviewRound = {
      status: 'reviewing',
      scores: [],
      candidate: {
        id: id(),
        round: run.peerReview.rounds.length + 1,
        fingerprint,
        summary: args.summary,
        evidence: args.evidence,
        acceptanceCriteria: run.contract.acceptanceCriteria,
        requirements,
        contractVersion: run.contract.version,
        authorAgentId: author.id,
        authorModel: author.providerBinding.model,
        createdAt: now(),
      },
    };
    const reviewerTaskIds = [...run.peerReview.reviewerTaskIds];
    for (const [index, binding] of run.peerReview.bindings.entries()) {
      const existing = reviewerTaskIds[index]
        ? store.require<Task>('tasks', reviewerTaskIds[index])
        : undefined;
      const agentId = existing?.agentId ?? id();
      const taskId = existing?.id ?? id();
      const spec = TaskSpec.parse({
        key: `peer-review-${index + 1}`,
        title: `独立评审 ${binding.label}`,
        objective: '独立核对当前候选结果的每项验收标准，依据真实证据评分并提交 submit_peer_review。',
        role: 'reviewer',
        providerId: binding.id,
        model: binding.model,
        reasoningEffort: binding.reasoningEffort,
        dependsOn: [],
        required: false,
        deliverables: ['逐项评审评分与证据说明'],
        acceptanceCriteria: run.contract.acceptanceCriteria,
      });
      const contextPolicy = kernel.childContextPolicy(task, binding);
      if (!existing) {
        invariant(
          store.all<Agent>('agents', run.id).length < run.limits.maxAgents,
          'AGENT_LIMIT',
          '评审代理数量达到上限',
        );
        store.put<Agent>('agents', {
          id: agentId,
          revision: 0,
          runId: run.id,
          parentAgentId: task.agentId,
          taskId,
          providerId: binding.id,
          providerBinding: binding,
          sessionId: id(),
          status: 'READY',
          profileVersion: '1',
          contextPolicy,
          contextPolicyRevision: 1,
        });
        store.put<Task>('tasks', {
          id: taskId,
          revision: 0,
          runId: run.id,
          parentTaskId: task.id,
          contractVersion: run.contract.version,
          agentId,
          spec,
          depth: 1,
          status: 'READY',
          phase: 'executing',
          workspace: task.workspace,
          workspaceOwnerTaskId: task.id,
          baseline: task.baseline,
          waitingFor: [],
          peerReview: { candidateId: round.candidate.id, reviewerProviderId: binding.id },
        });
        reviewerTaskIds.push(taskId);
      } else {
        invariant(
          !['RUNNING', 'VERIFYING'].includes(existing.status),
          'PEER_REVIEW_BUSY',
          '评审代理尚未停止',
        );
        const agent = store.require<Agent>('agents', agentId);
        store.put('agents', { ...agent, sessionId: id(), contextPolicy });
        kernel.updateTask(existing, 'READY', {
          spec,
          contractVersion: run.contract.version,
          workspace: task.workspace,
          workspaceOwnerTaskId: task.id,
          baseline: task.baseline,
          result: undefined,
          waitingFor: [],
          waitReason: undefined,
          rateLimit: undefined,
          noProgress: undefined,
          peerReview: { candidateId: round.candidate.id, reviewerProviderId: binding.id },
        });
        // Keep the existing step counter across rounds, just as the request ledger keeps its cumulative budget.
        const attempts = store
          .all<Attempt>('attempts', run.id)
          .filter((attempt) => attempt.taskId === taskId);
        const latest = attempts.sort((a, b) => b.sequence - a.sequence)[0];
        if (latest) store.put('attempts', { ...latest, status: 'WAITING', lease: null });
      }
      kernel.event(run.id, 'task.updated', store.require<Task>('tasks', taskId), taskId);
    }
    run = kernel.updateRun(run, {
      peerReview: { ...run.peerReview, reviewerTaskIds, rounds: [...run.peerReview.rounds, round] },
    });
    kernel.wait(task, 'children', reviewerTaskIds);
    kernel.event(
      run.id,
      'peer_review.started',
      { candidateId: round.candidate.id, round: round.candidate.round },
      task.id,
    );
    return {
      waiting: true,
      reason: 'peer_review',
      candidateId: round.candidate.id,
      round: round.candidate.round,
    };
  });
}

// 校验评分提交并关联当前候选轮次，领域层负责记录与状态推进。
export function submitPeerReview(kernel: Kernel, original: Task, raw: unknown) {
  const submission = PeerReviewSubmission.parse(raw);
  invariant(
    Buffer.byteLength(stable(submission), 'utf8') <= 64 * 1024,
    'PEER_REVIEW_TOO_LARGE',
    '单份评审评分和理由合计不能超过 64 KiB',
  );
  return kernel.store.tx(() => {
    const store = kernel.store;
    const task = store.require<Task>('tasks', original.id);
    let run = store.require<Run>('runs', task.runId);
    const state = run.peerReview,
      policy = run.contract.peerReview;
    const round = state?.rounds.at(-1);
    invariant(
      ['READY', 'RUNNING'].includes(run.status) &&
        !run.archived &&
        task.status === 'RUNNING' &&
        task.peerReview &&
        state &&
        policy &&
        round &&
        round.status === 'reviewing' &&
        task.peerReview.candidateId === submission.candidateId &&
        round.candidate.id === submission.candidateId &&
        state.reviewerTaskIds.includes(task.id),
      'PEER_REVIEW_STALE',
      '评分任务或候选结果已经变化',
    );
    const agent = store.require<Agent>('agents', task.agentId);
    const frozen = state.bindings.find((binding) => binding.id === task.peerReview!.reviewerProviderId);
    invariant(
      frozen && stable(frozen) === stable(agent.providerBinding),
      'PEER_REVIEW_MODEL_CHANGED',
      '评审模型与冻结配置不匹配',
    );
    invariant(
      !round.scores.some((score) => score.reviewerTaskId === task.id),
      'PEER_REVIEW_DUPLICATE',
      '同一模型不能重复评分',
    );
    invariant(
      submission.items.length === round.candidate.acceptanceCriteria.length &&
        new Set(submission.items.map((item) => item.criterion)).size === submission.items.length,
      'PEER_REVIEW_CRITERIA',
      '评分必须完整覆盖每个验收项，且不能重复',
    );
    for (const item of submission.items) {
      invariant(
        item.criterion < round.candidate.acceptanceCriteria.length,
        'PEER_REVIEW_CRITERIA',
        '评分验收项下标无效',
      );
      invariant(
        new Set(item.evidenceRefs).size === item.evidenceRefs.length &&
          item.evidenceRefs.every((ref) =>
            round.candidate.evidence.some(
              (evidence) => evidence.criterion === item.criterion && evidence.ref === ref,
            ),
          ),
        'PEER_REVIEW_EVIDENCE',
        '评分只能引用本验收项的候选证据',
      );
      invariant(
        item.verdict !== 'pass' || item.evidenceRefs.length > 0,
        'PEER_REVIEW_EVIDENCE',
        '通过的验收项必须引用候选证据',
      );
    }
    const score = {
      ...submission,
      reviewerTaskId: task.id,
      reviewerProviderId: frozen.id,
      reviewerModel: frozen.model,
      score:
        Math.round(
          (submission.items.reduce((total, item) => total + item.score, 0) / submission.items.length) * 100,
        ) / 100,
      passed: submission.items.every((item) => item.verdict === 'pass' && item.score >= policy.minScore),
      submittedAt: now(),
    };
    const scores = [...round.scores, score];
    const complete = scores.length === state.bindings.length;
    const status = !complete
      ? 'reviewing'
      : scores.every((entry) => entry.passed)
        ? 'passed'
        : state.rounds.length >= policy.maxRounds
          ? 'limit_reached'
          : 'changes_requested';
    const nextRound: PeerReviewRound = { ...round, scores, status };
    run = kernel.updateRun(run, {
      peerReview: { ...state, rounds: [...state.rounds.slice(0, -1), nextRound] },
    });
    kernel.updateTask(task, 'DONE', { result: score, waitReason: undefined, waitingFor: [] });
    const attempt = store
      .all<Attempt>('attempts', run.id)
      .find((entry) => entry.taskId === task.id && entry.status === 'ACTIVE');
    if (attempt) store.put('attempts', { ...attempt, status: 'DONE', lease: null });
    if (complete) {
      const root = store.require<Task>('tasks', run.rootTaskId);
      kernel.appendMessage(
        root,
        'user',
        '独立评审已汇总。逐项处理未通过或证据不足的意见；全部达标后，重新提交完全相同的候选摘要和证据，以复验文件及引用后确认目标。' +
          stable(nextRound),
        { purpose: 'runtime_notice' },
      );
      if (status === 'limit_reached') kernel.wait(root, 'peer_review_limit');
    }
    kernel.event(run.id, 'peer_review.scored', { candidateId: round.candidate.id, score, status }, task.id);
    return score;
  });
}
