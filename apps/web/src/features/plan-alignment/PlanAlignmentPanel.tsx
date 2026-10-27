/**
 * 展示和处理计划对齐信息。
 * 把计划任务建议、父级配置和本次模型选择合成为确认分配，校验后提交；加载器与服务端负责模块身份和最终计划应用。
 * EN: Displays accepted plans and prepares plan-alignment choices. Combines proposed tasks, inherited settings, and current model choices into confirmed assignments for validated submission; the loader/server own module identity and final plan application.
 */
import { Icon } from '../../Icon';
import { ModelPicker } from '../../ModelPicker';
import {
  minimumContextWindowTokens,
  effectiveContextWindowTokens,
  type ContextPolicy,
  type TaskSpec,
} from '../../../../../packages/contracts/src/index';
import { ContextPolicyEditor, validContextPolicy } from '../../ContextPolicyEditor';
import { contextPolicyLabel } from '../../ContextWindow';
import { PLAN_ALIGNMENT_API_VERSION, type PlanAlignmentProps } from './types';
import { reviewModelConflict } from '../../../../../packages/contracts/src/review-policy';

/**
 * 宿主加载器用此身份与接口版本确认动态模块兼容性。
 * EN: Host loader checks this identity/interface version for compatibility.
 */
export const manifest = {
  id: 'plan-alignment',
  apiVersion: PLAN_ALIGNMENT_API_VERSION,
  version: '1',
  title: '计划对齐',
} as const;

/**
 * 只读展示已接受分工，或为待接受计划选择一级子代理模型和窗口。
 * 待定选择优先采用本次 assignments，其次采用计划建议；缺省窗口继承父级并受目标模型上限限制。
 * 接受前同时检查各选择就绪、上下文有效和执行/复核型号隔离，实际准入仍交由内核确认。
 * EN: Read accepted assignments or select first-level agent models/windows for a pending plan. Prefer current assignments over plan suggestions. Missing windows inherit parent within target-model cap. Acceptance requires ready selections, valid context, and executor/reviewer separation; kernel makes final admission.
 */
export function PlanAlignmentPanel({
  detail,
  providers,
  assignments,
  assignmentReady,
  proposedChoice,
  busy,
  archived,
  readOnlyReason,
  changeAssignment,
  readyAssignment,
  accept,
}: PlanAlignmentProps) {
  const { run } = detail;
  const plan = run.plan;
  /**
   * 聊天和无计划的运行不显示分工；仅待接受的计划允许确认。
   * EN: Chat/planless runs show no assignments; confirmation is for pending plans only.
   */
  if (!plan || run.kind === 'chat') return null;
  const ended = ['DONE', 'CANCELLED'].includes(run.status);
  const pending = run.reason === 'plan' && !ended && run.acceptedPlanVersion !== plan.version;
  const parent = detail.agents.find((agent) => agent.taskId === run.rootTaskId);
  /**
   * 优先取本次窗口对任务键的显式分配，未覆盖时沿用计划建议连接，保持编辑与提交使用相同选择。
   * EN: Prefers an explicit assignment for this task in the current window and otherwise uses the proposed connection so editing and submission share the same choice.
   */
  const pendingChoice = (task: TaskSpec) =>
    Object.hasOwn(assignments, task.key) ? assignments[task.key] : proposedChoice(task);
  /**
   * 本次窗口优先，其次计划建议；两者均未指定时继承父级与模型上限中的较小值。
   * EN: Prefer current window, then plan suggestion, otherwise inherit the smaller parent/model ceiling.
   */
  const pendingPolicy = (task: TaskSpec): ContextPolicy => {
    const choice = pendingChoice(task);
    if (choice.contextPolicy) return choice.contextPolicy;
    const provider = providers.find((item) => item.id === choice.providerId);
    const inherited = Math.min(
      parent ? effectiveContextWindowTokens(parent) : provider?.contextLimit || 4096,
      provider?.contextLimit || 4096,
    );
    return {
      mode: parent?.contextPolicy?.mode ?? 'managed',
      windowTokens: task.contextWindowTokens ?? inherited,
    };
  };
  const invalidContext = plan.tasks.some((task) => {
    const choice = pendingChoice(task);
    const provider = providers.find((item) => item.id === choice.providerId);
    return !validContextPolicy(
      pendingPolicy(task),
      provider ? minimumContextWindowTokens(provider) : 4096,
      provider?.contextLimit || 4096,
    );
  });
  const reviewConflict =
    pending && run.contract.allowSameModelReview !== true
      ? reviewModelConflict([
          ...detail.tasks
            .filter((task) => task.status !== 'CANCELLED')
            .map((task) => ({
              ...task.spec,
              model:
                detail.agents.find((agent) => agent.id === task.agentId)?.providerBinding.model ??
                task.spec.model ??
                '',
            })),
          ...plan.tasks.map((task) => {
            const choice = pendingChoice(task);
            return {
              ...task,
              model:
                choice.model ?? providers.find((provider) => provider.id === choice.providerId)?.model ?? '',
            };
          }),
        ])
      : null;
  return (
    <div className="plan-card" data-module={manifest.id}>
      <div className="plan-card-head">
        <div>
          <span className="eyebrow">
            计划 V{plan.version} · 约定 V{plan.contractVersion}
          </span>
          <h3>计划与目标对齐</h3>
        </div>
        <span className="plan-count">{plan.tasks.length} 个子任务</span>
      </div>
      <p>{plan.summary}</p>
      <p className="field-help">
        审计模型：{run.contract.allowSameModelReview ? '用户已确认允许与执行模型相同' : '必须与执行模型不同'}
        。
      </p>
      {reviewConflict && (
        <p className="field-error" role="alert">
          {reviewConflict}
        </p>
      )}
      <details className="plan-contract">
        <summary>查看目标、交付物与验收要求</summary>
        <p className="plan-objective">{run.contract.objective}</p>
        <div className="plan-contract-grid">
          {[
            ['范围', run.contract.scope],
            ['交付物', run.contract.deliverables],
            ['验收要求', run.contract.acceptanceCriteria],
            ['约束', run.contract.constraints],
            ['不包含', run.contract.nonGoals],
            ['假设', run.contract.assumptions],
          ].map(([label, values]) => {
            const rows = values as string[];
            return rows.length ? (
              <div key={label as string}>
                <strong>{label as string}</strong>
                <ul>
                  {rows.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              </div>
            ) : null;
          })}
        </div>
      </details>
      {plan.tasks.map((task, index) => {
        const currentTask =
          run.acceptedPlanVersion === plan.version
            ? detail.tasks.find(
                (item) =>
                  item.parentTaskId === run.rootTaskId &&
                  item.contractVersion === plan.contractVersion &&
                  item.spec.key === task.key &&
                  item.status !== 'CANCELLED',
              )
            : undefined;
        const agent = detail.agents.find((item) => item.id === currentTask?.agentId);
        const binding = agent?.providerBinding;
        const routing = Object.hasOwn(run.planRouting ?? {}, task.key)
          ? run.planRouting![task.key]
          : undefined;
        const choice = pending
          ? pendingChoice(task)
          : binding
            ? { providerId: binding.id, model: binding.model, reasoningEffort: binding.reasoningEffort }
            : task;
        const provider = providers.find((item) => item.id === choice.providerId);
        const policy = pending
          ? pendingPolicy(task)
          : agent?.contextPolicy || { mode: 'managed' as const, windowTokens: task.contextWindowTokens };
        return (
          <div className="plan-row" key={task.key}>
            <span className="step-number">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <strong>{task.title}</strong>
              <p>{task.objective}</p>
              <small>
                {binding ? '当前模型：' + binding.label : provider?.label || choice.providerId}
                {choice.model ? ' · ' + choice.model : ''}
                {choice.reasoningEffort ? ' · ' + choice.reasoningEffort : ''}
                {' · 窗口 ' + contextPolicyLabel(policy, true)}
                {task.dependsOn.length
                  ? ' · 依赖 ' +
                    task.dependsOn
                      .map((key) => plan.tasks.find((item) => item.key === key)?.title || key)
                      .join('、')
                  : ''}
              </small>
              {routing && (
                <p className="field-help">
                  创建时项目角色模型 · 策略版本 {routing.policyRevision}
                  {pending && Object.hasOwn(assignments, task.key) ? ' · 已手动调整' : ''}
                </p>
              )}
              <details className="plan-task-evidence">
                <summary>交付与验收</summary>
                <p>交付：{task.deliverables.join('；')}</p>
                <p>验收：{task.acceptanceCriteria.join('；')}</p>
              </details>
              {pending && (
                <>
                  <ModelPicker
                    providers={providers}
                    label={`一级子代理 ${index + 1} · ${task.title}`}
                    value={pendingChoice(task)}
                    disabled={busy || archived}
                    change={(choice) =>
                      changeAssignment(task.key, {
                        ...proposedChoice(task),
                        ...pendingChoice(task),
                        ...choice,
                      })
                    }
                    ready={(valid) => readyAssignment(task.key, valid)}
                  />
                  <details className="context-compact-setup">
                    <summary>上下文窗口 · {policy.mode === 'manual' ? '手动分配' : '上级托管'}</summary>
                    <ContextPolicyEditor
                      value={policy}
                      change={(contextPolicy) =>
                        changeAssignment(task.key, {
                          ...proposedChoice(task),
                          ...pendingChoice(task),
                          contextPolicy,
                        })
                      }
                      minimumWindowTokens={provider ? minimumContextWindowTokens(provider) : 4096}
                      providerLimit={provider?.contextLimit || 4096}
                      disabled={busy || archived}
                      child
                    />
                  </details>
                </>
              )}
            </div>
          </div>
        );
      })}
      <div className="plan-footer">
        <span>
          <Icon name="lock" size={13} />
          {readOnlyReason
            ? '执行记录不完整，计划仅供查看'
            : archived
              ? '已归档，计划仅供查看'
              : ended
                ? '任务已结束，计划仅供查看'
                : run.authorized
                  ? '执行范围已接受'
                  : '接受这个版本后执行'}
        </span>
        {pending && (
          <button
            className="primary"
            disabled={
              busy ||
              archived ||
              invalidContext ||
              !!reviewConflict ||
              plan.tasks.some(
                (task) => !Object.hasOwn(assignmentReady, task.key) || !assignmentReady[task.key],
              )
            }
            onClick={accept}
          >
            接受并开始 <Icon name="play" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
