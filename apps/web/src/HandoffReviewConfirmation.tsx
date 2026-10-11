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
  if (!added && !pending && !addedDifferences && !pendingDifferences) return null;
  return (
    <section className="workflow-source" aria-label="确认复核备注范围">
      <strong>
        复核备注：已加入 {added} 条 · 待加入 {pending} 条
        <br />
        差异修改：已加入 {addedDifferences} 项 · 待加入 {pendingDifferences} 项
      </strong>
      {(!!pending || !!pendingDifferences) && (
        <>
          <p className="field-help">
            待加入的备注和差异要求不会提交。请返回处理，或明确选择本次忽略后继续创建。
          </p>
          <button type="button" className="text-button" disabled={disabled} onClick={back}>
            返回处理待加入内容
          </button>
          <label className="workflow-note-choice">
            <input
              type="checkbox"
              aria-label="本次忽略待加入内容"
              checked={ignored}
              disabled={disabled}
              onChange={(event) => ignore(event.target.checked)}
            />
            <span>
              本次忽略 {pending} 条待加入备注和 {pendingDifferences}{' '}
              项差异。创建成功后会清理其选择，原复核与本机备注保持不变。
            </span>
          </label>
        </>
      )}
    </section>
  );
}
