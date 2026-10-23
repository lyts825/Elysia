import { useId, useState } from 'react';
import { Modal } from './Modal';
import './workflow-policy-confirmation.css';

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
  const helpId = useId();
  const close = () => {
    setConfirming(false);
    pendingChanged(false);
  };
  return (
    <section className="review-model-policy" aria-label="审计模型要求">
      <label className="check-label">
        <input
          type="checkbox"
          role="switch"
          checked={allowed}
          disabled={disabled}
          aria-describedby={helpId}
          onChange={(event) => {
            if (!event.target.checked) change(false);
            else {
              setConfirming(true);
              pendingChanged(true);
            }
          }}
        />
        允许审计与执行使用相同模型
      </label>
      <p className="field-help" id={helpId}>
        {allowed
          ? '已确认允许本任务使用相同模型。关闭后，后续审计与执行必须使用不同型号。'
          : '默认关闭。审计须与总代理、执行子任务使用不同型号；换连接、账号或思考强度仍视为同一模型。'}
      </p>
      {confirming && (
        <Modal title="确认允许同模型审计" close={close}>
          <div className="form-body review-policy-confirmation">
            <section aria-label="同模型审计的影响">
              <h3>审计独立性</h3>
              <p>相同模型可能重复执行时的判断偏差或遗漏，降低审计的独立性。</p>
            </section>
            <section aria-label="同模型审计的适用范围">
              <h3>仅限当前任务</h3>
              <p>保存后对后续计划、委派和模型切换生效。</p>
            </section>
          </div>
          <footer className="modal-footer">
            <button type="button" className="secondary" onClick={close}>
              保持关闭
            </button>
            <button
              type="button"
              className="primary"
              disabled={disabled}
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
