import { useId } from 'react';
import './workflow-policy-confirmation.css';

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
  if (!added && !pending && !addedDifferences && !pendingDifferences) return null;
  return (
    <section className="workflow-source handoff-confirmation" aria-label="确认复核备注范围">
      <h3>本次提交范围</h3>
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
      {(!!pending || !!pendingDifferences) && (
        <>
          <p className="field-help" id={explanationId}>
            待加入的备注和差异要求不会提交。请返回处理，或明确选择本次忽略后继续创建。
            创建成功后会清理其选择，原复核与本机备注保持不变。
          </p>
          <button type="button" className="text-button" disabled={disabled} onClick={back}>
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
        </>
      )}
    </section>
  );
}
