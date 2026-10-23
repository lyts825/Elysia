import type { ReactNode } from 'react';
import type { DeliveryReviewHistoryDetail } from '../../../packages/contracts/src/workflow';
import { DeliveryChanges } from './DeliveryChanges';
import { ArtifactChanges } from './ArtifactChanges';
import './review-history.css';

export function ReviewRecord({
  value,
  reload,
  reading = false,
  renderNotes,
}: {
  value: DeliveryReviewHistoryDetail;
  reload: () => void;
  reading?: boolean;
  renderNotes?: (value: DeliveryReviewHistoryDetail) => ReactNode;
}) {
  return (
    <section className="workflow-history-detail review-record" aria-label="历史复核详情">
      <h4>
        {value.review.decision === 'accepted' ? '已采纳' : '需修改'} · {value.review.reviewedAt}
      </h4>
      <DeliveryChanges value={value.changeSummary} />
      <ArtifactChanges
        runId={value.runId}
        reviewId={value.item.id}
        fingerprint={value.currentFingerprint}
        reload={reload}
        reading={reading}
      />
      {renderNotes ? (
        renderNotes(value)
      ) : (
        <>
          {!!value.review.note && (
            <section className="review-record-note" aria-label="历史整体备注">
              <h5>整体备注</h5>
              <p
                className="workflow-prose review-record-reading"
                role="region"
                aria-label="历史整体备注全文"
                tabIndex={0}
              >
                {value.review.note}
              </p>
            </section>
          )}
          {!!value.review.criteriaNotes.length && (
            <ol className="review-record-notes" aria-label="历史逐项意见">
              {value.review.criteriaNotes.map((note) => (
                <li className="review-record-note" key={note.index}>
                  <h5>原第 {note.index + 1} 项</h5>
                  <p className="field-help">原验收标准</p>
                  <p
                    className="workflow-prose review-record-reading"
                    role="region"
                    aria-label={`原第 ${note.index + 1} 项标准全文`}
                    tabIndex={0}
                  >
                    {note.criterionText ?? '旧标准内容未记录'}
                  </p>
                  <p className="field-help">复核意见</p>
                  <p
                    className="workflow-prose review-record-reading"
                    role="region"
                    aria-label={`原第 ${note.index + 1} 项意见全文`}
                    tabIndex={0}
                  >
                    {note.note}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      <details>
        <summary>版本与来源信息</summary>
        <p
          className="review-record-reading review-record-origin"
          role="region"
          aria-label="历史复核版本与来源全文"
          tabIndex={0}
        >
          复核记录 {value.item.id}
          <br />
          交付指纹 {value.review.fingerprint}
        </p>
      </details>
    </section>
  );
}
