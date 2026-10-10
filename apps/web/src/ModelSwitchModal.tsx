import { useState } from 'react';
import type { Agent, Task } from '../../../packages/contracts/src/index';
import { Modal } from './Modal';
import { ModelPicker, defaultChoice, type ModelChoice, type SelectableProvider } from './ModelPicker';
import { modelTaskCanContinue } from './ModelSwitchGuards';
export { modelTaskCanContinue, modelSwitchReason } from './ModelSwitchGuards';

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
            {chat ? '应用后用于当前会话的下一次回复。' : '应用后用于此代理的后续调用。'}
            {canResume ? (chat ? '“应用并继续”会立即继续回复。' : '“应用并继续”会立即继续任务。') : ''}
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
