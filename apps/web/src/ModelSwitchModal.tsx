/* 提供任务模型切换的弹窗。 */
import { useId, useState } from 'react';
import type { Agent, Task } from '../../../packages/contracts/src/index';
import { Modal } from './Modal';
import { ModelPicker, defaultChoice, type ModelChoice, type SelectableProvider } from './ModelPicker';
import { modelTaskCanContinue } from './ModelSwitchGuards';
import './execution-config.css';
import './model-switch.css';
export { modelTaskCanContinue, modelSwitchReason } from './ModelSwitchGuards';

/**
 * 对比代理冻结绑定与本次选择，只有连接/型号/强度确实变化且通过 ModelPicker 校验才提交。
 * disabledReason 由当前运行边界计算；“仅应用”和“应用并继续”分别回传，恢复资格不能
 * 仅依据是否换了模型推断，最终版本与执行状态仍由父级动作及服务端检查。
 */
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
  // 连接、模型或推理强度确实变化且模型校验通过后，才允许提交切换。
  const changed =
    choice.providerId !== agent.providerId ||
    choice.model !== binding.model ||
    (choice.reasoningEffort ?? null) !== (binding.reasoningEffort ?? null);
  const canSubmit = !busy && !disabledReason && modelReady && changed;
  const canResume = modelTaskCanContinue(task);
  const selectedProvider = providers.find((provider) => provider.id === choice.providerId);
  const selectionState = busy
    ? 'busy'
    : disabledReason
      ? 'blocked'
      : !changed
        ? 'unchanged'
        : !modelReady
          ? 'unready'
          : 'ready';
  return (
    <Modal
      title="切换模型"
      subtitle={chat ? '当前会话' : '为此代理选择后续调用使用的模型。'}
      close={close}
      busy={busy}
      className="execution-config-modal model-switch-modal"
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
            <p
              className="model-switch-state"
              data-state={selectionState}
              id={id + '-selection-state'}
              role="status"
            >
              {selectionState === 'busy'
                ? '当前操作进行中，暂不能应用。'
                : selectionState === 'blocked'
                  ? '当前状态暂不允许切换，详见下方说明。'
                  : selectionState === 'unchanged'
                    ? '当前选择与已绑定模型一致。'
                    : selectionState === 'unready'
                      ? '所选型号尚未就绪，请检查连接与模型。'
                      : '新选择已就绪，尚未应用。'}
            </p>
            {changed && selectedProvider && (
              <div className="model-switch-changes" aria-label="本次选择的变化">
                <h4>已改动的选择</h4>
                <ul>
                  {choice.providerId !== agent.providerId && <li>模型连接</li>}
                  {choice.model !== binding.model && <li>型号</li>}
                  {(choice.reasoningEffort ?? null) !== (binding.reasoningEffort ?? null) && (
                    <li>推理强度</li>
                  )}
                </ul>
              </div>
            )}
            <details className="model-switch-identity">
              <summary>核对连接标识与版本</summary>
              <dl
                className="execution-config-read model-switch-identity-reading"
                role="region"
                aria-label="模型切换完整连接标识与版本"
                tabIndex={0}
              >
                <div>
                  <dt>当前绑定连接</dt>
                  <dd>{agent.providerId}</dd>
                </div>
                <div>
                  <dt>绑定版本</dt>
                  <dd>{binding.revision ?? '未提供'}</dd>
                </div>
                <div>
                  <dt>待应用连接</dt>
                  <dd>{choice.providerId || '未选择'}</dd>
                </div>
                <div>
                  <dt>当前连接版本</dt>
                  <dd>{selectedProvider?.revision ?? '未提供'}</dd>
                </div>
              </dl>
            </details>
          </section>
          <div className="model-switch-action-help">
            <p id={id + '-apply-help'}>
              <strong>应用模型</strong>
              <span>
                {chat ? '应用后用于当前会话的下一次回复。' : '应用后用于此代理的后续调用。'}本次不立即继续。
              </span>
            </p>
            {canResume && (
              <p id={id + '-resume-help'}>
                <strong>应用并继续</strong>
                <span>{chat ? '更新模型并立即继续回复。' : '更新模型并立即继续任务。'}</span>
              </p>
            )}
          </div>
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
              aria-describedby={`${id}-selection-state ${id}-resume-help`}
              onClick={() => submit(choice, 'resume')}
            >
              应用并继续
            </button>
          )}
          <button
            type="submit"
            className="primary"
            disabled={!canSubmit}
            aria-describedby={`${id}-selection-state ${id}-apply-help`}
          >
            应用模型
          </button>
        </footer>
      </form>
    </Modal>
  );
}
