/* 展示评审模型选择及约束。 */
import { useId, useState } from 'react';
import { Modal } from './Modal';
import './workflow-policy-confirmation.css';

/**
 * 管理当前表单的同型号复核例外：开启先进入本地确认态，确认后才调用 change(true)。
 * pendingChanged 让外层阻止在未处理确认时提交；关闭确认不代表持久保存合同。
 */
export function ReviewModelPolicy({
  allowed,
  disabled = false,
  change,
  pendingChanged,
}: {
  allowed: boolean;
  disabled?: boolean;
  change: (allowed: boolean) => void;
  pendingChanged: (pending: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // 启用同模型例外需要单独确认；关闭选项可直接应用。
  const helpId = useId();
  const close = () => {
    setConfirming(false);
    pendingChanged(false);
  };
  return (
    <section className="review-model-policy review-policy-editor" aria-label="审计模型要求">
      <label className="check-label">
        <input
          type="checkbox"
          role="switch"
          checked={allowed}
          disabled={disabled}
          aria-describedby={`${helpId} ${helpId}-state`}
          onChange={(event) => {
            if (!event.target.checked) change(false);
            else {
              setConfirming(true);
              pendingChanged(true);
            }
          }}
        />
        允许同模型审计
      </label>
      <p className="review-policy-current" id={`${helpId}-state`} role="status">
        {confirming
          ? '等待二次确认，尚未提交本次开启选择。'
          : allowed
            ? '本任务已确认允许同模型审计。'
            : '本任务要求审计与执行使用不同型号。'}
      </p>
      <p className="field-help" id={helpId}>
        {allowed
          ? '关闭后，后续审计与执行必须使用不同型号。'
          : '审计须与总代理、执行子任务使用不同型号；换连接、账号或思考强度仍视为同一模型。'}
      </p>
      {confirming && (
        <Modal title="确认允许同模型审计" close={close} className="review-policy-confirm-modal">
          <div className="form-body review-policy-confirmation">
            <p className="review-policy-pending" id={`${helpId}-pending`} role="status">
              {disabled ? '当前表单暂不可调整，可以返回核对。' : '本次开启选择尚未确认。'}
            </p>
            <section aria-label="同模型审计的影响" id={`${helpId}-impact`}>
              <h3>审计独立性</h3>
              <p>相同模型可能重复执行时的判断偏差或遗漏，降低审计的独立性。</p>
            </section>
            <section aria-label="同模型审计的适用范围" id={`${helpId}-scope`}>
              <h3>仅限当前任务</h3>
              <p>保存后对后续计划、委派和模型切换生效。</p>
            </section>
            <p className="field-help review-policy-form-scope" id={`${helpId}-form`}>
              确认会更新当前表单的选择；仍需完成任务创建或约定保存，才会提交此要求。
            </p>
          </div>
          <footer className="modal-footer">
            <button
              type="button"
              className="secondary"
              aria-describedby={`${helpId}-pending`}
              onClick={close}
            >
              返回核对
            </button>
            <button
              type="button"
              className="primary"
              disabled={disabled}
              aria-describedby={`${helpId}-impact ${helpId}-scope ${helpId}-form ${helpId}-pending`}
              onClick={() => {
                change(true);
                close();
              }}
            >
              确认开启同模型审计
            </button>
          </footer>
        </Modal>
      )}
    </section>
  );
}
