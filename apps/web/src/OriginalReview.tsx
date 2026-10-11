import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeliveryReviewHistoryDetail, ReviewSourceNote } from '../../../packages/contracts/src/workflow';
import { useSurfaceClient, useSurfaceRoot } from './SurfaceClientContext';
import { Modal, ModalErrorContext } from './Modal';
import { ApiError } from './api';
import { ReviewRecord } from './ReviewRecord';
import { ReviewSourceNoteBody } from './ReviewSourceNotes';

export function OriginalReview({
  runId,
  note,
  close,
}: {
  runId: string;
  note: ReviewSourceNote;
  close: () => void;
}) {
  const { api } = useSurfaceClient(),
    surfaceRoot = useSurfaceRoot();
  const [value, setValue] = useState<DeliveryReviewHistoryDetail>(),
    [error, setError] = useState('');
  const [reading, setReading] = useState(true),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReading(true);
    setError('');
    void api<DeliveryReviewHistoryDetail>(
      `/runs/${runId}/delivery/reviews/${note.reviewId}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        if (next.runId !== runId || next.item.id !== note.reviewId || next.review.reviewId !== note.reviewId)
          throw new Error('原复核记录不匹配，请重试读取。');
        setValue(next);
      })
      .catch((issue) => {
        if (controller.signal.aborted) return;
        setValue(undefined);
        setError(
          issue instanceof ApiError && issue.status === 404
            ? '来源任务或原复核记录已不存在。本任务保留的备注快照不受影响。'
            : issue instanceof Error
              ? issue.message
              : '原复核暂不可读。',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
  }, [api, runId, note.reviewId, retry]);
  const visible = value?.runId === runId && value.item.id === note.reviewId ? value : undefined;
  return createPortal(
    <ModalErrorContext.Provider value="">
      <Modal
        title="原复核记录"
        subtitle="只读查看，不修改当前复核或草稿"
        close={close}
        wide
        className="workflow-modal"
      >
        <div className="form-body workflow-body">
          <details className="workflow-source" open={!!error}>
            <summary>本任务保留的备注快照</summary>
            <ReviewSourceNoteBody note={note} />
          </details>
          {reading && <p role="status">正在读取原复核…</p>}
          {error && (
            <p className="field-error" role="alert">
              {error} 已带入的原文仍保留。
              <button
                type="button"
                className="text-button"
                onClick={() => setRetry((n) => n + 1)}
                disabled={reading}
              >
                重试读取原复核
              </button>
            </p>
          )}
          {visible && (
            <ReviewRecord value={visible} reading={reading} reload={() => setRetry((n) => n + 1)} />
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={close}>
            关闭
          </button>
        </footer>
      </Modal>
    </ModalErrorContext.Provider>,
    surfaceRoot?.current || document.body,
  );
}
