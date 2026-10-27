/* 在弹窗中展示任务契约。 */
import { useId, useState } from 'react';
import type { Contract } from '../../../packages/contracts/src/index';
import { Modal } from './Modal';
import { ReviewModelPolicy } from './ReviewModelPolicy';
import './execution-config.css';
import './contract-modal.css';
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
  const id = useId();
  const [value, setValue] = useState(contract);
  const [reviewConfirmationPending, setReviewConfirmationPending] = useState(false);
  const [sameModelReviewConfirmed, setSameModelReviewConfirmed] = useState(false);
  const edited = JSON.stringify(value) !== JSON.stringify(contract);
  const versionChanged = value.version !== contract.version;
  const groups = [
    { title: '范围与资料', fields: { scope: '范围', nonGoals: '不包含', inputs: '输入资料' } },
    { title: '交付与验收', fields: { deliverables: '交付物', acceptanceCriteria: '验收项' } },
    { title: '约束与假设', fields: { constraints: '约束', assumptions: '可见假设' } },
  ];
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
      className="execution-config-modal contract-editor-modal"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || disabled || reviewConfirmationPending) return;
          submit(value, sameModelReviewConfirmed);
        }}
      >
        <div className="form-body">
          <p className="contract-editor-state" role="status">
            <strong>
              {busy
                ? '正在保存约定'
                : disabled
                  ? '只读约定'
                  : versionChanged
                    ? '本机编辑保留'
                    : edited
                      ? '有未保存修改'
                      : '当前已读约定'}
            </strong>
            <span>依据版本 v{value.version}</span>
            {versionChanged && <span>当前已读约定 v{contract.version}，本机内容未被替换。</span>}
          </p>
          <section className="execution-config-section" aria-labelledby={id + '-objective'}>
            <h3 id={id + '-objective'}>任务目标</h3>
            {disabled && (
              <p className="execution-config-note" id={id + '-readonly'}>
                当前为只读约定，可聚焦文本框阅读完整内容。
              </p>
            )}
            <label className="execution-config-field">
              目标
              <textarea
                rows={4}
                disabled={busy}
                readOnly={disabled}
                aria-describedby={disabled ? id + '-readonly' : undefined}
                value={value.objective}
                onChange={(e) => setValue((v) => ({ ...v, objective: e.target.value }))}
              />
            </label>
          </section>
          {groups.map((group, index) => (
            <section
              key={group.title}
              className="execution-config-section"
              aria-labelledby={id + '-group-' + index}
            >
              <h3 id={id + '-group-' + index}>{group.title}</h3>
              <p className="field-help" id={id + '-lines-' + index}>
                每行一项，保留完整内容。
              </p>
              <div className="execution-config-fields">
                {Object.entries(group.fields).map(([key, label]) => (
                  <label className="execution-config-field" key={key}>
                    {label}
                    <textarea
                      rows={3}
                      disabled={busy}
                      readOnly={disabled}
                      aria-describedby={id + '-lines-' + index}
                      value={(value[key as keyof Contract] as string[]).join('\n')}
                      onChange={(e) => setValue((v) => ({ ...v, [key]: e.target.value.split('\n') }))}
                    />
                  </label>
                ))}
              </div>
            </section>
          ))}
          <section
            className="execution-config-section execution-contract-policy"
            aria-labelledby={id + '-policy'}
          >
            <h3 id={id + '-policy'}>审计要求与预算</h3>
            {contract.peerReview && (
              <div className="contract-editor-budget-note">
                <p>
                  已启用评审模式：{contract.peerReview.reviewerProviderIds.length} 个模型独立评分，每项至少{' '}
                  {contract.peerReview.minScore} 分，最多 {contract.peerReview.maxRounds} 轮。
                </p>
                <p>
                  评审配置在创建时固定。每位评审的每项结论均须通过，目标才能确认完成；修改目标或验收标准后需重新评审。
                </p>
                <p className="run-setup-reading" role="region" aria-label="评审连接完整标识" tabIndex={0}>
                  {contract.peerReview.reviewerProviderIds.join('、')}
                </p>
              </div>
            )}
            <ReviewModelPolicy
              allowed={value.allowSameModelReview === true}
              disabled={busy || disabled}
              change={(allowed) => {
                setValue((current) => ({ ...current, allowSameModelReview: allowed }));
                setSameModelReviewConfirmed(allowed);
              }}
              pendingChanged={setReviewConfirmationPending}
            />
            <p className="contract-editor-budget-note">当前已读预算，仅供查看 · v{contract.version}</p>
            <dl className="execution-config-budget">
              <div>
                <dt>请求上限</dt>
                <dd>{contract.budget.maxRequests}</dd>
              </div>
              <div>
                <dt>Token 上限</dt>
                <dd>{contract.budget.maxTokens}</dd>
              </div>
              <div>
                <dt>金额上限</dt>
                <dd>{contract.budget.maxCost == null ? '未设置' : contract.budget.maxCost}</dd>
              </div>
            </dl>
          </section>
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
