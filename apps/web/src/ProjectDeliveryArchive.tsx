import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProjectDeliveryBundleJob,
  ProjectDeliveryManifest,
} from '../../../packages/contracts/src/project-delivery';
import type {
  ProjectDeliveryArchive as Archive,
  ProjectDeliveryArchiveList,
  ProjectDeliveryArchiveView,
} from '../../../packages/contracts/src/project-delivery-archive';
import { useSurfaceClient } from './SurfaceClientContext';
import './project-delivery-bundle.css';

const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const archiveBase = (archive: Pick<Archive, 'projectId' | 'manifestId'>) =>
  `/projects/${archive.projectId}/delivery-manifests/${archive.manifestId}/archive`;
const archiveQuery = (archive: Archive) =>
  '?expectedManifestHash=' +
  encodeURIComponent(archive.manifestHash) +
  '&expectedObjectHash=' +
  encodeURIComponent(archive.objectHash);
async function downloadArchive(bytes: Uint8Array, archive: Archive, signal?: AbortSignal) {
  if (
    bytes.length !== archive.size ||
    bytes.length < 4 ||
    bytes.length > 64 * 1024 * 1024 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 3 ||
    bytes[3] !== 4
  )
    throw Error('已保存文件包的格式或大小不一致，未发起下载。请保留记录并检查本机数据。');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (digest !== archive.objectHash)
    throw Error('已保存文件包的校验不一致，未发起下载。请保留记录并检查本机数据。');
  signal?.throwIfAborted();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `project-delivery-${archive.manifestId}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Durable records remain usable independently of current Run and Artifact availability. */
export function ProjectDeliveryArchives({
  projectId,
  revision = 0,
  canRemove = true,
  onChanged,
  onSnapshot,
}: {
  projectId: string;
  revision?: number;
  canRemove?: boolean;
  onChanged?: () => void;
  onSnapshot?: (value: ProjectDeliveryArchiveList | undefined) => void;
}) {
  const { api, apiBytes } = useSurfaceClient();
  const [page, setPage] = useState<ProjectDeliveryArchiveList>();
  const [before, setBefore] = useState(''),
    [trail, setTrail] = useState<string[]>([]),
    [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<Archive>();
  const request = useRef<AbortController | null>(null),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    onSnapshot?.(undefined);
    void api<ProjectDeliveryArchiveList>(
      `/projects/${projectId}/delivery-archives?limit=20` +
        (before ? '&before=' + encodeURIComponent(before) : ''),
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          value.projectId !== projectId ||
          value.items.some((item) => item.projectId !== projectId) ||
          (value.page.before ?? '') !== before
        )
          throw Error('已保存文件包不属于当前项目或页面，请重读。');
        setPage(value);
        onSnapshot?.(value);
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setError(issue instanceof Error ? issue.message : '已保存文件包读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, projectId, before, retry, revision, onSnapshot]);
  const download = async (archive: Archive) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(archive.manifestId);
    setError('');
    setNotice('');
    try {
      const bytes = await apiBytes(archiveBase(archive) + '/file' + archiveQuery(archive), controller.signal);
      controller.signal.throwIfAborted();
      if (!live.current || request.current !== controller) return;
      await downloadArchive(bytes, archive, controller.signal);
      if (!live.current || controller.signal.aborted) return;
      setNotice('已发起保存包下载。此 ZIP 可独立保存，项目中的保存包仍保留。');
    } catch (issue) {
      if (live.current && !controller.signal.aborted)
        setError(issue instanceof Error ? issue.message : '保存包下载失败，请重试');
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (live.current) setBusy('');
      }
    }
  };
  const remove = async () => {
    if (!removing || request.current) return;
    const archive = removing,
      controller = new AbortController();
    request.current = controller;
    setBusy(archive.manifestId);
    setError('');
    setNotice('');
    try {
      const result = await api<ProjectDeliveryArchiveView>(
        archiveBase(archive),
        { expectedManifestHash: archive.manifestHash, expectedObjectHash: archive.objectHash },
        'DELETE',
      );
      if (!live.current) return;
      if (
        result.projectId !== projectId ||
        result.manifestId !== archive.manifestId ||
        result.archive !== null
      )
        throw Error('移除结果无法确认，请重读项目保存包。');
      setRemoving(undefined);
      setNotice('已移除项目中的保存包。冻结清单和你已下载的副本保留。');
      onChanged?.();
      setBefore('');
      setTrail([]);
      setRetry((value) => value + 1);
    } catch (issue) {
      if (live.current) setError(issue instanceof Error ? issue.message : '保存包移除失败，请重读后再确认');
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (live.current) setBusy('');
      }
    }
  };
  return (
    <section className="project-delivery-archives" aria-label="已保存的项目文件包">
      <div className="project-section-heading">
        <div>
          <h3>已保存到项目的文件包</h3>
          <p>
            保存完整 ZIP 后，来源任务删除或产物变化仍可独立下载。它随本机项目数据保留；删除项目会一并删除。
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={loading || !!busy}
          onClick={() => {
            setBefore('');
            setTrail([]);
            setRetry((value) => value + 1);
          }}
        >
          重读已保存文件包
        </button>
      </div>
      {loading && <p role="status">正在读取已保存文件包…</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
          {page && ' 下方保留上次读取的列表，请重读后确认。'}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {page && (
        <>
          <p>
            项目已保存 {page.count} 个文件包 · 共 {sizeLabel(page.totalBytes)}
          </p>
          {!page.count && <p className="field-help">尚未保存文件包。临时检查和下载不会自动保存到项目。</p>}
          {page.items.map((archive) => (
            <article className="project-delivery-archive" key={archive.manifestId}>
              <strong>{archive.title}</strong>
              <p>
                已保存 · {sizeLabel(archive.size)} · {archive.fileCount} 份文件 ·{' '}
                {new Date(archive.savedAt).toLocaleString()}
              </p>
              <div className="project-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={!!busy || loading || !!error}
                  onClick={() => void download(archive)}
                >
                  {busy === archive.manifestId ? '正在处理保存包…' : '下载已保存 ZIP'}
                </button>
                {canRemove && (
                  <button
                    type="button"
                    className="secondary danger"
                    disabled={!!busy || loading || !!error}
                    onClick={() => {
                      setRemoving(archive);
                      setNotice('');
                    }}
                  >
                    移除项目保存包
                  </button>
                )}
              </div>
              <details>
                <summary>保存包校验信息</summary>
                <small>{archive.objectHash}</small>
              </details>
            </article>
          ))}
          <div className="project-actions">
            <button
              type="button"
              className="secondary"
              disabled={!!busy || loading || !trail.length}
              onClick={() => {
                setBefore(trail.at(-1) || '');
                setTrail(trail.slice(0, -1));
              }}
            >
              上一页保存包
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!!busy || loading || !!error || !page.page.hasMore}
              onClick={() => {
                setTrail([...trail, before]);
                setBefore(page.page.nextBefore || '');
              }}
            >
              下一页保存包
            </button>
          </div>
        </>
      )}
      {removing && (
        <div className="project-archive-confirm" role="alert">
          <h4>移除「{removing.title}」的项目保存包？</h4>
          <p>项目中保存的完整 ZIP 将被移除，无法通过项目再次下载。冻结清单和你已下载的副本保留。</p>
          <div className="project-actions">
            <button
              type="button"
              className="secondary"
              disabled={!!busy}
              onClick={() => setRemoving(undefined)}
            >
              保留保存包
            </button>
            <button
              type="button"
              className="secondary danger"
              disabled={!!busy}
              onClick={() => void remove()}
            >
              确认移除保存包
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

type SaveRequest = {
  controller: AbortController;
  jobId: string;
  creation: Promise<ProjectDeliveryBundleJob>;
  cancelled: boolean;
  cancellation?: Promise<ProjectDeliveryBundleJob>;
};
/** Explicitly save to the project; cancelling waits for an authoritative outcome. */
export function ProjectDeliveryArchive({
  manifest,
  archived,
  revision = 0,
  onSaved,
}: {
  manifest: ProjectDeliveryManifest;
  archived?: boolean;
  revision?: number;
  onSaved?: () => void;
}) {
  const { api, apiUrl } = useSurfaceClient();
  const [archive, setArchive] = useState<Archive | null>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false),
    [retry, setRetry] = useState(0),
    [progress, setProgress] = useState<ProjectDeliveryBundleJob>(),
    [working, setWorking] = useState(false),
    [cancelling, setCancelling] = useState(false);
  const operation = useRef<SaveRequest | null>(null),
    live = useRef(true);
  const base = `/projects/${manifest.projectId}/delivery-manifests/${manifest.id}`;
  const [clientId] = useState(() => crypto.randomUUID());
  const body = { expectedManifestHash: manifest.hash, clientId };
  const cancelJob = (request: SaveRequest) =>
    (request.cancellation ??= request.creation.then(() =>
      api<ProjectDeliveryBundleJob>(
        base + '/bundle-jobs/' + request.jobId,
        body,
        'DELETE',
        AbortSignal.timeout(15_000),
      ),
    ));
  const belongs = (value: Archive) =>
    value.projectId === manifest.projectId &&
    value.manifestId === manifest.id &&
    value.manifestHash === manifest.hash;
  const read = async (signal?: AbortSignal) => {
    const result = await api<ProjectDeliveryArchiveView>(
      base + '/archive?expectedManifestHash=' + encodeURIComponent(manifest.hash),
      undefined,
      undefined,
      signal,
    );
    if (
      result.projectId !== manifest.projectId ||
      result.manifestId !== manifest.id ||
      result.manifestHash !== manifest.hash ||
      (result.archive && !belongs(result.archive))
    )
      throw Error('保存包状态不属于当前清单，请重读。');
    return result.archive;
  };
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void read(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setArchive(value);
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setError(issue instanceof Error ? issue.message : '保存包状态读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, base, manifest.hash, revision, retry]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      const current = operation.current;
      if (current) {
        current.cancelled = true;
        current.controller.abort();
        void cancelJob(current).catch(() => {});
      }
    };
  }, []);
  const accept = (value: Archive) => {
    if (!belongs(value)) throw Error('保存结果不属于当前清单，请重读项目保存包。');
    if (!live.current) return;
    setArchive(value);
    setNotice('已保存到项目。来源任务删除或产物变化后，此完整 ZIP 仍可独立下载。');
    setError('');
    onSaved?.();
  };
  const settleCancellation = async (request: SaveRequest) => {
    const result = await cancelJob(request);
    if (!live.current || operation.current !== request) return;
    if (result.stage === 'completed' && result.archive) {
      accept(result.archive);
      return;
    }
    if (result.stage !== 'cancelled' && result.stage !== 'failed')
      throw Error('保存结果尚未确认，请重读已保存文件包。已完成的保存不会被取消撤销。');
    const value = await read();
    if (!live.current || operation.current !== request) return;
    if (value) accept(value);
    else {
      setArchive(null);
      setNotice('本次保存已取消，项目尚未保存此文件包。可以重新保存。');
    }
  };
  const save = async () => {
    if (operation.current || archive || loading || error || archived) return;
    const controller = new AbortController(),
      jobId = crypto.randomUUID();
    const request: SaveRequest = {
      controller,
      jobId,
      cancelled: false,
      creation: api<ProjectDeliveryBundleJob>(
        base + '/bundle-jobs',
        { ...body, jobId, kind: 'save' },
        'POST',
        AbortSignal.timeout(15_000),
      ),
    };
    operation.current = request;
    setWorking(true);
    setCancelling(false);
    setError('');
    setNotice('');
    setProgress(undefined);
    try {
      let job = await request.creation;
      for (;;) {
        if (request.cancelled) {
          await settleCancellation(request);
          return;
        }
        if (!live.current) return;
        if (
          job.id !== jobId ||
          job.clientId !== clientId ||
          job.kind !== 'save' ||
          job.projectId !== manifest.projectId ||
          job.manifestId !== manifest.id ||
          job.manifestHash !== manifest.hash
        )
          throw Error('保存作业不属于当前清单，请重读保存状态。');
        setProgress(job);
        if (job.stage === 'completed') {
          if (!job.archive) throw Error('保存结果缺少项目记录，请重读保存状态。');
          accept(job.archive);
          return;
        }
        if (job.stage === 'failed') throw Error(job.error?.message || '保存失败，未确认项目保存包。');
        if (job.stage === 'cancelled') {
          await settleCancellation(request);
          return;
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, 250);
          controller.signal.addEventListener('abort', done, { once: true });
        });
        if (request.cancelled) continue;
        job = await api<ProjectDeliveryBundleJob>(
          base +
            '/bundle-jobs/' +
            jobId +
            '?expectedManifestHash=' +
            encodeURIComponent(manifest.hash) +
            '&clientId=' +
            clientId,
          undefined,
          undefined,
          controller.signal,
        );
      }
    } catch (issue) {
      if (!live.current) return;
      if (request.cancelled) {
        try {
          await settleCancellation(request);
        } catch {
          setError('保存结果尚未确认，请重读已保存文件包。已完成的保存不会被取消撤销。');
        }
      } else
        setError((issue instanceof Error ? issue.message : '保存失败') + ' 请重读已保存文件包确认结果。');
    } finally {
      if (operation.current === request) {
        operation.current = null;
        if (live.current) {
          setWorking(false);
          setCancelling(false);
        }
      }
    }
  };
  return (
    <section className="project-archive-save" aria-label="保存文件包到项目">
      <h4>保存到项目</h4>
      <p className="field-help">
        显式保存完整 ZIP
        到此本机项目，单独保留文件正文与冻结依据。临时检查、生成和下载不会自动保存；本机备份仍需单独执行。
      </p>
      {loading && <p role="status">正在确认项目保存状态…</p>}
      {archive && (
        <p>
          {(loading || error) && '上次读取：'}
          已保存 · {sizeLabel(archive.size)} · {archive.fileCount} 份文件 ·{' '}
          {new Date(archive.savedAt).toLocaleString()}。可从上方已保存文件包独立下载。
        </p>
      )}
      {archive === null && (
        <button
          type="button"
          className="primary"
          disabled={working || loading || !!error || archived}
          onClick={() => void save()}
        >
          {working ? '正在保存到项目…' : '保存文件包到项目'}
        </button>
      )}
      {archived && !archive && <p className="field-help">项目已归档，恢复项目后可保存新的文件包。</p>}
      {working && (
        <>
          <div className="project-bundle-progress" role="status">
            <strong>
              {cancelling
                ? '正在确认保存结果…'
                : progress?.stage === 'saving'
                  ? '正在保存完整文件包'
                  : '正在核验并准备完整文件包'}
            </strong>
            <progress
              max={progress?.bytesTotal || undefined}
              value={progress?.bytesTotal ? progress.bytesDone : undefined}
              aria-label="项目保存进度"
            />
            {progress && (
              <span>
                文件 {progress.filesDone} / {progress.filesTotal} · {sizeLabel(progress.bytesDone)}
                {progress.bytesTotal !== null ? ' / ' + sizeLabel(progress.bytesTotal) : ''}
              </span>
            )}
            <small>保存完成后才显示已保存。取消仅停止未完成工作，不会移除已完成的保存。</small>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={cancelling}
            onClick={() => {
              const request = operation.current;
              if (!request) return;
              request.cancelled = true;
              request.controller.abort();
              setCancelling(true);
              void cancelJob(request).catch(() => {});
            }}
          >
            取消未完成的保存
          </button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {error && (
        <button
          type="button"
          className="secondary"
          disabled={working || loading}
          onClick={() => {
            setArchive(undefined);
            setRetry((value) => value + 1);
          }}
        >
          重读项目保存状态
        </button>
      )}
    </section>
  );
}

export type ProjectArchiveDeleteConsent = { projectId: string; setHash: string };
/** Read every retained-set identity before allowing project deletion; failures never mean zero. */
export function ProjectArchiveDeleteNotice({
  projectId,
  disabled,
  onConsent,
}: {
  projectId: string;
  disabled?: boolean;
  onConsent: (value: ProjectArchiveDeleteConsent | undefined) => void;
}) {
  const [snapshot, setSnapshot] = useState<ProjectDeliveryArchiveList>(),
    [accepted, setAccepted] = useState(false);
  const previousHash = useRef('');
  const receive = useCallback(
    (value: ProjectDeliveryArchiveList | undefined) => {
      setSnapshot(value);
      if (!value) {
        setAccepted(false);
        onConsent(undefined);
        return;
      }
      if (previousHash.current !== value.setHash) {
        previousHash.current = value.setHash;
        setAccepted(false);
      }
      onConsent(value.count === 0 ? { projectId, setHash: value.setHash } : undefined);
    },
    [projectId, onConsent],
  );
  return (
    <div className="project-archive-delete-notice">
      <ProjectDeliveryArchives projectId={projectId} canRemove={false} onSnapshot={receive} />
      {snapshot && snapshot.count > 0 && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={accepted}
            disabled={disabled}
            onChange={(event) => {
              setAccepted(event.target.checked);
              onConsent(event.target.checked ? { projectId, setHash: snapshot.setHash } : undefined);
            }}
          />
          <span>
            我已导出需要保留的文件包，或明确放弃项目中全部 {snapshot.count} 个已保存包；确认随项目一起删除。
          </span>
        </label>
      )}
    </div>
  );
}
