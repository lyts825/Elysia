/**
 * 确认交接内容的复核操作。
 * 对准备带入的交接来源展示分步复核与确认状态，向父组件报告待确认阶段；不直接发送续接请求。
 * EN: Confirms the scope of reviewed content included in a handoff. Presents staged review/acknowledgement for handoff sources and reports pending confirmation to the parent without directly submitting continuation.
 */
import { useId } from 'react';
import './handoff-review-confirmation.css';

/**
 * 明确区分已加入与仍待加入的备注/差异数量。存在待处理内容时由父级记录本次忽略选择，
 * 此组件只报告决定，不能自动把待处理内容加入创建负载或删除原备注。
 * EN: Distinguish added notes/differences from those still pending. The parent records an explicit ignore choice when pending content exists. This component reports a decision only; it cannot add pending content to the creation payload or delete original notes.
 */
export function HandoffReviewConfirmation({
  added,
  pending,
  addedDifferences = 0,
  pendingDifferences = 0,
  ignored,
  disabled,
  ignore,
  back,
}: {
  added: number;
  addedDifferences?: number;
  pendingDifferences?: number;
  pending: number;
  ignored: boolean;
  disabled: boolean;
  ignore: (value: boolean) => void;
  back: () => void;
}) {
  const explanationId = useId();
  const hasPending = !!pending || !!pendingDifferences;
  /**
   * 没有任何复核备注或差异时无需确认范围。
   * EN: No scope confirmation is needed when there are no review notes or differences.
   */
  if (!added && !pending && !addedDifferences && !pendingDifferences) return null;
  return (
    <section className="workflow-source handoff-confirmation" aria-label="确认复核备注范围">
      <h3>备注与差异提交范围</h3>
      <dl className="handoff-confirmation-counts">
        <div>
          <dt>复核备注</dt>
          <dd>
            已加入 {added} 条<span>待加入 {pending} 条</span>
          </dd>
        </div>
        <div>
          <dt>差异修改</dt>
          <dd>
            已加入 {addedDifferences} 项<span>待加入 {pendingDifferences} 项</span>
          </dd>
        </div>
      </dl>
      <p
        className="handoff-confirmation-state"
        data-scope={hasPending ? (ignored ? 'ignored' : 'pending') : 'added-only'}
        role="status"
      >
        {hasPending && disabled && '当前范围暂不可调整。'}
        {hasPending
          ? ignored
            ? '已选择本次忽略，待加入内容仍不提交。'
            : '待加入内容尚未确认，请返回处理或明确选择本次忽略。'
          : '本次创建将携带已加入的备注与差异修改。'}
      </p>
      {hasPending && (
        <div className="handoff-confirmation-decision">
          <p className="field-help" id={explanationId}>
            待加入的备注和差异要求不会提交。请返回处理，或明确选择本次忽略后继续创建。
            创建成功后会清理其选择，原复核与本机备注保持不变。
          </p>
          <div className="handoff-confirmation-actions">
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              aria-describedby={explanationId}
              onClick={back}
            >
              返回处理待加入内容
            </button>
            <label className="check-label handoff-confirmation-choice">
              <input
                type="checkbox"
                aria-label="本次忽略待加入内容"
                aria-describedby={explanationId}
                checked={ignored}
                disabled={disabled}
                onChange={(event) => ignore(event.target.checked)}
              />
              <span>本次忽略待加入内容</span>
            </label>
          </div>
        </div>
      )}
    </section>
  );
}
