import { useState } from 'react';
import type { Contract } from '../../../packages/contracts/src/index';
import { Modal } from './Modal';
import { ReviewModelPolicy } from './ReviewModelPolicy';
export function ContractModal({
  contract,
  planMode,
  close,
  submit,
  busy,
  disabled,
}: {
  contract: Contract;
  planMode: boolean;
  close: () => void;
  submit: (c: Contract, sameModelReviewConfirmed: boolean) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [value, setValue] = useState(contract);
  const [reviewConfirmationPending, setReviewConfirmationPending] = useState(false);
  const [sameModelReviewConfirmed, setSameModelReviewConfirmed] = useState(false);
  const labels: Record<string, string> = {
    scope: '范围',
    nonGoals: '不包含',
    inputs: '输入资料',
    deliverables: '交付物',
    acceptanceCriteria: '验收项',
    constraints: '约束',
    assumptions: '可见假设',
  };
  return (
    <Modal
      title={'任务约定 · v' + contract.version}
      subtitle={
        disabled
          ? '当前约定仅供查看；继续调整可新建任务。'
          : planMode
            ? '修改后在安全边界重新生成计划，需再次确认；权限范围与累计预算保持。'
            : '在安全边界应用新的交付与验收项；权限范围与累计预算保持。'
      }
      busy={busy}
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || disabled || reviewConfirmationPending) return;
          submit(value, sameModelReviewConfirmed);
        }}
      >
        <div className="form-body">
          <ReviewModelPolicy
            allowed={value.allowSameModelReview === true}
            disabled={busy || disabled}
            change={(allowed) => {
              setValue((current) => ({ ...current, allowSameModelReview: allowed }));
              setSameModelReviewConfirmed(allowed);
            }}
            pendingChanged={setReviewConfirmationPending}
          />
          <label>
            目标
            <textarea
              disabled={busy}
              readOnly={disabled}
              value={value.objective}
              onChange={(e) => setValue((v) => ({ ...v, objective: e.target.value }))}
            />
          </label>
          {Object.entries(labels).map(([key, label]) => (
            <label key={key}>
              {label}（每行一项）
              <textarea
                rows={2}
                disabled={busy}
                readOnly={disabled}
                value={(value[key as keyof Contract] as string[]).join('\n')}
                onChange={(e) => setValue((v) => ({ ...v, [key]: e.target.value.split('\n') }))}
              />
            </label>
          ))}
          <p className="field-help">
            请求上限 {contract.budget.maxRequests} · Token 上限 {contract.budget.maxTokens}
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            关闭
          </button>
          <button className="primary" disabled={busy || disabled || reviewConfirmationPending}>
            {busy ? '正在保存约定…' : planMode ? '保存并重新规划' : '保存约定并继续'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
