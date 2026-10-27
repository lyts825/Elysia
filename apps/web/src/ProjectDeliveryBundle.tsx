/**
 * 展示项目交付包及相关操作。
 * 按冻结清单创建检查与下载作业，校验归属、长度及ZIP摘要，清理本客户端作业；文件保存仅在完整验证后触发。
 * EN: Displays project bundle generation and download actions. Creates check/download jobs for a frozen manifest, verifies ownership, length, and ZIP digest, and cleans up client-owned jobs; browser saving follows full validation.
 */
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

/**
 * 将可知大小转换为字节、KiB或MiB；null明确显示大小未知。
 * EN: Formats known sizes in bytes, KiB, or MiB, explicitly showing unknown size for null.
 */
const sizeLabel = (bytes: number | null) =>
  bytes === null
    ? '大小未知'
    : bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KiB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * 为不可变冻结清单检查文件或生成 ZIP。每窗口保存 clientId，所有作业响应同时核对作业、
 * 客户端、项目、清单及哈希；切换清单卸载后取消本地读取并尽力删除服务端作业。
 * 文件检查和下载分别创建作业，不能用较早检查通过代替下载时的重新核验。
 * EN: Check/build ZIP from an immutable manifest. Retain window clientId and validate job/client/project/manifest/hash on responses. Abort local reads and best-effort delete jobs on change/unmount. Checks and downloads create separate jobs; download revalidates rather than trusting an earlier check.
 */
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
  /**
   * 打包计划、任务进度和下载状态绑定当前不可变清单。
   * EN: Bind plan, progress, and download state to the immutable current manifest.
   */
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
  /**
   * 尽力删除当前客户端持有的指定打包作业；清理失败被容错，不覆盖当前界面操作结果。
   * EN: Best-effort deletes the specified bundle job owned by this client; cleanup failures do not replace the current UI outcome.
   */
  const discard = (jobId: string) =>
    api(base + '/bundle-jobs/' + jobId, { expectedManifestHash: manifest.hash, clientId }, 'DELETE').catch(
      () => {},
    );
  /**
   * 打包面板卸载时中断当前控制器、解除操作引用并尽力删除本客户端作业，防止下载在离开后继续触发。
   * EN: On bundle-panel teardown, aborts the active controller, clears the operation reference, and best-effort deletes the client-owned job so download does not continue after departure.
   */
  useEffect(
    () => () => {
      const current = operation.current;
      current?.controller.abort();
      operation.current = null;
      if (current) void discard(current.jobId);
    },
    [],
  );
  /**
   * 检查控制器仍属于当前操作且未取消，阻止旧检查或下载结果回写。
   * EN: Checks that a controller still belongs to the active operation and is not aborted, preventing obsolete check or download updates.
   */
  const current = (controller: AbortController) =>
    operation.current?.controller === controller && !controller.signal.aborted;
  /**
   * 逐项校验作业ID、客户端、项目、清单哈希及作业类型；任何不匹配都抛错以阻断错误文件下载。
   * EN: Validates job ID, client, project, manifest hash, and operation kind, throwing on any mismatch to prevent downloading the wrong bundle.
   */
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
  /**
   * 创建后轮询同一作业；即使 POST 迟到，也等待取得作业身份后明确取消，避免遗留后台工作。
   * EN: Poll the same created job; wait for late POST identity before cancellation to avoid abandoned server work.
   */
  const prepare = async (kind: 'check' | 'download', controller: AbortController, jobId: string) => {
    /**
     * 等待创建结束，迟到的 POST 也能明确取消。
     * EN: Let creation finish so even a late POST result can be explicitly cancelled.
     */
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
        /**
         * 收束轮询间隔并移除取消监听，使计时器完成或取消都能尽快继续检查操作有效性。
         * EN: Settles the polling delay and removes its abort listener so timeout or cancellation promptly returns to operation-validity checks.
         */
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
  /**
   * 按声明长度有界接收文件，每收到新块重置 15 秒空闲期限，超长或中断均不产生下载。
   * EN: Receive within declared length; reset a 15-second idle timeout per chunk. Oversize/interrupted transfers produce no download.
   */
  const receive = async (job: ProjectDeliveryBundleJob, controller: AbortController) => {
    let idle: ReturnType<typeof setTimeout>;
    const reading = new AbortController();
    /**
     * 每次读取进度后重置15秒无进展超时；超时中止独立读取控制器，避免下载无限悬挂。
     * EN: Resets a 15-second idle timeout after read progress; expiry aborts the dedicated reader so a stalled download cannot hang indefinitely.
     */
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
  /**
   * 创建并轮询独立检查作业，清空旧计划并校验返回身份；只有有效当前请求才能发布可下载方案或错误。
   * EN: Creates and polls an isolated check job, clearing the old plan and validating identity; only the current live request publishes a download plan or failure.
   */
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
  /**
   * 仅对通过检查的计划创建下载作业；轮询完成后读取并核验ZIP内容，取消或失败时清理作业并保留可重试状态。
   * EN: Creates a download job only for an approved plan, then polls, reads, and verifies ZIP bytes. Cancellation or failure cleans up the job and leaves a retryable state.
   */
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
  /**
   * 中断当前浏览器请求并尽力删除对应作业，清空旧计划与进度，使用户重新检查后再下载。
   * EN: Aborts the active browser request, best-effort deletes its job, and clears the previous plan and progress so the user can check again before downloading.
   */
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
