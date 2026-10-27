/* 展示原始评审内容。 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeliveryReviewHistoryDetail, ReviewSourceNote } from '../../../packages/contracts/src/workflow';
import { useSurfaceClient, useSurfaceRoot } from './SurfaceClientContext';
import { Modal, ModalErrorContext } from './Modal';
import { ApiError } from './api';
import { ReviewRecord } from './ReviewRecord';
import { ReviewSourceNoteBody } from './ReviewSourceNotes';
import './original-review.css';

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
        className="workflow-modal original-review-modal"
      >
        <div className="form-body workflow-body">
          <details className="workflow-source" open={!!error}>
            <summary>本任务保留的备注快照</summary>
            <p className="field-help">带入任务时保留的内容，可与下方原复核记录核对。</p>
            <div
              className="original-review-snapshot"
              role="region"
              aria-label="本任务保留的备注快照全文"
              tabIndex={0}
            >
              <ReviewSourceNoteBody note={note} />
            </div>
          </details>
          {reading && !visible && <p role="status">正在读取原复核…</p>}
          {error && (
            <div className="workflow-read-error original-review-error" role="alert">
              <p
                className="original-review-error-reading"
                role="region"
                aria-label="原复核读取错误全文"
                tabIndex={0}
              >
                {error} 已带入的原文仍保留。
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() => setRetry((n) => n + 1)}
                disabled={reading}
              >
                重试读取原复核
              </button>
            </div>
          )}
          {visible && (
            <>
              <p className="field-help" role="status">
                {reading
                  ? '正在重读；上次读取的原复核仍保留。'
                  : '原复核记录已读取，可展开版本与来源信息核对。'}
              </p>
              <ReviewRecord value={visible} reading={reading} reload={() => setRetry((n) => n + 1)} />
            </>
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
