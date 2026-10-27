/* 展示和处理交付评审。 */
import { useEffect, useId, useRef, useState } from 'react';
import type { DeliveryReview as Delivery, SourceArtifact } from '../../../packages/contracts/src/workflow';
import type { Artifact, Operation } from '../../../packages/contracts/src/index';
import { Modal } from './Modal';
import { RecordHistory } from './RecordHistory';
import { useSurfaceClient } from './SurfaceClientContext';
import { deferredPanel } from './DeferredPanel';
import { ToolActivity } from './ToolActivity';
import { DeliveryCriteria } from './DeliveryCriteria';
import { DeliveryUserReview } from './DeliveryUserReview';
import { ReviewHistory } from './ReviewHistory';
import { ArtifactRevisionProvider } from './ArtifactRevisionDraft';
import { SourceNoteResolutions } from './SourceNoteResolutions';
import { DeliveryReadProgress, prepareDeliveryRead, type DeliveryWarmProgress } from './DeliveryReadProgress';
import './workflow.css';
import './delivery-overview.css';
const FilePreview = deferredPanel(
  // 产物预览按需加载，不阻塞交付主体与复核意见显示。
  () => import('./ArtifactFilePreview').then((m) => m.ArtifactFilePreview),
  '产物预览',
);

export function DeliveryReview({
  runId,
  close,
  revise,
  openFile,
  reviewDraft,
  changeReviewDraft,
  readOnly = false,
  updated,
  handoffDraft,
  changeHandoffDraft,
  resolutionDraft,
  changeResolutionDraft,
}: {
  handoffDraft?: unknown;
  changeHandoffDraft?: (raw: string) => void;
  resolutionDraft?: unknown;
  changeResolutionDraft?: (raw: string) => void;
  runId: string;
  close: () => void;
  revise?: () => void;
  openFile?: (taskId: string, path: string) => void;
  reviewDraft?: unknown;
  changeReviewDraft?: (raw: string) => void;
  readOnly?: boolean;
  updated?: (runRevision: number) => void;
}) {
  const { api, apiUrl } = useSurfaceClient();
  const [snapshot, setValue] = useState<Delivery>();
  const value = snapshot?.runId === runId ? snapshot : undefined;
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<SourceArtifact>();
  const [reading, setReading] = useState(true),
    [reviewBusy, setReviewBusy] = useState(false),
    [readVersion, setReadVersion] = useState(0);
  const [progress, setProgress] = useState<DeliveryWarmProgress>();
  const readRequest = useRef<AbortController | null>(null);
  const previewOpener = useRef<HTMLButtonElement | null>(null);
  const pendingPreviewFocus = useRef<(() => void) | null>(null);
  useEffect(() => () => pendingPreviewFocus.current?.(), []);
  useEffect(() => {
    const controller = new AbortController();
    readRequest.current = controller;
    setError('');
    setReading(true);
    setProgress(undefined);
    setPreview(undefined);
    void prepareDeliveryRead(api, { kind: 'run', id: runId }, controller.signal, setProgress)
      .then(() => api<Delivery>(`/runs/${runId}/delivery`, undefined, undefined, controller.signal))
      .then((next) => {
        if (!controller.signal.aborted) {
          setValue(next);
          setReadVersion((version) => version + 1);
        }
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setError(issue instanceof Error ? issue.message : '交付核验读取失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setReading(false);
          setProgress(undefined);
        }
      });
    return () => controller.abort();
  }, [api, runId, retry]);
  const file = (item: SourceArtifact, embedded = false) => (
    <DeliveryFile
      key={item.id}
      item={item}
      embedded={embedded}
      href={apiUrl('/artifacts/' + item.id)}
      preview={() => {
        pendingPreviewFocus.current?.();
        previewOpener.current =
          document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
        setPreview(item);
      }}
    />
  );
  return (
    <ArtifactRevisionProvider
      runId={runId}
      raw={handoffDraft}
      change={changeHandoffDraft}
      disabled={readOnly || !revise}
    >
      <Modal title="交付与验收" close={close} busy={reviewBusy} wide className="workflow-modal">
        <div className="form-body workflow-body delivery-overview">
          {error && (
            <div role="alert" className="delivery-overview-error">
              <p className="field-error delivery-overview-reading" tabIndex={0} aria-label="交付读取失败详情">
                {error}
              </p>
              <button className="text-button" onClick={() => setRetry((v) => v + 1)}>
                重试
              </button>
            </div>
          )}
          {reading && value && <p role="status">正在重新读取，已读内容与备注保留…</p>}
          {reading && (
            <DeliveryReadProgress
              progress={progress}
              cancel={() => {
                readRequest.current?.abort();
                setReading(false);
                setProgress(undefined);
                setError('本次交付读取已取消。已读内容与备注保留，可重试读取。');
              }}
            />
          )}
          {!value && !reading && error && (
            <p className="field-help">当前交付暂不可读。已保存的复核历史仍可单独查看，未保存备注保持不变。</p>
          )}
          {value && (
            <>
              <p className="field-help delivery-overview-reading" tabIndex={0} aria-label="交付核验范围说明">
                {value.limitation}
              </p>
              {value.summary && (
                <section aria-label="交付摘要">
                  <h3>交付摘要</h3>
                  <p
                    className="workflow-prose delivery-overview-reading"
                    tabIndex={0}
                    aria-label="交付摘要全文"
                  >
                    {value.summary}
                  </p>
                </section>
              )}
              <DeliveryUserReview
                value={value}
                rawDraft={reviewDraft}
                changeDraft={changeReviewDraft || (() => {})}
                disabled={readOnly || !changeReviewDraft || value.status !== 'DONE' || !!error}
                reading={reading}
                readVersion={readVersion}
                activity={setReviewBusy}
                reload={() => setRetry((v) => v + 1)}
                saved={(state) => {
                  setValue((old) => (old?.runId === runId ? { ...old, ...state } : old));
                  updated?.(state.runRevision);
                }}
              >
                {(criterionNote) => (
                  <DeliveryCriteria
                    key={`${runId}:${value.runRevision}:${value.rootRevision}:${retry}`}
                    initial={value}
                    reload={() => setRetry((v) => v + 1)}
                    criterionNote={criterionNote}
                    evidence={(evidence, index) => (
                      <div className="workflow-evidence delivery-overview-evidence" key={index}>
                        <strong>
                          {{ artifact: '产物证据', file: '文件证据', command: '命令证据' }[evidence.type]} ·
                          本页第 {index + 1} 条
                        </strong>
                        <dl className="delivery-overview-fields">
                          <div>
                            <dt>证据说明</dt>
                            <dd>{evidence.note || '未附说明'}</dd>
                          </div>
                          <div>
                            <dt>完整引用</dt>
                            <dd>
                              <code>{evidence.ref}</code>
                            </dd>
                          </div>
                        </dl>
                        {evidence.hash && (
                          <details>
                            <summary>查看证据完整哈希</summary>
                            <code>{evidence.hash}</code>
                          </details>
                        )}
                        {evidence.artifact && file(evidence.artifact, true)}
                        {evidence.type === 'file' && openFile && (
                          <button
                            className="text-button"
                            onClick={() => openFile(value.rootTaskId, evidence.ref)}
                          >
                            打开当前工作区文件
                          </button>
                        )}
                        {evidence.type === 'command' && (
                          <CommandEvidence runId={runId} operationId={evidence.ref} />
                        )}
                      </div>
                    )}
                  />
                )}
              </DeliveryUserReview>
              <SourceNoteResolutions
                key={runId}
                delivery={value}
                raw={resolutionDraft}
                change={changeResolutionDraft}
                disabled={readOnly || reading || !!error || reviewBusy}
                reload={() => setRetry((v) => v + 1)}
                activity={setReviewBusy}
                updated={(revision) => {
                  setValue((old) => (old?.runId === runId ? { ...old, runRevision: revision } : old));
                  updated?.(revision);
                }}
              />
              <section aria-label="交付文件">
                <div className="delivery-overview-heading">
                  <h3>交付文件</h3>
                  <span className="field-help">
                    本页 {value.artifacts.length} 份
                    {value.artifactPage.total !== undefined && ` · 共 ${value.artifactPage.total} 份`}
                  </span>
                </div>
                {value.artifacts.map((item) => file(item))}
                {!value.artifacts.length && <p className="field-help">当前没有登记的交付文件。</p>}
                {value.artifactPage.hasMore && (
                  <RecordHistory
                    runId={runId}
                    kind="artifacts"
                    label="全部交付文件"
                    version={value.runRevision}
                    total={value.artifactPage.total}
                    render={(item: Artifact) => file(item)}
                  />
                )}
              </section>
              {preview && (
                <section className="workflow-preview" aria-label="所选产物预览">
                  <p className="delivery-overview-reading" tabIndex={0} aria-label="所选产物完整名称">
                    {preview.name}
                  </p>
                  <div className="workflow-actions">
                    <button
                      className="text-button"
                      onClick={(event) => {
                        pendingPreviewFocus.current?.();
                        const closer = event.currentTarget;
                        const ownsFocus = document.activeElement === closer;
                        setPreview(undefined);
                        const target = previewOpener.current;
                        if (!ownsFocus || !target) return;
                        let cancelled = false;
                        const cancel = () => {
                          cancelled = true;
                        };
                        const focusChanged = (event: FocusEvent) => {
                          if (event.target !== closer) cancel();
                        };
                        const cleanup = () => {
                          document.removeEventListener('focusin', focusChanged);
                          document.removeEventListener('pointerdown', cancel, true);
                          document.removeEventListener('keydown', cancel, true);
                          window.removeEventListener('blur', cancel);
                          if (pendingPreviewFocus.current === stop) pendingPreviewFocus.current = null;
                        };
                        const frame = requestAnimationFrame(() => {
                          cleanup();
                          const active = document.activeElement;
                          if (
                            cancelled ||
                            (active !== closer && active !== document.body) ||
                            !document.hasFocus() ||
                            !target.isConnected ||
                            target.matches(':disabled') ||
                            target.closest('[inert]') ||
                            !target.getClientRects().length
                          )
                            return;
                          target.focus({ preventScroll: true });
                          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                        });
                        const stop = () => {
                          cancel();
                          cancelAnimationFrame(frame);
                          cleanup();
                        };
                        pendingPreviewFocus.current = stop;
                        document.addEventListener('focusin', focusChanged);
                        document.addEventListener('pointerdown', cancel, true);
                        document.addEventListener('keydown', cancel, true);
                        window.addEventListener('blur', cancel);
                      }}
                    >
                      收起预览
                    </button>
                  </div>
                  <FilePreview
                    key={preview.id}
                    id={preview.id}
                    checkpointKey={runId}
                    resolveLogContext={false}
                  />
                </section>
              )}
            </>
          )}
          <ReviewHistory runId={runId} version={value?.runRevision ?? 0} />
        </div>
        <footer className="modal-footer">
          <button className="secondary" onClick={close} disabled={reviewBusy}>
            关闭
          </button>
          {revise && (
            <button className="primary" onClick={revise} disabled={reviewBusy}>
              提出修改
            </button>
          )}
        </footer>
      </Modal>
    </ArtifactRevisionProvider>
  );
}

function DeliveryFile({
  item,
  href,
  preview,
  embedded,
}: {
  item: SourceArtifact;
  href: string;
  preview: () => void;
  embedded: boolean;
}) {
  const nameId = useId();
  return (
    <div className="workflow-file delivery-overview-file" data-embedded={embedded || undefined}>
      <p id={nameId} className="delivery-file-name">
        {item.name.length > 96 ? `${item.name.slice(0, 96)}…` : item.name}
      </p>
      <p className="field-help">
        版本 {item.version} · {item.verified ? '结构证据已核验' : '尚未核验'}
      </p>
      <div className="workflow-actions">
        <button type="button" className="text-button" aria-describedby={nameId} onClick={preview}>
          预览文件
        </button>
        <a href={href} download aria-describedby={nameId}>
          下载文件
        </a>
      </div>
      <details>
        <summary>完整名称与核验信息</summary>
        <dl
          className={`delivery-overview-fields${embedded ? '' : ' delivery-overview-reading'}`}
          tabIndex={embedded ? undefined : 0}
          aria-label="交付文件完整名称与核验信息"
        >
          <div>
            <dt>完整名称</dt>
            <dd>{item.name}</dd>
          </div>
          <div>
            <dt>文件标识</dt>
            <dd>
              <code>{item.id}</code>
            </dd>
          </div>
          <div>
            <dt>格式</dt>
            <dd>{item.mediaType}</dd>
          </div>
          <div>
            <dt>SHA256</dt>
            <dd>
              <code>{item.hash}</code>
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

function CommandEvidence({ runId, operationId }: { runId: string; operationId: string }) {
  const { api } = useSurfaceClient();
  const [open, setOpen] = useState(false);
  const [operation, setOperation] = useState<Operation>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setOperation(undefined);
    setError('');
    void api<Operation>(
      `/runs/${runId}/records/operations/${encodeURIComponent(operationId)}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setOperation(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setError(issue instanceof Error ? issue.message : '命令证据读取失败。');
      });
    return () => controller.abort();
  }, [api, runId, operationId, open, retry]);
  return (
    <div className="workflow-command">
      <button className="text-button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? '收起命令记录' : '查看命令记录'}
      </button>
      {open &&
        (error ? (
          <div className="delivery-overview-error" role="alert">
            <p
              className="field-error delivery-overview-reading"
              tabIndex={0}
              aria-label="命令证据读取失败详情"
            >
              {error}
            </p>
            <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          </div>
        ) : operation ? (
          <ToolActivity
            call={{
              id: operation.toolCallId,
              name: operation.name,
              arguments: JSON.stringify(operation.args),
            }}
            operation={operation}
            focused
          />
        ) : (
          <p role="status">正在读取命令记录…</p>
        ))}
    </div>
  );
}
