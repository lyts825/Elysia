export function HandoffReviewConfirmation({
  added,
  pending,
  ignored,
  disabled,
  ignore,
  back,
}: {
  added: number;
  pending: number;
  ignored: boolean;
  disabled: boolean;
  ignore: (value: boolean) => void;
  back: () => void;
}) {
  if (!added && !pending) return null;
  return (
    <section className="workflow-source" aria-label="确认复核备注范围">
      <strong>
        复核备注：已加入 {added} 条 · 待加入 {pending} 条
      </strong>
      {!!pending && (
        <>
          <p className="field-help">待加入的备注不会提交。请返回处理，或明确选择本次忽略后继续创建。</p>
          <button type="button" className="text-button" disabled={disabled} onClick={back}>
            返回处理待加入备注
          </button>
          <label className="workflow-note-choice">
            <input
              type="checkbox"
              aria-label="本次忽略待加入备注"
              checked={ignored}
              disabled={disabled}
              onChange={(event) => ignore(event.target.checked)}
            />
            <span>本次忽略这 {pending} 条待加入备注。创建成功后会清理其选择，原复核与本机备注保持不变。</span>
          </label>
        </>
      )}
    </section>
  );
}
