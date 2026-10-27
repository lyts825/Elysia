/* 展示尚未关联的评审备注。 */
import { useEffect, useId, useRef, useState } from 'react';
import type { DeliveryCriterion, DeliveryReview } from '../../../packages/contracts/src/workflow';
import type { ReviewDraft } from './ReviewDraft';
import { CurrentCriterionPicker } from './CurrentCriterionPicker';
import './review-note-linking.css';
import './unlinked-review-notes.css';

export function UnlinkedReviewNotes({
  value,
  draft,
  disabled,
  change,
}: {
  value: DeliveryReview;
  draft: ReviewDraft;
  disabled: boolean;
  change: (patch: Partial<ReviewDraft>) => boolean;
}) {
  const panelId = useId();
  const [selected, setSelected] = useState<number>();
  const [target, setTarget] = useState<DeliveryCriterion | null>();
  const editor = useRef<HTMLElement>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  const item = selected === undefined ? undefined : draft.unlinked[selected];
  useEffect(() => {
    if (selected !== undefined) {
      editor.current?.focus({ preventScroll: true });
      editor.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);
  const returnToNote = () => {
    setSelected(undefined);
    setTarget(undefined);
    if (origin.current?.isConnected) origin.current.focus();
  };
  const addition = item
    ? `由旧备注手工关联（本次草稿）\n原标准：${item.unknownStandard ? '旧标准内容未记录' : item.text}\n${item.note}`
    : '';
  const current = target ? draft.criteriaNotes.find((note) => note.index === target.index) : undefined;
  const original = target === null ? draft.note : current?.note || '';
  const merged = original ? original + '\n\n' + addition : addition;
  const issue =
    target === undefined
      ? '请明确选择目标。'
      : target && current && current.text !== target.text
        ? '已有逐项备注对应另一标准，请先重新核对版本。'
        : target && !current && draft.criteriaNotes.length >= 40
          ? '逐项备注已达 40 条，请选择整体或保留旧备注。'
          : merged.length > (target === null ? 4000 : 1000)
            ? '合并后超出备注字数上限。原文不会截断，请取消后先调整现有备注，或选择整体备注。'
            : '';
  return (
    <details className="review-note-linking unlinked-review-notes" open>
      <summary>
        <span>尚未关联到当前标准的旧备注</span>
        <small>{draft.unlinked.length} 条待关联</small>
      </summary>
      <p className="field-help unlinked-review-state">
        当前保留在本机草稿中。选择目标并核对合并内容后，才会追加到相应的草稿备注。
      </p>
      {draft.unlinked.map((note, index) => (
        <div key={index} className="workflow-selection unlinked-review-item">
          <div className="unlinked-review-heading">
            <h4>旧备注 {index + 1}</h4>
            <small>{note.unknownStandard ? '原标准未记录' : '保留原标准与备注'}</small>
          </div>
          <p className="field-help unlinked-review-reading-label">
            <span>原标准</span>
            {!note.unknownStandard && <small>{note.text.length} 字符</small>}
          </p>
          <p
            className="workflow-prose review-link-reading"
            role="region"
            aria-label={`旧备注 ${index + 1} 原标准全文`}
            tabIndex={0}
          >
            {note.unknownStandard ? '旧标准内容未记录' : note.text}
          </p>
          <p className="field-help unlinked-review-reading-label">
            <span>备注原文</span>
            <small>{note.note.length} 字符</small>
          </p>
          <p
            className="workflow-prose review-link-reading"
            role="region"
            aria-label={`旧备注 ${index + 1} 原文全文`}
            tabIndex={0}
          >
            {note.note}
          </p>
          <details className="unlinked-review-source">
            <summary>旧备注来源</summary>
            <p
              className="unlinked-review-identity"
              role="region"
              aria-label={`旧备注 ${index + 1} 来源指纹全文`}
              tabIndex={0}
            >
              {note.fingerprint
                ? `来源指纹：${note.fingerprint}`
                : '未记录来源指纹，需手动核对原文与当前标准。'}
            </p>
          </details>
          <div className="workflow-actions unlinked-review-actions">
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              aria-label={`手动关联旧备注 ${index + 1}`}
              aria-expanded={selected === index}
              aria-controls={selected === index ? panelId : undefined}
              onClick={(event) => {
                origin.current = event.currentTarget;
                setSelected(index);
                setTarget(undefined);
              }}
            >
              手动关联此旧备注
            </button>
            <button
              type="button"
              className="text-button unlinked-review-remove"
              disabled={disabled || selected !== undefined}
              aria-label={`移除旧备注 ${index + 1}`}
              onClick={() => change({ unlinked: draft.unlinked.filter((_, i) => i !== index) })}
            >
              移除此旧备注
            </button>
          </div>
        </div>
      ))}
      {item && (
        <section
          ref={editor}
          id={panelId}
          tabIndex={-1}
          aria-label="旧备注关联预览"
          className="workflow-source review-link-editor"
        >
          <h4>关联旧备注 {selected! + 1}</h4>
          <p className="field-help unlinked-review-state">尚未追加到草稿，请核对目标与完整合并内容。</p>
          <details className="unlinked-review-source">
            <summary>当前交付版本与指纹</summary>
            <dl
              className="unlinked-review-identity"
              role="region"
              aria-label="旧备注关联的当前交付版本全文"
              tabIndex={0}
            >
              <div>
                <dt>根任务版本</dt>
                <dd>{value.rootRevision}</dd>
              </div>
              <div>
                <dt>交付指纹</dt>
                <dd>{value.fingerprint}</dd>
              </div>
            </dl>
          </details>
          <CurrentCriterionPicker
            key={`${value.fingerprint}:${selected}`}
            initial={value}
            selected={target?.index ?? (target === null ? null : undefined)}
            select={setTarget}
            disabled={disabled}
            overall
          />
          {target !== undefined && (
            <>
              <div className="unlinked-review-preview-heading">
                <strong>合并预览 · {target === null ? '整体备注' : `当前第 ${target.index + 1} 项`}</strong>
                <small>
                  {merged.length} / {target === null ? 4000 : 1000} 字符
                </small>
              </div>
              <p
                className="workflow-prose review-link-reading"
                role="region"
                aria-label="旧备注合并预览全文"
                tabIndex={0}
              >
                {merged}
              </p>
            </>
          )}
          <p className="field-help">只修改本机草稿，追加完整旧备注并标记为本次手工关联，不改变原复核历史。</p>
          {issue && (
            <p className="field-help unlinked-review-issue" role="status">
              {issue}
            </p>
          )}
          <div className="workflow-actions unlinked-review-actions">
            <button type="button" className="secondary" disabled={disabled} onClick={returnToNote}>
              取消关联，保留原稿
            </button>
            <button
              type="button"
              className="primary"
              disabled={disabled || !!issue}
              onClick={() => {
                if (disabled || issue || selected === undefined || target === undefined) return;
                const patch: Partial<ReviewDraft> = {
                  unlinked: draft.unlinked.filter((_, index) => index !== selected),
                };
                if (target === null) patch.note = merged;
                else
                  patch.criteriaNotes = [
                    ...draft.criteriaNotes.filter((note) => note.index !== target.index),
                    {
                      index: target.index,
                      text: target.text,
                      note: merged,
                      unknownStandard: false,
                      fingerprint: value.fingerprint,
                    },
                  ];
                if (change(patch)) {
                  setSelected(undefined);
                  setTarget(undefined);
                  editor.current?.parentElement?.querySelector<HTMLElement>('summary')?.focus();
                }
              }}
            >
              确认追加到草稿
            </button>
          </div>
        </section>
      )}
      <p className="field-help">未关联的旧备注不随复核结论自动提交；取消或保存失败仍保留原稿。</p>
    </details>
  );
}
