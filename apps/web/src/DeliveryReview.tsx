import { useEffect, useState } from 'react';
import type { DeliveryReview as Delivery, SourceArtifact } from '../../../packages/contracts/src/workflow';
import type { Artifact, Operation } from '../../../packages/contracts/src/index';
import { Modal } from './Modal';
import { RecordHistory } from './RecordHistory';
import { useSurfaceClient } from './SurfaceClientContext';
import { deferredPanel } from './DeferredPanel';
import { ToolActivity } from './ToolActivity';
import { DeliveryCriteria } from './DeliveryCriteria';
import { DeliveryUserReview } from './DeliveryUserReview';
import './workflow.css';
const FilePreview = deferredPanel(
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
}: {
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
  const [value, setValue] = useState<Delivery>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<SourceArtifact>();
  const [reading, setReading] = useState(true),
    [reviewBusy, setReviewBusy] = useState(false),
    [readVersion, setReadVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setReading(true);
    setPreview(undefined);
    void api<Delivery>(`/runs/${runId}/delivery`, undefined, undefined, controller.signal)
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
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
  }, [api, runId, retry]);
  const file = (item: SourceArtifact) => (
    <div className="workflow-file" key={item.id}>
      <button type="button" className="text-button" onClick={() => setPreview(item)}>
        {item.name} · v{item.version}
      </button>
      <span>
        {item.verified ? '结构证据已核验' : '尚未核验'} · SHA256 {item.hash.slice(0, 12)}
      </span>
      <a href={apiUrl('/artifacts/' + item.id)} download>
        下载
      </a>
    </div>
  );
  return (
    <Modal title="交付与验收" close={close} busy={reviewBusy} wide className="workflow-modal">
      <div className="form-body workflow-body">
        {error && (
          <p role="alert" className="field-error">
            {error}{' '}
            <button className="text-button" onClick={() => setRetry((v) => v + 1)}>
              重试
            </button>
          </p>
        )}
        {reading && value && <p role="status">正在重新读取，已读内容与备注保留…</p>}
        {!value ? (
          <p role="status">正在读取交付证据…</p>
        ) : (
          <>
            <p className="field-help">{value.limitation}</p>
            {value.summary && (
              <section aria-label="交付摘要">
                <h3>交付摘要</h3>
                <p className="workflow-prose">{value.summary}</p>
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
                setValue((old) => (old ? { ...old, ...state } : old));
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
                    <div className="workflow-evidence" key={index}>
                      <strong>
                        {{ artifact: '产物证据', file: '文件证据', command: '命令证据' }[evidence.type]}
                      </strong>
                      <p className="workflow-prose">{evidence.note || evidence.ref}</p>
                      <code>{evidence.ref}</code>
                      {evidence.hash && <small>SHA256 {evidence.hash}</small>}
                      {evidence.artifact && file(evidence.artifact)}
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
            <section aria-label="交付文件">
              <h3>交付文件</h3>
              {value.artifacts.map(file)}
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
                <div className="workflow-actions">
                  <strong>{preview.name}</strong>
                  <button className="text-button" onClick={() => setPreview(undefined)}>
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
          <p className="field-error" role="alert">
            {error}{' '}
            <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          </p>
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
