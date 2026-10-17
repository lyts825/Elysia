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

export const manifest = {
  id: 'plan-alignment',
  apiVersion: PLAN_ALIGNMENT_API_VERSION,
  version: '1',
  title: '计划对齐',
} as const;

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
  if (!plan || run.kind === 'chat') return null;
  const ended = ['DONE', 'CANCELLED'].includes(run.status);
  const pending = run.reason === 'plan' && !ended && run.acceptedPlanVersion !== plan.version;
  const parent = detail.agents.find((agent) => agent.taskId === run.rootTaskId);
  const pendingChoice = (task: TaskSpec) =>
    Object.hasOwn(assignments, task.key) ? assignments[task.key] : proposedChoice(task);
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
