import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DeliveryCriterion,
  DeliveryReview,
  DeliveryReviewState,
} from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';

import { readReviewDraft, type ReviewDraft } from './ReviewDraft';

export function DeliveryUserReview({
  value,
  rawDraft,
  changeDraft,
  disabled,
  reading,
  readVersion,
  activity,
  reload,
  saved,
  children,
}: {
  value: DeliveryReview;
  rawDraft: unknown;
  changeDraft: (raw: string) => void;
  disabled: boolean;
  reading: boolean;
  readVersion: number;
  activity: (busy: boolean) => void;
  reload: () => void;
  saved: (value: DeliveryReviewState) => void;
  children: (note: (criterion: DeliveryCriterion) => ReactNode) => ReactNode;
}) {
  const { mutation } = useSurfaceClient();
  const draft = useMemo(() => readReviewDraft(rawDraft, value), [rawDraft, value]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [conflict, setConflict] = useState(false);
  useEffect(() => {
    setConflict(false);
    setError('');
  }, [readVersion]);
  const changed = draft.fingerprint !== value.fingerprint;
  const patch = (next: Partial<ReviewDraft>) => {
    setNotice('');
    const updated = { ...draftRef.current, ...next };
    const raw = JSON.stringify(updated);
    if (raw.length > 200000) {
      setError('复核草稿已达到本机保存上限，本次输入未写入。请先复制并移除不再需要的旧备注。');
      return;
    }
    draftRef.current = updated;
    changeDraft(raw);
  };
  const readonly = disabled || reading || busy;
  const noteEditor = (criterion: DeliveryCriterion) => {
    if (changed) return null;
    const current = draft.criteriaNotes.find((item) => item.index === criterion.index);
    return (
      <label className="workflow-review-note">
        我的复核备注
        {current?.unknownStandard && (
          <small className="field-help">此条旧备注未记录原标准，请核对当前验收项后保存。</small>
        )}
        <textarea
          aria-label={`第 ${criterion.index + 1} 项复核备注`}
          value={current?.note || ''}
          maxLength={1000}
          rows={2}
          disabled={readonly || changed || (!current && draft.criteriaNotes.length >= 40)}
          onChange={(event) =>
            patch({
              criteriaNotes: [
                ...draft.criteriaNotes.filter((item) => item.index !== criterion.index),
                ...(event.target.value
                  ? [
                      {
                        index: criterion.index,
                        text: criterion.text,
                        note: event.target.value,
                        unknownStandard: false,
                      },
                    ]
                  : []),
              ],
            })
          }
        />
      </label>
    );
  };
  async function save() {
    if (readonly || changed || conflict || !draft.decision) return;
    setBusy(true);
    activity(true);
    setError('');
    try {
      const result = await mutation<DeliveryReviewState>(
        `/runs/${value.runId}/delivery/review`,
        {
          expectedRevision: value.runRevision,
          expectedRootRevision: value.rootRevision,
          expectedFingerprint: value.fingerprint,
          decision: draft.decision,
          note: draft.note,
          criteriaNotes: draft.criteriaNotes.map(({ index, note }) => ({ index, note })),
        },
        'PUT',
      );
      saved(result);
      changeDraft(draft.unlinked.length ? JSON.stringify(draft) : '');
      setNotice(
        draft.unlinked.length
          ? '复核已保存；未关联的旧备注仍保留为本机草稿，可复制后手动移除。'
          : '复核已保存，执行记录保持不变。',
      );
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : '保存失败，备注草稿已保留。');
      if (issue instanceof ApiError && issue.status === 409) setConflict(true);
    } finally {
      setBusy(false);
      activity(false);
    }
  }
  return (
    <>
      <section className="workflow-user-review" aria-label="用户复核">
        <h3>
          用户复核 ·{' '}
          {value.userReview?.stale
            ? '旧结论已失效'
            : value.userReview?.decision === 'accepted'
              ? '已采纳'
              : value.userReview?.decision === 'changes_requested'
                ? '需修改'
                : '未复核'}
        </h3>
        <p className="field-help">
          你的结论只针对当前交付版本，与执行完成和结构核验分别记录。未保存备注会保留为本机草稿。
        </p>
        {value.userReview && <p className="field-help">上次保存：{value.userReview.reviewedAt}</p>}
        {(changed || conflict) && (
          <div className="inline-warning" role="alert">
            <p>
              {changed
                ? '交付版本已变化，旧结论不适用于当前版本。输入已保留，请重新核对证据。'
                : '保存时记录已变化。请重新读取交付；当前输入已保留。'}
            </p>
            <button type="button" className="secondary" disabled={reading || busy} onClick={reload}>
              重新读取交付
            </button>
            {changed && !reading && (
              <button
                type="button"
                className="secondary"
                disabled={disabled || busy}
                onClick={() => {
                  const kept = draft.criteriaNotes.filter(
                    (note) =>
                      !note.unknownStandard &&
                      value.criteria.some(
                        (criterion) => criterion.index === note.index && criterion.text === note.text,
                      ),
                  );
                  const detached = draft.criteriaNotes.filter((note) => !kept.includes(note));
                  patch({
                    fingerprint: value.fingerprint,
                    decision: '',
                    criteriaNotes: kept,
                    unlinked: [
                      ...draft.unlinked,
                      ...detached.map((note) => ({ ...note, fingerprint: draft.fingerprint })),
                    ],
                  });
                }}
              >
                已核对新版本，保留备注重新决定
              </button>
            )}
          </div>
        )}
        {changed && !!draft.criteriaNotes.length && (
          <details open>
            <summary>旧交付版本的逐项备注</summary>
            {draft.criteriaNotes.map((item) => (
              <p key={item.index} className="workflow-prose">
                {item.text}：{item.note}
              </p>
            ))}
          </details>
        )}
        {!!draft.unlinked.length && (
          <details open>
            <summary>尚未关联到当前标准的旧备注</summary>
            {draft.unlinked.map((item, index) => (
              <div key={index}>
                <p className="workflow-prose">
                  {item.text}：{item.note}
                </p>
                <button
                  type="button"
                  className="text-button"
                  disabled={readonly}
                  onClick={() => patch({ unlinked: draft.unlinked.filter((_, i) => i !== index) })}
                >
                  移除此旧备注
                </button>
              </div>
            ))}
            <p className="field-help">
              请将适用内容复制到当前验收项；这些旧备注不会自动提交，保存结论后仍保留在本机，移除只影响本机草稿。
            </p>
          </details>
        )}
        <label>
          复核结论
          <select
            aria-label="用户复核结论"
            value={draft.decision}
            disabled={readonly || changed}
            onChange={(event) => patch({ decision: event.target.value as ReviewDraft['decision'] })}
          >
            <option value="">请选择结论</option>
            <option value="accepted">已采纳</option>
            <option value="changes_requested">需修改</option>
          </select>
        </label>
        <label>
          整体备注
          <textarea
            aria-label="整体复核备注"
            rows={3}
            maxLength={4000}
            value={draft.note}
            disabled={readonly}
            onChange={(event) => patch({ note: event.target.value })}
          />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error} 当前输入已保留。
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <button
          type="button"
          className="primary"
          disabled={readonly || changed || conflict || !draft.decision}
          onClick={() => void save()}
        >
          {busy ? '正在保存…' : '保存复核结论'}
        </button>
      </section>
      {children(noteEditor)}
    </>
  );
}
