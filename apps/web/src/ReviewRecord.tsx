/* 展示单条交付评审记录。 */
import type { ReactNode } from 'react';
import type { DeliveryReviewHistoryDetail } from '../../../packages/contracts/src/workflow';
import { DeliveryChanges } from './DeliveryChanges';
import { ArtifactChanges } from './ArtifactChanges';
import './review-history.css';
import './review-record.css';

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
  // 复核结论、比较结果和产物变更来自同一历史记录，由调用方控制刷新。
  return (
    <section className="workflow-history-detail review-record review-entry-record" aria-label="历史复核详情">
      <header className="review-entry-heading">
        <h4>{value.review.decision === 'accepted' ? '已采纳' : '需修改'}</h4>
        <span>历史复核记录</span>
      </header>
      <dl className="review-entry-summary" aria-label="历史复核记录摘要">
        <div>
          <dt>复核时间</dt>
          <dd className="review-entry-time" tabIndex={0} aria-label="历史复核完整时间">
            {value.review.reviewedAt}
          </dd>
        </div>
        <div>
          <dt>原记录整体备注</dt>
          <dd>{value.review.note.trim() ? '已填写' : '未填写'}</dd>
        </div>
        <div>
          <dt>原记录逐项意见</dt>
          <dd>{value.review.criteriaNotes.length} 条</dd>
        </div>
        <div>
          <dt>记录来源</dt>
          <dd>{value.item.origin === 'legacy_snapshot' ? '旧任务保留快照' : '已保存复核记录'}</dd>
        </div>
      </dl>
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
          {!!value.review.note.trim() && (
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
          {!value.review.note.trim() && !value.review.criteriaNotes.length && (
            <p className="field-help">这份复核未附整体备注或逐项意见。</p>
          )}
          {!!value.review.criteriaNotes.length && (
            <section className="review-entry-notes">
              <h5>原逐项复核意见 · {value.review.criteriaNotes.length} 条</h5>
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
            </section>
          )}
        </>
      )}
      <details className="review-entry-origin">
        <summary>版本与来源信息</summary>
        <dl
          className="review-record-reading review-entry-origin-fields"
          role="region"
          aria-label="历史复核版本与来源全文"
          tabIndex={0}
        >
          <div>
            <dt>复核记录标识</dt>
            <dd>{value.item.id}</dd>
          </div>
          <div>
            <dt>所属任务标识</dt>
            <dd>{value.runId}</dd>
          </div>
          <div>
            <dt>原复核交付指纹</dt>
            <dd>{value.review.fingerprint}</dd>
          </div>
          <div>
            <dt>当前已读交付指纹</dt>
            <dd>{value.currentFingerprint || '未提供'}</dd>
          </div>
          <div>
            <dt>原复核根任务</dt>
            <dd>{value.review.rootTaskId}</dd>
          </div>
          <div>
            <dt>原复核根任务版本</dt>
            <dd>{value.review.rootRevision}</dd>
          </div>
          <div>
            <dt>当前已读任务版本</dt>
            <dd>{value.runRevision}</dd>
          </div>
          <div>
            <dt>当前已读根任务版本</dt>
            <dd>{value.rootRevision ?? '未提供'}</dd>
          </div>
          <div>
            <dt>比较基线</dt>
            <dd>{value.item.baselineAvailable ? '已记录' : '未记录'}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
