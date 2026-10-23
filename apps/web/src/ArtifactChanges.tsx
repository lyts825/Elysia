import { useEffect, useRef, useState } from 'react';
import type {
  DeliveryArtifactChangePage,
  DeliveryArtifactMetadata,
} from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import { DeliveryChanges } from './DeliveryChanges';
import { ArtifactRevisionEditor } from './ArtifactRevisionDraft';
import { deferredPanel } from './DeferredPanel';
import { DeliveryReadProgress, prepareDeliveryRead, type DeliveryWarmProgress } from './DeliveryReadProgress';
import './artifact-changes.css';

const FilePreview = deferredPanel(
  () => import('./ArtifactFilePreview').then((m) => m.ArtifactFilePreview),
  '产物预览',
);
type Props = {
  runId: string;
  reviewId: string;
  fingerprint: string | null;
  reload: () => void;
  reading?: boolean;
};
export function ArtifactChanges(props: Props) {
  return <ArtifactChangePages key={`${props.runId}:${props.reviewId}:${props.fingerprint}`} {...props} />;
}
function Metadata({ label, value }: { label: string; value: DeliveryArtifactMetadata | null }) {
  return (
    <section className="artifact-version" aria-label={`${label}产物元数据`}>
      <h5>{label}</h5>
      {value ? (
        <>
          <p
            className="workflow-prose artifact-change-reading"
            role="region"
            aria-label={`${label}产物完整名称`}
            tabIndex={0}
          >
            {value.name}
          </p>
          <dl className="artifact-version-facts">
            <div>
              <dt>版本</dt>
              <dd>v{value.version}</dd>
            </div>
            <div>
              <dt>格式</dt>
              <dd>{value.mediaType}</dd>
            </div>
            <div>
              <dt>结构证据</dt>
              <dd>{value.verified ? '结构证据已核验' : '未核验'}</dd>
            </div>
            <div>
              <dt>摘要</dt>
              <dd>
                <code>{value.hash.slice(0, 12)}</code>
              </dd>
            </div>
          </dl>
          <details>
            <summary>完整产物标识</summary>
            <div
              className="artifact-change-reading artifact-identifiers"
              role="region"
              aria-label={`${label}完整产物标识`}
              tabIndex={0}
            >
              产物 {value.id}
              <br />
              任务 {value.taskId}
              <br />
              SHA256 {value.hash}
            </div>
          </details>
        </>
      ) : (
        <p className="field-help">无此产物</p>
      )}
    </section>
  );
}
function ArtifactChangePages({ runId, reviewId, fingerprint, reload, reading = false }: Props) {
  const { api } = useSurfaceClient();
  const [open, setOpen] = useState(false),
    [offset, setOffset] = useState(0),
    [retry, setRetry] = useState(0);
  const [value, setValue] = useState<DeliveryArtifactChangePage>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(false);
  const [preview, setPreview] = useState<string>();
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const [progress, setProgress] = useState<DeliveryWarmProgress>();
  const readRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open || !fingerprint || reading) {
      setLoading(false);
      setProgress(undefined);
      return;
    }
    const controller = new AbortController();
    readRequest.current = controller;
    setLoading(true);
    setProgress(undefined);
    setError('');
    setPreview(undefined);
    const query = new URLSearchParams({ expectedCurrentFingerprint: fingerprint, offset: String(offset) });
    void prepareDeliveryRead(api, { kind: 'run', id: runId }, controller.signal, setProgress)
      .then(() =>
        api<DeliveryArtifactChangePage>(
          `/runs/${runId}/delivery/reviews/${reviewId}/artifact-changes?${query}`,
          undefined,
          undefined,
          controller.signal,
        ),
      )
      .then((next) => {
        if (controller.signal.aborted) return;
        if (
          next.runId !== runId ||
          next.reviewId !== reviewId ||
          next.currentFingerprint !== fingerprint ||
          (next.page && (next.page.offset !== offset || next.page.limit !== 20)) ||
          next.items.length > 20
        )
          throw new ApiError('比较记录已变化，请重新读取复核后查看。', 'http', 409, 'DELIVERY_CHANGED');
        setValue(next);
        setConflict(false);
      })
      .catch((issue) => {
        if (controller.signal.aborted) return;
        setError(issue instanceof Error ? issue.message : '产物变化读取失败。');
        if (issue instanceof ApiError && (issue.status === 409 || issue.code === 'DELIVERY_UNREADABLE'))
          setConflict(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setProgress(undefined);
        }
      });
    return () => controller.abort();
  }, [api, runId, reviewId, fingerprint, offset, retry, open, reading]);
  const blocked = loading || reading || conflict;
  return (
    <details
      className="workflow-source artifact-changes"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>产物变化明细</summary>
      {open && (
        <>
          <p className="field-help">
            比较复核时与本次读取时的产物元数据。当前预览可能已更新，不代表旧版本正文仍可读取。
          </p>
          {!fingerprint && (
            <p className="field-help">当前交付不可读，暂时无法列出产物变化。原复核内容仍保留。</p>
          )}
          {reading && <p role="status">正在重新读取复核…</p>}
          {loading && (
            <DeliveryReadProgress
              label="产物变化"
              progress={progress}
              cancel={() => {
                readRequest.current?.abort();
                setLoading(false);
                setProgress(undefined);
                setError('本次产物变化读取已取消，已读页面保留。可重试这一页。');
              }}
            />
          )}
          {error && (
            <div className="workflow-read-error" role="alert">
              <p
                className="artifact-change-reading"
                role="region"
                aria-label="产物变化读取问题全文"
                tabIndex={0}
              >
                {error}
              </p>
              {value && <p>已读页面保留，尚未合并新的结果。</p>}
              <button
                type="button"
                className="text-button"
                disabled={loading || reading}
                onClick={conflict ? reload : () => setRetry((n) => n + 1)}
              >
                {conflict ? '重新读取复核与交付' : '重试读取这一页'}
              </button>
            </div>
          )}
          {value && !value.page && <DeliveryChanges value={value.changeSummary} />}
          {value?.page && (
            <>
              <p role="status">
                {conflict ? '先前已读' : '已读取'} {value.items.length ? value.page.offset + 1 : 0}–
                {value.items.length ? value.page.offset + value.items.length : 0} / 共 {value.page.total}{' '}
                项产物变化
              </p>
              {!value.page.total && <p className="field-help">这份复核之后没有产物元数据变化。</p>}
              {value.items.map((item) => (
                <section className="workflow-artifact-change" key={item.artifactId}>
                  <h4>{{ added: '新增产物', removed: '移除产物', changed: '产物已变化' }[item.kind]}</h4>
                  <p
                    className="artifact-change-reading artifact-change-name"
                    role="region"
                    aria-label="变化产物完整名称"
                    tabIndex={0}
                  >
                    {item.after?.name ?? item.before?.name ?? item.artifactId}
                  </p>
                  <div className="artifact-change-versions">
                    <Metadata label="复核时" value={item.before} />
                    <Metadata label="本次读取时" value={item.after} />
                  </div>
                  {item.currentArtifactId ? (
                    <button
                      type="button"
                      className="text-button"
                      disabled={blocked}
                      aria-expanded={preview === item.currentArtifactId}
                      onClick={(event) => {
                        previewTrigger.current = event.currentTarget;
                        setPreview(item.currentArtifactId!);
                      }}
                    >
                      预览当前产物
                    </button>
                  ) : (
                    <p className="field-help">此产物已从当前交付移除；仅保留历史元数据，不提供旧文件正文。</p>
                  )}
                  {fingerprint && (
                    <ArtifactRevisionEditor
                      runId={runId}
                      reviewId={reviewId}
                      fingerprint={fingerprint}
                      item={item}
                      disabled={blocked}
                    />
                  )}
                  {preview && preview === item.currentArtifactId && !conflict && (
                    <section className="workflow-preview" aria-label="变化产物当前预览">
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          setPreview(undefined);
                          previewTrigger.current?.focus();
                        }}
                      >
                        收起当前预览
                      </button>
                      <FilePreview
                        key={preview}
                        id={preview}
                        checkpointKey={runId}
                        resolveLogContext={false}
                      />
                    </section>
                  )}
                </section>
              ))}
              <nav className="workflow-pagination" aria-label="产物变化翻页">
                <span className="workflow-pagination-summary">
                  第 {Math.floor(value.page.offset / 20) + 1} 页 · 本页 {value.items.length} 项
                </span>
                <div className="workflow-pagination-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={blocked || !value.page.offset}
                    onClick={() => setOffset(Math.max(0, value.page!.offset - 20))}
                  >
                    上一页产物变化
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={blocked || !value.page.hasMore}
                    onClick={() => setOffset(value.page!.nextOffset!)}
                  >
                    下一页产物变化
                  </button>
                </div>
              </nav>
            </>
          )}
        </>
      )}
    </details>
  );
}
