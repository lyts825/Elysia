/* 展示项目交付包及相关操作。 */
import { useEffect, useRef, useState } from 'react';
import type {
  ProjectDeliveryBundlePlan,
  ProjectDeliveryManifest,
  ProjectDeliveryBundleJob,
} from '../../../packages/contracts/src/project-delivery';
import { useSurfaceClient } from './SurfaceClientContext';
import { ApiError } from './api';
import { ProjectDeliveryArchive } from './ProjectDeliveryArchive';
import './project-delivery-bundle.css';

const sizeLabel = (bytes: number | null) =>
  bytes === null
    ? '大小未知'
    : bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KiB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/** Mount one instance per immutable manifest; leaving the selection cancels all work. */
export function ProjectDeliveryBundle({
  manifest,
  archived,
  archiveRevision,
  onSaved,
}: {
  manifest: ProjectDeliveryManifest;
  archived?: boolean;
  archiveRevision?: number;
  onSaved?: () => void;
}) {
  const { api, apiUrl } = useSurfaceClient();
  const [plan, setPlan] = useState<ProjectDeliveryBundlePlan>();
  const [working, setWorking] = useState<'check' | 'download' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState<ProjectDeliveryBundleJob>();
  const operation = useRef<{ controller: AbortController; jobId: string } | null>(null);
  const base = `/projects/${manifest.projectId}/delivery-manifests/${manifest.id}`;
  const [clientId] = useState(() => {
    const key = 'project-bundle-client:' + apiUrl(base);
    try {
      const saved = sessionStorage.getItem(key);
      if (saved && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(saved))
        return saved;
      const created = crypto.randomUUID();
      sessionStorage.setItem(key, created);
      return created;
    } catch {
      return crypto.randomUUID();
    }
  });
  const query = '?expectedManifestHash=' + encodeURIComponent(manifest.hash) + '&clientId=' + clientId;
  const discard = (jobId: string) =>
    api(base + '/bundle-jobs/' + jobId, { expectedManifestHash: manifest.hash, clientId }, 'DELETE').catch(
      () => {},
    );
  useEffect(
    () => () => {
      const current = operation.current;
      current?.controller.abort();
      operation.current = null;
      if (current) void discard(current.jobId);
    },
    [],
  );
  const current = (controller: AbortController) =>
    operation.current?.controller === controller && !controller.signal.aborted;
  const assertJob = (job: ProjectDeliveryBundleJob, jobId: string, kind: 'check' | 'download') => {
    if (
      job.id !== jobId ||
      job.clientId !== clientId ||
      job.projectId !== manifest.projectId ||
      job.manifestId !== manifest.id ||
      job.manifestHash !== manifest.hash ||
      job.kind !== kind
    )
      throw Error('返回的文件包作业不属于当前清单，请重新检查。');
  };
  const prepare = async (kind: 'check' | 'download', controller: AbortController, jobId: string) => {
    // Let creation finish so even a late POST result can be explicitly cancelled.
    let job = await api<ProjectDeliveryBundleJob>(
      base + '/bundle-jobs',
      {
        jobId,
        clientId,
        expectedManifestHash: manifest.hash,
        kind,
      },
      'POST',
      AbortSignal.timeout(15_000),
    );
    if (!current(controller)) {
      await discard(jobId);
      return;
    }
    assertJob(job, jobId, kind);
    for (;;) {
      if (!current(controller)) return;
      setProgress(job);
      if (job.stage === 'failed') throw Error(job.error?.message || '文件包处理失败，请重新检查。');
      if (job.stage === 'cancelled') throw Error('文件包作业已取消，请重新检查。');
      if (job.stage === 'completed' || job.stage === 'ready') return job;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 250);
        controller.signal.addEventListener('abort', done, { once: true });
      });
      if (!current(controller)) return;
      job = await api<ProjectDeliveryBundleJob>(
        base + '/bundle-jobs/' + jobId + query,
        undefined,
        undefined,
        controller.signal,
      );
      assertJob(job, jobId, kind);
    }
  };
  const receive = async (job: ProjectDeliveryBundleJob, controller: AbortController) => {
    let idle: ReturnType<typeof setTimeout>;
    const reading = new AbortController();
    const renew = () => {
      clearTimeout(idle);
      idle = setTimeout(() => reading.abort(), 15_000);
    };
    renew();
    try {
      const response = await fetch(apiUrl(base + '/bundle-jobs/' + job.id + '/file' + query), {
        credentials: 'same-origin',
        signal: AbortSignal.any([controller.signal, reading.signal]),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new ApiError(
          error?.message || `本机请求失败（HTTP ${response.status}），请重试。`,
          'http',
          response.status,
          error?.code,
        );
      }
      const length = Number(response.headers.get('Content-Length'));
      if (
        !Number.isSafeInteger(length) ||
        length < 4 ||
        length > 64 * 1024 * 1024 ||
        length !== job.bytesTotal ||
        !response.body
      )
        throw Error('交付包格式或大小异常，未发起下载，请重试检查。');
      const bytes = new Uint8Array(length),
        reader = response.body.getReader();
      let received = 0;
      controller.signal.throwIfAborted();
      if (current(controller)) setProgress({ ...job, stage: 'sending', bytesDone: 0 });
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        renew();
        if (received + chunk.value.length > length) {
          await reader.cancel();
          throw Error('交付包长度异常，请重新检查。');
        }
        bytes.set(chunk.value, received);
        received += chunk.value.length;
        if (current(controller)) setProgress({ ...job, stage: 'sending', bytesDone: received });
      }
      if (received !== length) throw Error('交付包发送中断，请重新检查后重试。');
      return bytes;
    } catch (issue) {
      if (reading.signal.aborted && !controller.signal.aborted)
        throw Error('文件包发送超过 15 秒未取得新数据，请重新检查后重试。');
      throw issue;
    } finally {
      clearTimeout(idle!);
    }
  };
  const check = async () => {
    if (operation.current) return;
    const controller = new AbortController();
    const jobId = crypto.randomUUID();
    operation.current = { controller, jobId };
    setWorking('check');
    setPlan(undefined);
    setError('');
    setNotice('');
    setProgress(undefined);
    try {
      const job = await prepare('check', controller, jobId);
      if (!job || !current(controller)) return;
      const result = job.plan;
      if (!result) throw Error('文件检查结果缺失，请重新检查。');
      if (
        result.projectId !== manifest.projectId ||
        result.manifestId !== manifest.id ||
        result.manifestHash !== manifest.hash
      )
        throw Error('返回的文件检查不属于当前清单，请重新读取清单。');
      setPlan(result);
      setNotice(
        result.canDownload ? '所选文件已通过检查，可以下载交付包。' : '部分条件未满足，请查看下方说明。',
      );
    } catch (issue) {
      if (current(controller)) setError(issue instanceof Error ? issue.message : '文件检查失败，请重试。');
    } finally {
      void discard(jobId);
      if (operation.current?.controller === controller) {
        operation.current = null;
        setWorking(null);
      }
    }
  };
  const download = async () => {
    if (!plan?.canDownload || operation.current) return;
    const controller = new AbortController();
    const jobId = crypto.randomUUID();
    operation.current = { controller, jobId };
    setWorking('download');
    setError('');
    setNotice('');
    setProgress(undefined);
    try {
      const job = await prepare('download', controller, jobId);
      if (!job || !current(controller)) return;
      const bytes = await receive(job, controller);
      if (!current(controller)) return;
      if (
        bytes.byteLength < 4 ||
        bytes.byteLength > Math.min(plan.maxBytes, 64 * 1024 * 1024) ||
        bytes[0] !== 0x50 ||
        bytes[1] !== 0x4b ||
        bytes[2] !== 3 ||
        bytes[3] !== 4
      )
        throw Error('交付包格式或大小异常，未发起下载，请重试检查。');
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `project-delivery-${manifest.id}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('交付包已生成并发起下载。保存后的 ZIP 可独立查看，请保留其中的清单和校验信息。');
    } catch (issue) {
      if (current(controller)) {
        setError(issue instanceof Error ? issue.message : '交付包下载失败，请重新检查文件。');
        setPlan(undefined);
      }
    } finally {
      void discard(jobId);
      if (operation.current?.controller === controller) {
        operation.current = null;
        setWorking(null);
      }
    }
  };
  const cancel = () => {
    const old = operation.current;
    old?.controller.abort();
    operation.current = null;
    if (old) void discard(old.jobId);
    setWorking(null);
    setPlan(undefined);
    setProgress(undefined);
    setNotice('本次请求已取消，未发起文件下载。可以重新检查后再试。');
    setError('');
  };
  return (
    <section className="project-delivery-bundle" aria-label="实际文件交付包">
      <h4>实际文件交付包</h4>
      <p className="field-help">
        将清单中已选择的文件正文、冻结清单和校验信息打包为 ZIP，最多 64 MiB。
        下载时重新核验冻结版本；文件缺失或已变化时不会替换为其他内容。临时下载不会自动保存到项目。
      </p>
      <div className="project-actions">
        <button type="button" className="secondary" disabled={!!working} onClick={() => void check()}>
          {working === 'check' ? '正在核验文件…' : plan ? '重新检查文件' : '检查交付文件'}
        </button>
        {plan && (
          <button
            type="button"
            className="primary"
            disabled={!!working || !plan.canDownload}
            onClick={() => void download()}
          >
            {working === 'download' ? '正在生成交付包…' : '下载文件交付包 ZIP'}
          </button>
        )}
        {working && (
          <button type="button" className="secondary" onClick={cancel}>
            取消本次请求
          </button>
        )}
      </div>
      <p role="status" aria-live="polite">
        {working === 'check'
          ? '正在读取并核验所选文件。'
          : working === 'download'
            ? '正在重新核验并打包，完成后发起下载。'
            : notice}
      </p>
      {working && progress && (
        <div className="project-bundle-progress" role="status" aria-live="polite">
          <strong>
            {progress.stage === 'verifying'
              ? '核验冻结文件'
              : progress.stage === 'preparing'
                ? '准备完整 ZIP'
                : progress.stage === 'sending'
                  ? '发送文件包'
                  : '文件包已就绪'}
          </strong>
          <progress
            max={progress.bytesTotal || undefined}
            value={progress.bytesTotal ? progress.bytesDone : undefined}
            aria-label="文件包进度"
          />
          <span>
            文件 {progress.filesDone} / {progress.filesTotal} · {sizeLabel(progress.bytesDone)}
            {progress.bytesTotal !== null ? ` / ${sizeLabel(progress.bytesTotal)}` : ' 已核验'}
          </span>
          {progress.currentFile && <small>当前文件：{progress.currentFile}</small>}
          <small>
            准备与发送完成后才发起本次 ZIP 下载，不会自动保存到项目。可取消；刷新后可重新检查并重试。
          </small>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {plan && (
        <div className="project-bundle-result">
          <dl className="project-bundle-summary" aria-label="文件检查摘要">
            <div>
              <dt>已选文件</dt>
              <dd>{plan.fileCount} 份</dd>
            </div>
            <div>
              <dt>已知文件正文</dt>
              <dd>{sizeLabel(plan.totalBytes)}</dd>
            </div>
            <div>
              <dt>交付包</dt>
              <dd>{sizeLabel(plan.archiveBytes)}</dd>
            </div>
          </dl>
          {plan.issues.length > 0 && (
            <ul className="field-error">
              {plan.issues.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
            </ul>
          )}
          <details open={plan.files.length <= 10}>
            <summary>查看文件与检查结果（{plan.files.length}）</summary>
            <ul className="project-bundle-files">
              {plan.files.map((file) => (
                <li
                  key={`${file.itemId}:${file.artifactId}`}
                  data-state={file.state === 'ready' ? 'ready' : 'blocked'}
                >
                  <strong>{file.name}</strong>
                  <div className="project-bundle-file-meta">
                    <span className="project-bundle-file-state">
                      {file.state === 'ready' ? '与冻结内容一致' : '无法打包'}
                    </span>
                    <span>{sizeLabel(file.size)}</span>
                  </div>
                  {file.state !== 'ready' && file.reason && (
                    <p className="project-bundle-file-reason">{file.reason}</p>
                  )}
                  <small className="project-bundle-file-path">
                    包内位置 <code>{file.path}</code>
                  </small>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
      <ProjectDeliveryArchive
        manifest={manifest}
        archived={archived}
        revision={archiveRevision}
        onSaved={onSaved}
      />
    </section>
  );
}
