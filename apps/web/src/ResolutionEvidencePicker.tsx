/* 选择用于处理问题的交付证据。 */
import { useEffect, useId, useState } from 'react';
import type {
  DeliveryEvidence,
  DeliveryEvidencePage,
  DeliveryReview,
} from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import './resolution-evidence.css';
export type ChosenEvidence = DeliveryEvidence & { index: number };
/**
 * 分页手选当前验收项的登记证据，索引按整个证据集合编号，跨页最多选择 10 条。
 * 每页必须与 delivery 的运行/根修订匹配，最终保存仍由服务端重新核验并冻结引用。
 */
export function ResolutionEvidencePicker({
  delivery,
  criterion,
  selected,
  change,
  disabled,
}: {
  delivery: DeliveryReview;
  criterion: number;
  selected: ChosenEvidence[];
  change: (items: ChosenEvidence[]) => void;
  disabled: boolean;
}) {
  const { api } = useSurfaceClient();
  const id = useId();
  const [page, setPage] = useState<DeliveryEvidencePage>(),
    [offset, setOffset] = useState(0),
    [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    // 根据当前交付和标准分页读取证据，依赖变化时取消旧请求。
    const controller = new AbortController();
    setBusy(true);
    setError('');
    void api<DeliveryEvidencePage>(
      `/runs/${delivery.runId}/delivery/criteria/${criterion}/evidence?offset=${offset}&expectedRootRevision=${delivery.rootRevision}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        if (
          next.runId !== delivery.runId ||
          next.rootRevision !== delivery.rootRevision ||
          next.runRevision !== delivery.runRevision ||
          next.criterion !== criterion ||
          next.page.offset !== offset
        )
          throw Error('证据版本已变化，请重新读取交付后再选；原草稿保持不变。');
        setPage(next);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '证据读取失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [api, delivery.runId, delivery.rootRevision, delivery.runRevision, criterion, offset, retry]);
  return (
    <fieldset className="resolution-evidence" disabled={disabled || busy}>
      <legend>手动选择已登记证据（最多 10 条）</legend>
      <p className="field-help" id={id + '-count'}>
        已手选 {selected.length} / 10 条；保存时核对并冻结证据引用。
      </p>
      {!!page?.evidence.length && (
        <div className="resolution-evidence-list" role="region" aria-label="本页登记证据" tabIndex={0}>
          {page.evidence.map((item, i) => {
            // 页内位置加 offset 才是提交所需证据索引，避免翻页后将第一个条目误当成同一证据。
            const index = page.page.offset + i,
              checked = selected.some((e) => e.index === index);
            return (
              <section className="resolution-evidence-item" key={index}>
                <h5>
                  证据 {index + 1} ·{' '}
                  {{ file: '文件证据', artifact: '产物证据', command: '命令证据' }[item.type]}
                </h5>
                <label className="workflow-note-choice">
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={`选择第 ${index + 1} 条登记证据`}
                    aria-describedby={id + '-count'}
                    disabled={!!error || (!checked && selected.length >= 10)}
                    onChange={() =>
                      change(
                        checked
                          ? selected.filter((e) => e.index !== index)
                          : [...selected, { ...item, index }],
                      )
                    }
                  />
                  <span>用于本次复验</span>
                </label>
                <p className="field-help">证据说明</p>
                <p
                  className="workflow-prose resolution-evidence-reading"
                  role="region"
                  aria-label={`证据 ${index + 1} 完整说明`}
                  tabIndex={0}
                >
                  {item.note || '未附说明'}
                </p>
                <p className="field-help">登记引用</p>
                <p
                  className="resolution-evidence-reading resolution-evidence-ref"
                  role="region"
                  aria-label={`证据 ${index + 1} 完整引用`}
                  tabIndex={0}
                >
                  {item.ref}
                </p>
                {(item.hash || item.artifact) && (
                  <details>
                    <summary>完整核对信息</summary>
                    <dl
                      className="resolution-evidence-reading"
                      role="region"
                      aria-label={`证据 ${index + 1} 完整核对信息`}
                      tabIndex={0}
                    >
                      {item.hash && (
                        <div>
                          <dt>SHA256</dt>
                          <dd>{item.hash}</dd>
                        </div>
                      )}
                      {item.artifact && (
                        <>
                          <div>
                            <dt>产物名称</dt>
                            <dd>{item.artifact.name}</dd>
                          </div>
                          <div>
                            <dt>版本与格式</dt>
                            <dd>
                              v{item.artifact.version} · {item.artifact.mediaType}
                            </dd>
                          </div>
                          <div>
                            <dt>产物标识</dt>
                            <dd>{item.artifact.id}</dd>
                          </div>
                          <div>
                            <dt>产物 SHA256</dt>
                            <dd>{item.artifact.hash}</dd>
                          </div>
                          <div>
                            <dt>核验状态</dt>
                            <dd>{item.artifact.verified ? '已核验' : '未核验'}</dd>
                          </div>
                        </>
                      )}
                    </dl>
                  </details>
                )}
              </section>
            );
          })}
        </div>
      )}
      {page && !page.page.total && (
        <p className="field-help">当前验收项尚无登记证据；可保留待复验或说明判断依据。</p>
      )}
      {page && (
        <nav className="workflow-pagination" aria-label="登记证据分页">
          <span className="workflow-pagination-summary">
            {page.evidence.length
              ? `${page.page.offset + 1}–${page.page.offset + page.evidence.length}`
              : '0'}{' '}
            / {page.page.total} 条证据
          </span>
          <div className="workflow-pagination-actions">
            <button
              type="button"
              className="secondary"
              disabled={!page.page.offset || !!error}
              onClick={() => setOffset(Math.max(0, page.page.offset - page.page.limit))}
            >
              上一页证据
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!page.page.hasMore || !!error}
              onClick={() => setOffset(page.page.nextOffset!)}
            >
              下一页证据
            </button>
          </div>
        </nav>
      )}
      {busy && <p role="status">正在读取证据…</p>}
      {error && (
        <div role="alert" className="workflow-read-error">
          <p
            className="resolution-evidence-reading"
            role="region"
            aria-label="登记证据读取问题全文"
            tabIndex={0}
          >
            {error}
          </p>
          <button type="button" className="secondary" onClick={() => setRetry((n) => n + 1)}>
            重试证据
          </button>
        </div>
      )}
    </fieldset>
  );
}
