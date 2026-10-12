import { useEffect, useRef, useState } from 'react';
import type {
  ProjectDeliveryBundlePlan,
  ProjectDeliveryManifest,
} from '../../../packages/contracts/src/project-delivery';
import { useSurfaceClient } from './SurfaceClientContext';
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
export function ProjectDeliveryBundle({ manifest }: { manifest: ProjectDeliveryManifest }) {
  const { api, apiBytes } = useSurfaceClient();
  const [plan, setPlan] = useState<ProjectDeliveryBundlePlan>();
  const [working, setWorking] = useState<'check' | 'download' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const operation = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      operation.current?.abort();
      operation.current = null;
    },
    [],
  );
  const base = `/projects/${manifest.projectId}/delivery-manifests/${manifest.id}`;
  const query = '?expectedManifestHash=' + encodeURIComponent(manifest.hash);
  const check = async () => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setWorking('check');
    setPlan(undefined);
    setError('');
    setNotice('');
    try {
      const result = await api<ProjectDeliveryBundlePlan>(
        base + '/bundle-plan' + query,
        undefined,
        undefined,
        controller.signal,
      );
      if (operation.current !== controller || controller.signal.aborted) return;
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
      if (operation.current === controller && !controller.signal.aborted)
        setError(issue instanceof Error ? issue.message : '文件检查失败，请重试。');
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setWorking(null);
      }
    }
  };
  const download = async () => {
    if (!plan?.canDownload || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setWorking('download');
    setError('');
    setNotice('');
    try {
      const bytes = await apiBytes(base + '/bundle' + query, controller.signal);
      if (operation.current !== controller || controller.signal.aborted) return;
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
      if (operation.current === controller && !controller.signal.aborted) {
        setError(issue instanceof Error ? issue.message : '交付包下载失败，请重新检查文件。');
        setPlan(undefined);
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setWorking(null);
      }
    }
  };
  const cancel = () => {
    operation.current?.abort();
    operation.current = null;
    setWorking(null);
    setPlan(undefined);
    setNotice('本次请求已取消，未发起文件下载。可以重新检查后再试。');
    setError('');
  };
  return (
    <section className="project-delivery-bundle" aria-label="实际文件交付包">
      <h4>实际文件交付包</h4>
      <p className="field-help">
        将清单中已选择的文件正文、冻结清单和校验信息打包为 ZIP，最多 64 MiB。
        下载时重新核验冻结版本；文件缺失或已变化时不会替换为其他内容。已下载的包可独立保存。
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
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {plan && (
        <div>
          <p>
            已选择 {plan.fileCount} 份文件 · 已知文件正文 {sizeLabel(plan.totalBytes)} · 交付包{' '}
            {sizeLabel(plan.archiveBytes)}
          </p>
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
                <li key={`${file.itemId}:${file.artifactId}`}>
                  <strong>{file.name}</strong>
                  <span>
                    {sizeLabel(file.size)} ·{' '}
                    {file.state === 'ready' ? '与冻结内容一致' : file.reason || '无法打包'}
                  </span>
                  <small>包内位置：{file.path}</small>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
