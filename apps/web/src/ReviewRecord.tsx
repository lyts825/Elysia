import type { ReactNode } from 'react';
import type { DeliveryReviewHistoryDetail } from '../../../packages/contracts/src/workflow';
import { DeliveryChanges } from './DeliveryChanges';
import { ArtifactChanges } from './ArtifactChanges';

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
    <section className="workflow-history-detail" aria-label="历史复核详情">
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
          {!!value.review.note && <p className="workflow-prose">整体备注：{value.review.note}</p>}
          {value.review.criteriaNotes.map((note) => (
            <div key={note.index}>
              <strong>
                原第 {note.index + 1} 项 · {note.criterionText ?? '旧标准内容未记录'}
              </strong>
              <p className="workflow-prose">{note.note}</p>
            </div>
          ))}
        </>
      )}
      <details>
        <summary>版本与来源信息</summary>
        <small>
          复核记录 {value.item.id}
          <br />
          交付指纹 {value.review.fingerprint}
        </small>
      </details>
    </section>
  );
}
