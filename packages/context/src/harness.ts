import type { Run, Task } from '../../contracts/src/index.js';

export const HARNESS_POLICY_VERSION = 'autonomous-within-scope-v1';

/** Shared execution guidance; authorization is still enforced by the host, never by this text. */
export const AUTONOMOUS_EXECUTION_GUIDANCE =
  '对于项目执行任务，在已经授权的范围内持续推进到交付，自行选择实现方法、调查顺序、必要验证和可逆的修复；不为这些常规步骤重复征求同意。' +
  '信息不足时先检查已有资料；不影响目标、授权或验收的细节采用合理假设并记录。只有缺少会改变目标、范围、授权或验收的关键输入时才集中提问，提问前先完成不依赖回答的准备。' +
  '根据当前有效工具决定能做什么，不把未开放的工具当作可申请的隐藏能力。一次工具失败只说明该次操作的问题：能修正参数、读取最新状态或改用已开放工具时自行修复；权限确实不足时说明具体缺口和最小后续操作，同时完成其余可做工作。' +
  '不要用空泛的安全提醒、重复确认或只列计划代替执行；只有实际影响当前任务的限制才需要说明。不通过反复重试绕过拒绝，不重放结果未知的副作用。' +
  '最终按任务类型回复：执行任务说明实际产物、验证和未完成项，独立聊天直接回答；不把推测写成已经完成。';

export function nativeHarnessPolicy(run: Run, task: Task, toolNames: string[]) {
  const availableTools = [...new Set(toolNames)].sort();
  const accepted =
    run.authorized && (run.planMode === false || run.acceptedPlanVersion === run.plan?.version);
  const mode =
    run.kind === 'chat'
      ? 'chat'
      : task.phase === 'planning'
        ? 'planning'
        : task.spec.role === 'reviewer'
          ? 'review'
          : accepted
            ? 'execute'
            : 'awaiting_authorization';
  const authorization =
    mode === 'chat'
      ? '独立聊天：直接回答，不使用项目计划或交付工具。'
      : mode === 'planning'
        ? '当前仍在规划阶段：可用已开放工具调查；只有关键缺口才用 clarify，否则 propose_plan。用户接受具体版本后才能执行该计划。'
        : mode === 'review'
          ? '当前为只读复核：直接检查已有证据并提交复核结果；不修改产物或执行命令。'
          : mode === 'execute'
            ? run.planMode === false
              ? '用户在创建任务时已授权当前合同。直接执行，无需再提出计划或重复确认已授权步骤。'
              : `用户已接受计划版本 ${run.acceptedPlanVersion}，当前授权有效。继续执行已分配任务，无需重新提出或接受同一计划。`
            : '当前尚无有效执行授权；使用实际开放工具，不以补充消息或提示词替代计划接受。';
  return {
    version: HARNESS_POLICY_VERSION,
    mode,
    authorization,
    availableTools,
    clarification:
      mode === 'chat'
        ? '直接回答；确有影响回答的关键缺口时集中提问，不使用项目 clarify 工具。'
        : 'clarify 会暂停任务等待用户，仅用于无法从现有资料解决且影响目标、授权或验收的关键缺口；实施选择、可逆修复、必要验证及已授权动作由你自行决定。',
    continuation:
      mode === 'chat'
        ? '依据最新用户消息继续聊天，不使用项目重新规划流程。'
        : '普通补充消息在当前合同内提供信息，不撤销已接受计划，不增加权限或预算。只有用户明确选择重新规划或修改计划约定，才使旧计划失效。',
    scope:
      '合同 permissionProfile 是范围上限，当前角色、阶段和 availableTools 决定本步能力；工具未列出不代表整个任务都无法推进。',
    reviewModels:
      run.contract.allowSameModelReview === true
        ? '用户已确认允许审计与执行使用相同模型；审计仍须独立核对证据。保持合同 allowSameModelReview，不得自行修改。'
        : '审计（reviewer）必须使用不同于总代理及执行任务的模型，包括历史请求使用过的型号。更换连接、账号或思考强度不算更换模型。合同 allowSameModelReview 默认为 false，只有用户在界面确认后才能开启；没有可用的不同模型时说明缺口，不绕过校验。',
  };
}
