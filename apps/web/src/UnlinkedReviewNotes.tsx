import { useState } from 'react';
import type { DeliveryCriterion, DeliveryReview } from '../../../packages/contracts/src/workflow';
import type { ReviewDraft } from './ReviewDraft';
import { CurrentCriterionPicker } from './CurrentCriterionPicker';

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
  const [selected, setSelected] = useState<number>();
  const [target, setTarget] = useState<DeliveryCriterion | null>();
  const item = selected === undefined ? undefined : draft.unlinked[selected];
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
    <details open>
      <summary>尚未关联到当前标准的旧备注</summary>
      {draft.unlinked.map((note, index) => (
        <div key={index} className="workflow-selection">
          <p className="workflow-prose">
            {note.text}：{note.note}
          </p>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => {
              setSelected(index);
              setTarget(undefined);
            }}
          >
            手动关联此旧备注
          </button>
          <button
            type="button"
            className="text-button"
            disabled={disabled || selected !== undefined}
            onClick={() => change({ unlinked: draft.unlinked.filter((_, i) => i !== index) })}
          >
            移除此旧备注
          </button>
        </div>
      ))}
      {item && (
        <section aria-label="旧备注关联预览" className="workflow-source">
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
              <strong>合并预览 · {target === null ? '整体备注' : `当前第 ${target.index + 1} 项`}</strong>
              <p className="workflow-prose">{merged}</p>
            </>
          )}
          <p className="field-help">只修改本机草稿，追加完整旧备注并标记为本次手工关联，不改变原复核历史。</p>
          {issue && <p className="field-help">{issue}</p>}
          <div className="workflow-actions">
            <button
              type="button"
              className="secondary"
              disabled={disabled}
              onClick={() => {
                setSelected(undefined);
                setTarget(undefined);
              }}
            >
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
