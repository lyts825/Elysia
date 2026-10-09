import { useState } from 'react';
import type { Agent, Operation, RequestRecord, Run, Task } from '../../../packages/contracts/src/index';
import { Modal } from './Modal';
import { ModelPicker, defaultChoice, type ModelChoice, type SelectableProvider } from './ModelPicker';

type SwitchDetail = { run: Run; tasks: Task[]; requests: RequestRecord[]; operations: Operation[] };
export function modelTaskCanContinue(task: Task) {
  return (
    task.status === 'FAILED' ||
    (task.status === 'WAITING' &&
      ['paused', 'interrupted', 'limit', 'rate_limit', 'subscription_limit'].includes(task.waitReason || ''))
  );
}
export function modelSwitchReason(detail: SwitchDetail, archived: boolean, taskId: string) {
  if (detail.run.execution?.kind === 'docker-agent') return '终端配置在创建时冻结，调整 Agent 请新建任务。';
  const task = detail.tasks.find((item) => item.id === taskId);
  if (archived) return '请先恢复归档的会话或项目，再切换模型。';
  if (
    !task ||
    ['DONE', 'CANCELLED'].includes(detail.run.status) ||
    ['DONE', 'CANCELLED'].includes(task.status)
  )
    return '任务已结束，模型记录仅供查看。';
  if (
    task.status === 'VERIFYING' ||
    task.waitReason === 'verification' ||
    detail.requests.some((item) => item.taskId === taskId && item.status === 'UNKNOWN') ||
    detail.operations.some((item) => item.taskId === taskId && item.status === 'UNCERTAIN')
  )
    return '请先核验此代理的请求或操作，再切换模型。';
  if (
    !['WAITING', 'FAILED'].includes(task.status) ||
    detail.requests.some((item) => item.taskId === taskId && item.status === 'RESERVED') ||
    detail.operations.some((item) => item.taskId === taskId && item.status === 'INTENT')
  )
    return '此代理正在执行，请先暂停，再切换模型。';
  return '';
}

export function ModelSwitchModal({
  providers,
  agent,
  task,
  chat,
  busy,
  disabledReason,
  close,
  submit,
}: {
  providers: SelectableProvider[];
  agent: Agent;
  task: Task;
  chat: boolean;
  busy: boolean;
  disabledReason: string;
  close: () => void;
  submit: (choice: ModelChoice, switchMode: 'apply' | 'resume') => void;
}) {
  const binding = agent.providerBinding;
  const [choice, setChoice] = useState<ModelChoice>(() =>
    providers.some((item) => item.id === agent.providerId)
      ? { providerId: agent.providerId, model: binding.model, reasoningEffort: binding.reasoningEffort }
      : defaultChoice(providers),
  );
  const [modelReady, setModelReady] = useState(false);
  const changed =
    choice.providerId !== agent.providerId ||
    choice.model !== binding.model ||
    (choice.reasoningEffort ?? null) !== (binding.reasoningEffort ?? null);
  const canSubmit = !busy && !disabledReason && modelReady && changed;
  const canResume = modelTaskCanContinue(task);
  return (
    <Modal title="切换模型" subtitle={chat ? '当前会话' : task.spec.title} close={close} busy={busy}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) submit(choice, 'apply');
        }}
      >
        <div className="form-body">
          <p className="field-help">
            当前：{binding.label} · {binding.model}
            {binding.reasoningEffort ? ` · ${binding.reasoningEffort}` : ''}
          </p>
          <ModelPicker
            providers={providers}
            value={choice}
            change={setChoice}
            ready={setModelReady}
            disabled={busy || !!disabledReason}
            label={chat ? '会话模型连接' : '此代理的模型连接'}
          />
          <p className="field-help">
            旧消息保留，新模型会收到公开对话和任务信息。其他会话及代理继续使用各自的模型。
          </p>
          <p className="field-help">
            {chat ? '应用后等待下一条消息。' : '应用后保留当前等待。'}
            {canResume
              ? chat
                ? '选择“应用并继续”会调用新模型继续当前回复。'
                : '选择“应用并继续”会调用新模型继续此代理的任务。'
              : !chat && '当前计划、回答或子任务的等待条件仍需完成。'}
          </p>
          {disabledReason && (
            <p className="inline-warning" role="status">
              {disabledReason}
            </p>
          )}
          {!changed && !disabledReason && (
            <p className="field-help">选择不同的连接、型号或推理强度后应用。</p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          {canResume && (
            <button
              type="button"
              className="secondary"
              disabled={!canSubmit}
              onClick={() => submit(choice, 'resume')}
            >
              应用并继续
            </button>
          )}
          <button type="submit" className="primary" disabled={!canSubmit}>
            应用模型
          </button>
        </footer>
      </form>
    </Modal>
  );
}
