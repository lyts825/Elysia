/**
 * 展示项目看板中的交付项及准备状态。
 * 围绕单个交付项展示状态、准备阻碍和可用动作，向父组件报告选择与启动意图；不自行计算运行的权威结论。
 * EN: Displays a project delivery item and readiness. Shows state, readiness blockers, and actions for one deliverable and reports selection/launch intent; authoritative run conclusions are supplied externally.
 */
import { useEffect, useId, useState } from 'react';
import type {
  ProjectDeliveryBoard,
  ProjectDeliveryItem,
  ProjectDeliveryAttempts,
  ProjectDeliveryReadiness,
} from '../../../packages/contracts/src/project-delivery';
import { useSurfaceClient } from './SurfaceClientContext';
import { ProjectRunList, reviewLabels, executionLabel } from './ProjectRunList';
import './project-board-item.css';
/**
 * 就绪状态映射为可核对的原因；状态值本身仍由服务端提供。
 * EN: Map server readiness to reviewable reasons without inventing status.
 */
export const readinessLabels: Record<ProjectDeliveryReadiness, string> = {
  unlinked: '尚未关联执行',
  unconfirmed: '待确认符合项目标准',
  not_done: '执行未完成',
  review_pending: '等待人工复核',
  review_stale: '交付已变化，需重新复核',
  changes_requested: '人工复核需修改',
  source_feedback_pending: '原意见尚未全部复验通过',
  unavailable: '部分记录无法读取',
  ready: '可纳入项目交付',
};
/**
 * 展示一个交付项的标准、当前候选和全部关联尝试。尝试页必须匹配项目、项 ID 和看板修订，
 * 计划变化后旧页不能继续作为确认依据；关联、确认和重开动作由外层统一版本门禁执行。
 * EN: Show criteria, candidate, and linked attempts. Pages must match project/item/board revision. Plan changes invalidate old confirmation evidence. Parent version gates handle linking, confirmation, and reopening.
 */
export function ProjectBoardItem({
  board,
  item,
  busy,
  note,
  changeNote,
  query,
  changeQuery,
  openRun,
  createRun,
  action,
}: {
  board: ProjectDeliveryBoard;
  item: ProjectDeliveryItem;
  busy: boolean;
  note: string;
  changeNote: (value: string) => void;
  query: string;
  changeQuery: (value: string) => void;
  openRun: (id: string, review?: boolean) => void;
  createRun: () => void;
  action: (path: string, body: Record<string, unknown>) => Promise<boolean>;
}) {
  const { api } = useSurfaceClient();
  const identity = useId();
  const [linking, setLinking] = useState(false),
    [attempts, setAttempts] = useState<ProjectDeliveryAttempts>(),
    [error, setError] = useState('');
  const [before, setBefore] = useState(''),
    [trail, setTrail] = useState<string[]>([]),
    [retry, setRetry] = useState(0),
    [loading, setLoading] = useState(false);
  const base = `/projects/${board.projectId}/delivery-board/items/${item.id}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setAttempts(undefined);
    void api<ProjectDeliveryAttempts>(
      base + '/runs' + (before ? '?before=' + encodeURIComponent(before) : ''),
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          result.projectId !== board.projectId ||
          result.itemId !== item.id ||
          result.boardRevision !== board.revision
        )
          throw Error('项目计划已变化，请刷新工作台后读取关联执行。');
        setAttempts(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '关联执行读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, base, before, board.revision, board.projectId, item.id, retry]);
  const current = item.current;
  const writable = !busy && !board.archived;
  return (
    <section className="project-item-detail project-board-item" aria-label="交付项详情">
      <div className="project-section-heading">
        <div>
          <h2 id={`${identity}-item`}>{item.title}</h2>
          <p>
            {item.required ? '必需交付项' : '可选交付项'} · 标准版本 {item.itemRevision}
          </p>
        </div>
        <span className={'project-readiness ' + (item.readiness === 'ready' ? 'ready' : '')}>
          {readinessLabels[item.readiness]}
        </span>
      </div>
      {item.description && (
        <p
          className="project-prose project-item-reading"
          role="region"
          aria-label="交付项完整说明"
          tabIndex={0}
        >
          {item.description}
        </p>
      )}
      <div className="project-form-columns project-item-requirements">
        <div>
          <h3>
            交付物 <span className="project-item-count">{item.deliverables.length} 项</span>
          </h3>
          <div className="project-item-reading" role="region" aria-label="项目交付物全文" tabIndex={0}>
            <ol>
              {item.deliverables.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ol>
          </div>
        </div>
        <div>
          <h3>
            项目验收标准 <span className="project-item-count">{item.acceptanceCriteria.length} 项</span>
          </h3>
          <div className="project-item-reading" role="region" aria-label="项目验收标准全文" tabIndex={0}>
            <ol>
              {item.acceptanceCriteria.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ol>
          </div>
        </div>
      </div>
      <div className="project-actions">
        <button
          type="button"
          className="primary"
          disabled={!writable}
          aria-describedby={`${identity}-item`}
          onClick={createRun}
        >
          从此交付项创建任务
        </button>
        <button
          type="button"
          className="secondary"
          aria-expanded={linking}
          disabled={!writable}
          onClick={() => setLinking(!linking)}
        >
          {linking ? '收起关联选择' : '关联已有执行'}
        </button>
      </div>
      {linking && (
        <ProjectRunList
          projectId={board.projectId}
          query={query}
          changeQuery={changeQuery}
          openRun={openRun}
          busy={busy}
          choose={(runId) =>
            void action(base + '/runs', { runId, makeCurrent: false }).then((ok) => {
              if (ok) setLinking(false);
            })
          }
        />
      )}
      <section className="project-current">
        <h3>当前交付候选</h3>
        {!current ? (
          <p>选择一次已关联执行作为当前候选，历史尝试会保留。</p>
        ) : (
          <>
            <strong className="project-current-title" id={`${identity}-current`}>
              {current.title}
            </strong>
            <dl className="project-status-grid">
              <div>
                <dt>执行</dt>
                <dd>{current.missing ? '源任务已删除' : executionLabel(current.status)}</dd>
              </div>
              <div>
                <dt>人工交付复核</dt>
                <dd>{current.reviewStatus ? reviewLabels[current.reviewStatus] : '未复核'}</dd>
              </div>
              <div>
                <dt>原意见复验</dt>
                <dd>
                  {current.sourceNotes.unavailable
                    ? '部分无法读取'
                    : `${current.sourceNotes.resolved}/${current.sourceNotes.total} 已解决`}
                  {current.sourceNotes.stale > 0 && `，${current.sourceNotes.stale} 条需重核`}
                </dd>
              </div>
              <div>
                <dt>符合项目标准</dt>
                <dd>
                  {item.confirmation && !item.confirmationStale
                    ? `已确认标准版本 ${item.confirmation.itemRevision}`
                    : '需明确确认'}
                </dd>
              </div>
            </dl>
            <details className="project-item-origin">
              <summary>候选完整标识与版本</summary>
              <dl>
                <div>
                  <dt>任务标识</dt>
                  <dd>{current.runId}</dd>
                </div>
                <div>
                  <dt>已读执行版本 / 根任务版本</dt>
                  <dd>
                    {current.runRevision ?? '未提供'} / {current.rootRevision ?? '未提供'}
                  </dd>
                </div>
                <div>
                  <dt>交付指纹</dt>
                  <dd>{current.fingerprint || '未提供'}</dd>
                </div>
                <div>
                  <dt>人工复核标识</dt>
                  <dd>{current.reviewId || '未提供'}</dd>
                </div>
              </dl>
            </details>
            {current.issue && (
              <p
                className="field-error project-read-error"
                role="alert"
                aria-label="当前候选读取问题"
                tabIndex={0}
              >
                {current.issue}
              </p>
            )}
            {item.confirmationStale && (
              <p className="field-error">
                项目标准或当前交付已变化，原确认仍保留，不能据此判定当前候选可交付。
              </p>
            )}
            {!current.missing && (
              <div className="project-actions">
                <button
                  type="button"
                  className="secondary"
                  aria-describedby={`${identity}-current`}
                  onClick={() => openRun(current.runId)}
                >
                  查看执行
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-describedby={`${identity}-current`}
                  onClick={() => openRun(current.runId, true)}
                >
                  检查交付与原意见复验
                </button>
              </div>
            )}
            {current.fingerprint && current.reviewId && current.reviewStatus === 'accepted' && (
              <div className="project-confirm">
                <label>
                  符合性确认说明
                  <textarea
                    aria-describedby={`${identity}-note-count`}
                    value={note}
                    maxLength={1000}
                    onChange={(e) => changeNote(e.target.value)}
                    placeholder="说明当前交付如何覆盖此处的项目标准（可选）"
                  />
                </label>
                <p className="field-help" id={`${identity}-note-count`}>
                  本机确认说明草稿 · {note.length} / 1000 字符，确认后保存至项目符合性记录
                </p>
                <p className="field-help">
                  请对照上方项目标准和任务原交付确认。此操作绑定当前交付指纹与项目标准版本，不会修改任务复核。
                </p>
                <button
                  type="button"
                  className="primary"
                  aria-describedby={`${identity}-current`}
                  disabled={!writable || !!current.issue || current.missing || !!current.executionHold}
                  onClick={() =>
                    void action(base + '/confirm', {
                      expectedItemRevision: item.itemRevision,
                      runId: current.runId,
                      expectedFingerprint: current.fingerprint,
                      expectedReviewId: current.reviewId,
                      note,
                    })
                  }
                >
                  确认当前候选符合此项目标准
                </button>
              </div>
            )}
            {item.confirmation?.note && (
              <details>
                <summary>已保存的符合性说明</summary>
                <p
                  className="project-prose project-item-reading"
                  role="region"
                  aria-label="已保存的符合性说明全文"
                  tabIndex={0}
                >
                  {item.confirmation.note}
                </p>
              </details>
            )}
          </>
        )}
      </section>
      <h3>关联执行 · {item.attemptCount} 次</h3>
      {loading && <p role="status">正在读取关联执行…</p>}
      {error && (
        <p className="field-error project-read-error" role="alert" aria-label="关联执行读取问题" tabIndex={0}>
          {error}
        </p>
      )}
      {attempts && !attempts.items.length && <p className="field-help">本页没有关联执行。</p>}
      {attempts?.items.map((attempt, index) => (
        <article className="project-run-row project-item-attempt" key={attempt.runId}>
          <div className="project-item-attempt-info">
            <strong id={`${identity}-attempt-${index}`}>{attempt.title}</strong>
            <p>
              {attempt.missing ? '源任务已删除' : executionLabel(attempt.status)} ·{' '}
              {attempt.reviewStatus ? reviewLabels[attempt.reviewStatus] : '未复核'}
              {attempt.current && ' · 当前候选'}
            </p>
            <details className="project-item-origin">
              <summary>本页尝试 {index + 1} · 完整标识与关联时间</summary>
              <dl>
                <div>
                  <dt>任务标识</dt>
                  <dd>{attempt.runId}</dd>
                </div>
                <div>
                  <dt>关联时间（原始记录）</dt>
                  <dd>{attempt.linkedAt}</dd>
                </div>
                <div>
                  <dt>已读执行版本 / 根任务版本</dt>
                  <dd>
                    {attempt.runRevision ?? '未提供'} / {attempt.rootRevision ?? '未提供'}
                  </dd>
                </div>
              </dl>
            </details>
            {attempt.issue && (
              <p
                className="field-error project-read-error"
                role="alert"
                aria-label={`本页尝试 ${index + 1} 读取问题全文`}
                tabIndex={0}
              >
                {attempt.issue}
              </p>
            )}
          </div>
          <div className="project-actions">
            {!attempt.missing && (
              <button
                type="button"
                className="secondary"
                aria-describedby={`${identity}-attempt-${index}`}
                onClick={() => openRun(attempt.runId)}
              >
                打开
              </button>
            )}
            <button
              type="button"
              className="secondary"
              aria-describedby={`${identity}-attempt-${index}`}
              disabled={!writable || attempt.current || attempt.missing || !!attempt.issue}
              onClick={() => void action(base + '/current', { runId: attempt.runId })}
            >
              设为当前候选
            </button>
          </div>
        </article>
      ))}
      <nav className="project-run-pagination" aria-label="关联执行翻页">
        {attempts && (
          <p className="field-help">
            第 {trail.length + 1} 页 · 本页 {attempts.items.length} 次 · 已读计划版本 {attempts.boardRevision}
          </p>
        )}
        <div className="project-actions">
          <button
            type="button"
            className="secondary"
            disabled={loading || !trail.length}
            onClick={() => {
              setBefore(trail.at(-1) || '');
              setTrail(trail.slice(0, -1));
            }}
          >
            上一页
          </button>
          <button
            type="button"
            className="secondary"
            disabled={loading || !attempts?.page.hasMore}
            onClick={() => {
              setTrail([...trail, before]);
              setBefore(attempts?.page.nextBefore || '');
            }}
          >
            下一页
          </button>
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => {
              setBefore('');
              setTrail([]);
              setRetry((n) => n + 1);
            }}
          >
            重读关联执行
          </button>
        </div>
      </nav>
    </section>
  );
}
