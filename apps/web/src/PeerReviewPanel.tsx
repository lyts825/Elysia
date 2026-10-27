/**
 * 展示运行中的同行评审信息。
 * 展示冻结策略、候选和逐轮评分，区分评分通过与目标最终完成；不代替服务端评审调度或写入最终结论。
 * EN: Displays peer-review rounds for a run. Displays frozen policy, candidates, and per-round scores while distinguishing passing scores from final goal completion, without scheduling reviews or writing final decisions.
 */
import { useId } from 'react';
import type { Run } from '../../../packages/contracts/src/index';
import type { PeerReviewRound } from '../../../packages/contracts/src/peer-review';
import './peer-review.css';

const roundLabels: Record<PeerReviewRound['status'], string> = {
  reviewing: '评审中',
  passed: '评分通过',
  changes_requested: '需要修订',
  limit_reached: '已达轮次上限',
  stale: '原评分已失效',
};
const verdictLabels = { pass: '通过', fail: '未通过', insufficient: '证据不足' };

/**
 * 只读展示冻结的评审策略、候选和各轮逐项评分。通过评分与目标完成分别表达：
 * 只有当前合同候选通过且运行已 DONE 才展示最终确认，历史或 stale 轮次仍可展开核对。
 * EN: Read-only frozen policy/candidates/per-item scores. Passing and task completion differ: final confirmation requires a passing current-contract candidate and a DONE run. Historical/stale rounds remain inspectable.
 */
export function PeerReviewPanel({ run }: { run: Run }) {
  const id = useId();
  const policy = run.contract.peerReview;
  if (!policy) return null;
  const rounds = run.peerReview?.rounds ?? [];
  const latest = rounds.at(-1);
  /**
   * 最近一轮只有合同版本仍匹配且未标记过期时，才作为当前评审展示。
   * EN: Treat the latest round as current only for a matching contract version and non-stale round.
   */
  const current =
    latest && latest.candidate.contractVersion === run.contract.version && latest.status !== 'stale';
  const confirmed = run.status === 'DONE' && current && latest.status === 'passed';
  return (
    <section className="peer-review-panel" aria-labelledby={id + '-title'}>
      <h3 id={id + '-title'}>模型交叉评审</h3>
      <p className="peer-review-state" role="status">
        {confirmed
          ? '目标已完成：评分通过，最终证据已核验。'
          : latest?.status === 'passed' && current
            ? '评分通过，等待最终证据核验。'
            : latest && !current
              ? '目标或候选已变化，须重新评审。'
              : latest
                ? roundLabels[latest.status]
                : '等待执行模型提交候选输出。'}
      </p>
      <p className="field-help">
        {policy.reviewerProviderIds.length} 个评审模型 · 每项至少 {policy.minScore} 分 · 最多{' '}
        {policy.maxRounds} 轮。 每位评审的每项结论均须通过。模型评审与用户采纳分别记录。
      </p>
      {!!run.peerReview?.bindings.length && (
        <details>
          <summary>已固定的评审模型</summary>
          <ul>
            {run.peerReview.bindings.map((binding) => (
              <li key={binding.id}>
                {binding.label} · {binding.model}
              </li>
            ))}
          </ul>
        </details>
      )}
      {rounds.map((round, index) => (
        <details className="peer-review-round" key={round.candidate.id} open={index === rounds.length - 1}>
          <summary>
            第 {round.candidate.round} 轮 · {roundLabels[round.status]} · 已评分 {round.scores.length} /{' '}
            {policy.reviewerProviderIds.length}
          </summary>
          <p className="field-help">
            输出模型：{round.candidate.authorModel} · 任务约定 v{round.candidate.contractVersion}
          </p>
          {round.reason && (
            <p
              className="peer-review-reading"
              role="region"
              aria-label={`第 ${round.candidate.round} 轮状态说明`}
              tabIndex={0}
            >
              {round.reason}
            </p>
          )}
          <details>
            <summary>候选输出与核对标识</summary>
            <div
              className="peer-review-reading"
              role="region"
              aria-label={`第 ${round.candidate.round} 轮候选输出全文`}
              tabIndex={0}
            >
              <p className="workflow-prose">{round.candidate.summary}</p>
              {!!round.candidate.requirements?.length && (
                <>
                  <h4>本轮已应用的用户补充要求</h4>
                  <ul>
                    {round.candidate.requirements.map((requirement) => (
                      <li key={requirement.id} className="workflow-prose">
                        {requirement.text}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <dl>
                <dt>候选标识</dt>
                <dd>{round.candidate.id}</dd>
                <dt>候选指纹</dt>
                <dd>{round.candidate.fingerprint}</dd>
                <dt>提交时间</dt>
                <dd>{round.candidate.createdAt}</dd>
              </dl>
            </div>
          </details>
          {round.scores.map((score) => (
            <details className="peer-review-score" key={score.reviewerTaskId}>
              <summary>
                {score.reviewerModel} · {score.score} 分 · {score.passed ? '通过' : '未通过'}
              </summary>
              <div
                className="peer-review-reading"
                role="region"
                aria-label={`${score.reviewerModel} 第 ${round.candidate.round} 轮评分全文`}
                tabIndex={0}
              >
                <p className="workflow-prose">{score.summary}</p>
                <p className="field-help">评分时间：{score.submittedAt}</p>
                <ol className="peer-review-items">
                  {score.items.map((item) => (
                    <li key={item.criterion} value={item.criterion + 1}>
                      <strong>
                        {round.candidate.acceptanceCriteria[item.criterion] ?? `验收项 ${item.criterion + 1}`}
                      </strong>
                      <p>
                        {item.score} 分 · {verdictLabels[item.verdict]}
                      </p>
                      <p className="workflow-prose">{item.reason}</p>
                      <p className="field-help">
                        证据引用：{item.evidenceRefs.length ? item.evidenceRefs.join('、') : '未提供'}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          ))}
          {!round.scores.length && <p className="field-help">尚未收到评分。</p>}
        </details>
      ))}
    </section>
  );
}
