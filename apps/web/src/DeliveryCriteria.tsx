/**
 * 展示和处理交付验收标准。
 * 逐页展示验收项及其证据，把所有读取绑定到运行与根修订基线；版本变化保留已读内容并请求重新核对。
 * EN: Displays delivery acceptance criteria and their evidence. Paginates criteria and evidence against a shared run/root-revision baseline, retaining loaded content and requesting review when revisions change.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  DeliveryCriterion,
  DeliveryEvidence,
  DeliveryEvidencePage,
  DeliveryReview,
} from '../../../packages/contracts/src/workflow';
import { ApiError } from './api';
import { useSurfaceClient } from './SurfaceClientContext';
import './delivery-criteria.css';

type Snapshot = Pick<DeliveryReview, 'runId' | 'runRevision' | 'rootRevision'>;
/**
 * 比较运行ID、运行修订和根修订；分页必须与首屏基线完全一致才能合入。
 * EN: Compares run ID, run revision, and root revision; a page must match the initial baseline before it can be applied.
 */
const matches = (expected: Snapshot, actual: Snapshot) =>
  expected.runId === actual.runId &&
  expected.runRevision === actual.runRevision &&
  expected.rootRevision === actual.rootRevision;
const changed = '交付记录已变化。已读内容保留，请重新读取后继续核对。';

/**
 * 单实例串行分页读取器：取消卸载请求，并在运行/根修订不匹配时通知父面板建立新基线。
 * EN: Use a serial page reader per instance, cancel unmounted reads, and ask the parent for a new baseline when run or root revision mismatches.
 */
function usePageRead(snapshot: Snapshot, stale: () => void) {
  /**
   * 分页读取与首屏绑定同一运行和根版本；不一致时保留已读页并提示刷新。
   * EN: Bind pagination to the same run and root revision as the first page; on mismatch retain loaded pages and request a refresh.
   */
  const { api } = useSurfaceClient();
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /**
   * 读取器卸载时取消当前分页请求；空依赖让此清理只对应本实例生命周期。
   * EN: Aborts the current page request when this reader unmounts; empty dependencies bind cleanup to the instance lifecycle.
   */
  useEffect(() => () => request.current?.abort(), []);
  /**
   * 串行读取一个分页地址，使用AbortController取消并核对快照；版本变化交由stale处理，失败保留已读内容并显示错误。
   * EN: Reads one page serially with cancellation and snapshot checks. Revision changes invoke stale; failures retain loaded content and expose an error.
   */
  async function read<T extends Snapshot>(path: string, apply: (value: T) => void) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const next = await api<T>(path, undefined, undefined, controller.signal);
      if (controller.signal.aborted) return;
      if (!matches(snapshot, next)) {
        stale();
        return;
      }
      apply(next);
    } catch (issue) {
      if (controller.signal.aborted) return;
      if (issue instanceof ApiError && issue.status === 409) stale();
      else setError(issue instanceof Error ? issue.message : '读取失败，已读内容已保留。');
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return { read, busy, error };
}

/**
 * 以首屏交付为固定快照分页标准；旧页在错误时保留，但 stale 会禁止继续使用旧版本翻页。
 * EN: Page criteria against the fixed initial delivery snapshot. Retain old pages after read errors, but stale prevents further paging against that obsolete version.
 */
export function DeliveryCriteria({
  initial,
  evidence,
  reload,
  criterionNote,
}: {
  initial: DeliveryReview;
  evidence: (item: DeliveryEvidence, index: number) => ReactNode;
  reload: () => void;
  criterionNote?: (criterion: DeliveryCriterion) => ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const [stale, setStale] = useState(false);
  const reader = usePageRead(initial, () => setStale(true));
  const page = value.criteriaPage;
  /**
   * 按验收项偏移读取同一根修订的交付页，成功后替换当前页；并发与错误由共用读取器管理。
   * EN: Loads a delivery criteria page at the supplied offset against the same root revision; the shared reader handles concurrency and errors before replacing the page.
   */
  const load = (offset: number) =>
    reader.read<DeliveryReview>(
      `/runs/${initial.runId}/delivery?criteriaOffset=${offset}&expectedRootRevision=${initial.rootRevision}`,
      setValue,
    );
  return (
    <section className="delivery-criteria" aria-label="逐项验收">
      <header className="delivery-criteria-heading">
        <h3>逐项验收</h3>
        <span className="field-help">
          本页 {value.criteria.length} 项 · 共 {page.total} 项
        </span>
      </header>
      {stale && (
        <div className="workflow-read-error" role="alert">
          <p>{changed}</p>
          <button className="text-button" onClick={reload}>
            重新读取交付
          </button>
        </div>
      )}
      {value.criteria.map((criterion) => (
        <CriterionEvidence
          key={`${page.offset}:${criterion.index}`}
          criterion={criterion}
          snapshot={initial}
          evidence={evidence}
          disabled={stale || reader.busy}
          stale={() => setStale(true)}
          note={criterionNote?.(criterion)}
        />
      ))}
      <div className="workflow-pagination" aria-label="验收项分页">
        <span className="workflow-pagination-summary" role="status">
          {page.total
            ? `验收项 ${page.offset + 1}–${page.offset + value.criteria.length} / ${page.total}`
            : '没有登记的验收项'}
        </span>
        <div className="workflow-pagination-actions">
          {page.offset > 0 && (
            <button
              className="secondary"
              disabled={stale || reader.busy}
              onClick={() => void load(Math.max(0, page.offset - page.limit))}
            >
              上一页验收项
            </button>
          )}
          {page.hasMore && (
            <button
              className="secondary"
              disabled={stale || reader.busy}
              onClick={() => void load(page.nextOffset!)}
            >
              {reader.busy ? '正在读取…' : '下一页验收项'}
            </button>
          )}
        </div>
      </div>
      {reader.error && (
        <p
          className="workflow-read-error delivery-criteria-reading"
          role="alert"
          aria-label="验收项读取错误全文"
          tabIndex={0}
        >
          {reader.error} 请重试翻页，已读内容已保留。
        </p>
      )}
    </section>
  );
}

/**
 * 单项证据独立分页，读取结果除快照修订外还必须匹配当前 criterion 索引。
 * EN: Page evidence independently per criterion. Beyond snapshot revision, a response must match the current criterion index.
 */
function CriterionEvidence({
  criterion,
  snapshot,
  evidence,
  disabled,
  stale,
  note,
}: {
  criterion: DeliveryCriterion;
  snapshot: Snapshot;
  evidence: (item: DeliveryEvidence, index: number) => ReactNode;
  disabled: boolean;
  stale: () => void;
  note?: ReactNode;
}) {
  const [value, setValue] = useState({ evidence: criterion.evidence, page: criterion.evidencePage });
  const [expanded, setExpanded] = useState(false);
  const reader = usePageRead(snapshot, stale);
  const page = value.page;
  /**
   * 分页读取指定验收项证据并校验返回的验收项身份；匹配后展开证据，身份变化则要求重读。
   * EN: Loads evidence for the specified criterion and checks its returned identity; matching evidence expands the section, while a mismatch requests a refresh.
   */
  const load = (offset: number) =>
    reader.read<DeliveryEvidencePage>(
      `/runs/${snapshot.runId}/delivery/criteria/${criterion.index}/evidence?offset=${offset}&expectedRootRevision=${snapshot.rootRevision}`,
      (next) => {
        if (next.criterion !== criterion.index) {
          stale();
          return;
        }
        setValue(next);
        setExpanded(true);
      },
    );
  return (
    <article
      className="workflow-criterion delivery-criterion"
      aria-label={`第 ${criterion.index + 1} 项验收`}
    >
      <h4>第 {criterion.index + 1} 项验收标准</h4>
      <p
        className="workflow-prose delivery-criteria-reading"
        role="region"
        aria-label={`第 ${criterion.index + 1} 项验收标准全文`}
        tabIndex={0}
      >
        {criterion.text}
      </p>
      {criterion.evidenceTotal === 0 ? (
        <p className="field-help">此项尚无关联证据，请结合产物复核。</p>
      ) : (
        <p className="field-help" role="status">
          {value.evidence.length
            ? `证据 ${page.offset + 1}–${page.offset + value.evidence.length} / ${criterion.evidenceTotal}`
            : `已登记 ${criterion.evidenceTotal} 条证据，尚未载入。`}
          {!expanded && page.hasMore && ` · 还有 ${criterion.evidenceTotal - value.evidence.length} 条未展示`}
        </p>
      )}
      {!!value.evidence.length && (
        <div
          className="delivery-criterion-evidence"
          role="region"
          aria-label={`第 ${criterion.index + 1} 项已读证据全文`}
          tabIndex={0}
        >
          {value.evidence.map(evidence)}
        </div>
      )}
      <div className="workflow-actions" aria-label={`第 ${criterion.index + 1} 项证据分页`}>
        {expanded && page.offset > 0 && (
          <button
            className="secondary"
            disabled={disabled || reader.busy}
            onClick={() => void load(Math.max(0, page.offset - page.limit))}
          >
            上一页证据
          </button>
        )}
        {(page.hasMore || (criterion.evidenceTotal > 0 && !value.evidence.length)) && (
          <button
            className="secondary"
            disabled={disabled || reader.busy}
            onClick={() => void load(expanded ? (page.nextOffset ?? 0) : 0)}
          >
            {reader.busy ? '正在读取…' : expanded ? '下一页证据' : '读取更多证据'}
          </button>
        )}
      </div>
      {reader.error && (
        <p
          className="workflow-read-error delivery-criteria-reading"
          role="alert"
          aria-label={`第 ${criterion.index + 1} 项证据读取错误全文`}
          tabIndex={0}
        >
          {reader.error} 请重试读取，已读内容已保留。
        </p>
      )}
      {note}
    </article>
  );
}
