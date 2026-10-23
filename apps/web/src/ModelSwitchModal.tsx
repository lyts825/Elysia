import { useId, useState } from 'react';
import type { Agent, Task } from '../../../packages/contracts/src/index';
import { Modal } from './Modal';
import { ModelPicker, defaultChoice, type ModelChoice, type SelectableProvider } from './ModelPicker';
import { modelTaskCanContinue } from './ModelSwitchGuards';
import './execution-config.css';
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
  const id = useId();
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
  const selectedProvider = providers.find((provider) => provider.id === choice.providerId);
  return (
    <Modal
      title="切换模型"
      subtitle={chat ? '当前会话' : '为此代理选择后续调用使用的模型。'}
      close={close}
      busy={busy}
      className="execution-config-modal"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) submit(choice, 'apply');
        }}
      >
        <div className="form-body">
          {!chat && (
            <section className="execution-config-section" aria-labelledby={id + '-task'}>
              <h3 id={id + '-task'}>当前任务</h3>
              <div
                className="execution-config-read execution-config-task"
                role="region"
                aria-label="当前任务完整名称"
                tabIndex={0}
              >
                {task.spec.title}
              </div>
            </section>
          )}
          <section className="execution-config-section" aria-labelledby={id + '-current'}>
            <h3 id={id + '-current'}>当前模型</h3>
            <div className="execution-config-read" role="region" aria-label="当前模型完整配置" tabIndex={0}>
              <dl className="execution-config-binding">
                <div>
                  <dt>连接</dt>
                  <dd>{binding.label}</dd>
                </div>
                <div>
                  <dt>型号</dt>
                  <dd>{binding.model}</dd>
                </div>
                <div>
                  <dt>推理强度</dt>
                  <dd>{binding.reasoningEffort || '默认'}</dd>
                </div>
              </dl>
            </div>
          </section>
          <section className="execution-config-section" aria-labelledby={id + '-next'}>
            <h3 id={id + '-next'}>选择模型</h3>
            <ModelPicker
              providers={providers}
              value={choice}
              change={setChoice}
              ready={setModelReady}
              disabled={busy || !!disabledReason}
              label={chat ? '会话模型连接' : '此代理的模型连接'}
            />
            {selectedProvider && (
              <div
                className="execution-config-read execution-config-selected"
                role="region"
                aria-label="待应用模型完整配置"
                tabIndex={0}
              >
                <dl className="execution-config-binding">
                  <div>
                    <dt>连接</dt>
                    <dd>{selectedProvider.label}</dd>
                  </div>
                  <div>
                    <dt>型号</dt>
                    <dd>{choice.model || '尚未选择'}</dd>
                  </div>
                  <div>
                    <dt>推理强度</dt>
                    <dd>{choice.reasoningEffort || '默认'}</dd>
                  </div>
                </dl>
              </div>
            )}
          </section>
          <p className="field-help">
            {chat ? '应用后用于当前会话的下一次回复。' : '应用后用于此代理的后续调用。'}
            {canResume ? (chat ? '“应用并继续”会立即继续回复。' : '“应用并继续”会立即继续任务。') : ''}
          </p>
          {disabledReason && (
            <div className="inline-warning" role="status">
              <div
                className="execution-config-read"
                role="region"
                aria-label="模型切换限制完整说明"
                tabIndex={0}
              >
                {disabledReason}
              </div>
            </div>
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
