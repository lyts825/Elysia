/**
 * 展示和管理项目交付归档。
 * 分页浏览独立保存的ZIP，协调生成、取消、下载与删除确认，并核对清单/对象哈希；取消作业后仍读取最终状态以区分已完成保存。
 * EN: Displays and manages project delivery archives. Browses independently saved ZIPs and coordinates generation, cancellation, download, and deletion acknowledgement with manifest/object hashes; cancelled jobs are reconciled to distinguish completed saves.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
import './project-delivery-archive.css';

/**
 * 按字节、KiB或MiB显示保存包大小，较大单位保留一位小数便于列表核对。
 * EN: Formats archive sizes in bytes, KiB, or MiB with one decimal for larger units for list inspection.
 */
const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
/**
 * 以项目及清单身份生成归档资源路径，所有下载和查询都绑定这一清单。
 * EN: Builds the archive resource path from project and manifest identities so reads and downloads target the same manifest.
 */
const archiveBase = (archive: Pick<Archive, 'projectId' | 'manifestId'>) =>
  `/projects/${archive.projectId}/delivery-manifests/${archive.manifestId}/archive`;
/**
 * 把清单哈希和对象哈希加入预期版本参数；服务端可拒绝身份变化后的文件读取。
 * EN: Adds expected manifest and object hashes as query parameters so the server can reject reads after identity changes.
 */
const archiveQuery = (archive: Archive) =>
  '?expectedManifestHash=' +
  encodeURIComponent(archive.manifestHash) +
  '&expectedObjectHash=' +
  encodeURIComponent(archive.objectHash);
/**
 * 下载前在浏览器核对声明长度、ZIP 头和完整 SHA-256，取消检查放在耗时摘要计算之后。
 * 只有全部一致才创建下载链接，防止网络或存储异常内容被当作已验证保存包交付。
 * EN: Before download validate declared length, ZIP signature, and full SHA-256; check cancellation after hashing. Create links only for consistent data so corrupt bytes are not delivered as verified archives.
 */
async function downloadArchive(bytes: Uint8Array, archive: Archive, signal?: AbortSignal) {
  /**
   * 下载前先检查声明长度和 ZIP 文件头，后续再核对内容摘要。
   * EN: Check declared length and ZIP header before content digest.
   */
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

/**
 * 展示已归档文件包的数量、大小、清单及对象哈希等事实，供下载前核对冻结身份。
 * EN: Displays archive facts including file count, size, and manifest/object hashes for verification of the frozen identity before downloading.
 */
function ArchiveFacts({ value }: { value: Archive }) {
  return (
    <dl className="archive-facts">
      <div>
        <dt>文件数量</dt>
        <dd>{value.fileCount} 份</dd>
      </div>
      <div>
        <dt>保存大小</dt>
        <dd>{sizeLabel(value.size)}</dd>
      </div>
      <div>
        <dt>保存时间</dt>
        <dd>{new Date(value.savedAt).toLocaleString()}</dd>
      </div>
    </dl>
  );
}

/**
 * 分页浏览持久保存的项目文件包，记录独立于当前运行和产物是否仍存在。
 * 下载和删除按冻结清单哈希及对象哈希绑定；取消或读取错误时禁用动作，保留上一页供查看。
 * onSnapshot 在读取开始即置空，避免外层删除确认继续信任旧集合。
 * EN: Browse persistent packages independently of surviving runs/artifacts. Bind download/delete to manifest/object hashes. On cancellation/read errors disable actions and retain the old page. Clear onSnapshot at read start so outer deletion guards cannot trust an old set.
 */
export function ProjectDeliveryArchives({
  projectId,
  revision = 0,
  canRemove = true,
  onChanged,
  onSnapshot,
  onOpenManifest,
}: {
  projectId: string;
  revision?: number;
  canRemove?: boolean;
  onChanged?: () => void;
  onSnapshot?: (value: ProjectDeliveryArchiveList | undefined) => void;
  onOpenManifest?: (archive: Pick<Archive, 'projectId' | 'manifestId' | 'manifestHash'>) => void;
}) {
  const { api, apiBytes } = useSurfaceClient();
  const archiveId = useId();
  type Position = { before: string; trail: string[] };
  /**
   * 创建无游标、无返回轨迹的独立首页位置，供刷新或项目切换后重置分页。
   * EN: Creates a fresh first-page position without a cursor or return trail for refreshes and project changes.
   */
  const firstPage = (): Position => ({ before: '', trail: [] });
  const [display, setDisplay] = useState<{ page: ProjectDeliveryArchiveList; position: Position }>();
  const [intent, setIntent] = useState<{
    projectId: string;
    revision: number;
    position: Position;
    attempt: number;
  }>();
  const [listRead, setListRead] = useState<{
    status: 'ready' | 'loading' | 'failed' | 'cancelled';
    error: string;
  }>({ status: 'loading', error: '' });
  const listRequest = useRef<AbortController | undefined>(undefined);
  const shown = display?.page.projectId === projectId ? display : undefined;
  const page = shown?.page;
  const position = shown?.position ?? firstPage();
  const loading = listRead.status === 'loading';
  const [busy, setBusy] = useState(''),
    [operationError, setError] = useState(''),
    [notice, setNotice] = useState('');
  const error = listRead.error || operationError;
  const actionsUnavailable = listRead.status !== 'ready' || !!error;
  const [removing, setRemoving] = useState<Archive>();
  const request = useRef<AbortController | null>(null),
    live = useRef(true);
  /**
   * 挂载标记列表视图可接收异步结果，卸载撤销该标记并中断下载请求，供下载后的昂贵校验再次检查。
   * EN: Marks the archive list live for async results and revokes that flag while aborting downloads on teardown, supporting post-verification liveness checks.
   */
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      request.current?.abort();
    };
  }, []);
  /**
   * 项目、列表修订或分页意图变化时读取保存包列表；核对每项归属和页游标，清理取消并仅解除自己的控制器引用。
   * EN: Reads archives on project, list revision, or page-intent changes, validating item ownership/cursor; cleanup aborts and detaches only its own controller reference.
   */
  useEffect(() => {
    const controller = new AbortController();
    listRequest.current = controller;
    const target =
      intent?.projectId === projectId && intent.revision === revision ? intent.position : firstPage();
    /**
     * 判断当前列表控制器是否仍为最新且未取消；所有异步回写以此屏蔽旧页结果。
     * EN: Checks that this list controller is still current and not aborted, guarding asynchronous updates from obsolete page reads.
     */
    const active = () => listRequest.current === controller && !controller.signal.aborted;
    setListRead({ status: 'loading', error: '' });
    onSnapshot?.(undefined);
    void api<ProjectDeliveryArchiveList>(
      `/projects/${projectId}/delivery-archives?limit=20` +
        (target.before ? '&before=' + encodeURIComponent(target.before) : ''),
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!active()) return;
        if (
          value.projectId !== projectId ||
          value.items.some((item) => item.projectId !== projectId) ||
          (value.page.before ?? '') !== target.before
        )
          throw Error('已保存文件包不属于当前项目或页面，请重读。');
        setDisplay({ page: value, position: target });
        setListRead({ status: 'ready', error: '' });
        onSnapshot?.(value);
      })
      .catch((issue) => {
        if (active())
          setListRead({
            status: 'failed',
            error: issue instanceof Error ? issue.message : '已保存文件包读取失败',
          });
      });
    return () => {
      controller.abort();
      if (listRequest.current === controller) listRequest.current = undefined;
    };
  }, [api, projectId, intent, revision, onSnapshot]);
  /**
   * 取消上一次列表读取并记录新分页意图，递增尝试号以便同位置重试也触发读取。
   * EN: Aborts the prior list read and records a new page intent, incrementing its attempt so retrying the same position triggers a read.
   */
  const requestList = (target: Position) => {
    listRequest.current?.abort();
    setIntent((previous) => ({
      projectId,
      revision,
      position: target,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
  };
  /**
   * 取消列表读取、清空上层摘要并显示取消状态；已读列表仍保留用于核对。
   * EN: Cancels the list read, clears the parent snapshot, and displays cancellation while retaining previously loaded list content.
   */
  const cancelList = () => {
    listRequest.current?.abort();
    listRequest.current = undefined;
    onSnapshot?.(undefined);
    setListRead({ status: 'cancelled', error: '' });
  };
  /**
   * 串行下载指定冻结归档并校验身份、长度和完整摘要；仅当前未取消请求触发浏览器保存，失败发布错误。
   * EN: Downloads one frozen archive at a time and validates identity, length, and full digest. Only the current non-aborted request triggers browser saving; failures expose an error.
   */
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
  /**
   * 删除只移除项目中的保存对象；响应必须确认同一项目、清单且 archive 为 null。
   * EN: Delete only the saved project object; response must match project/manifest and confirm archive=null.
   */
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
      requestList(firstPage());
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
            /**
             * 文件动作失败后可通过明确重查列表恢复。
             * EN: Explicitly rechecking the list is the existing recovery path for a failed file action.
             */
            setError('');
            requestList(firstPage());
          }}
        >
          重读已保存文件包
        </button>
      </div>
      {loading && (
        <div className="project-actions">
          <p role="status">正在读取已保存文件包…</p>
          <button type="button" className="secondary" onClick={cancelList}>
            取消本次保存包读取
          </button>
        </div>
      )}
      {listRead.status === 'cancelled' && (
        <p role="status">本次保存包读取已取消。已读页面保留，保存包集合尚未重新确认，可明确重试或重读。</p>
      )}
      {listRead.error && (
        <div className="field-error" role="alert">
          <p className="archive-reading" role="region" aria-label="保存包列表读取问题全文" tabIndex={0}>
            {listRead.error}
          </p>
        </div>
      )}
      {operationError && (
        <div className="field-error" role="alert">
          <p className="archive-reading" role="region" aria-label="保存包操作问题全文" tabIndex={0}>
            {operationError}
          </p>
        </div>
      )}
      {(listRead.status === 'failed' || listRead.status === 'cancelled') && (
        <button
          type="button"
          className="secondary"
          disabled={!!busy}
          onClick={() =>
            requestList(
              intent?.projectId === projectId && intent.revision === revision ? intent.position : firstPage(),
            )
          }
        >
          重试本次保存包读取
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      {page && (
        <>
          <dl className="archive-list-summary">
            <div>
              <dt>项目已保存</dt>
              <dd>{page.count} 个文件包</dd>
            </div>
            <div>
              <dt>总占用</dt>
              <dd>{sizeLabel(page.totalBytes)}</dd>
            </div>
            <div>
              <dt>当前页</dt>
              <dd>
                第 {position.trail.length + 1} 页 · 本页 {page.items.length} 个
              </dd>
            </div>
          </dl>
          {listRead.status !== 'ready' && (
            <p className="field-help" role="status">
              上次读取：仍显示保存包第 {position.trail.length + 1} 页，当前列表和保存包集合尚未重新确认。
            </p>
          )}
          {!page.count && <p className="field-help">尚未保存文件包。临时检查和下载不会自动保存到项目。</p>}
          {!!page.items.length && (
            <div className="archive-records" role="region" aria-label="本页已保存文件包" tabIndex={0}>
              {page.items.map((archive) => (
                <article className="project-delivery-archive" key={archive.manifestId}>
                  <p className="archive-state">已保存到项目</p>
                  <h4 className="archive-reading" id={`${archiveId}-${archive.manifestId}`} tabIndex={0}>
                    {archive.title}
                  </h4>
                  <ArchiveFacts value={archive} />
                  <div className="project-actions">
                    {onOpenManifest && (
                      <button
                        type="button"
                        className="secondary"
                        aria-describedby={`${archiveId}-${archive.manifestId}`}
                        disabled={!!busy || actionsUnavailable}
                        onClick={() => onOpenManifest(archive)}
                      >
                        查看冻结依据
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      aria-describedby={`${archiveId}-${archive.manifestId}`}
                      disabled={!!busy || actionsUnavailable}
                      onClick={() => void download(archive)}
                    >
                      {busy === archive.manifestId ? '正在处理保存包…' : '下载已保存 ZIP'}
                    </button>
                    {canRemove && (
                      <button
                        type="button"
                        className="secondary danger"
                        aria-describedby={`${archiveId}-${archive.manifestId}`}
                        disabled={!!busy || actionsUnavailable}
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
                    <dl
                      className="archive-reading archive-hashes"
                      role="region"
                      aria-label="保存包完整校验信息"
                      tabIndex={0}
                    >
                      <div>
                        <dt>文件包 SHA256</dt>
                        <dd>{archive.objectHash}</dd>
                      </div>
                      <div>
                        <dt>冻结清单 SHA256</dt>
                        <dd>{archive.manifestHash}</dd>
                      </div>
                      <div>
                        <dt>冻结清单标识</dt>
                        <dd>{archive.manifestId}</dd>
                      </div>
                    </dl>
                  </details>
                </article>
              ))}
            </div>
          )}
          <div className="project-actions">
            <button
              type="button"
              className="secondary"
              disabled={!!busy || loading || !position.trail.length}
              onClick={() => {
                requestList({ before: position.trail.at(-1) || '', trail: position.trail.slice(0, -1) });
              }}
            >
              上一页保存包
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!!busy || loading || !!operationError || !page.page.hasMore}
              onClick={() => {
                requestList({
                  before: page.page.nextBefore || '',
                  trail: [...position.trail, position.before],
                });
              }}
            >
              下一页保存包
            </button>
          </div>
        </>
      )}
      {removing && (
        <div className="project-archive-confirm" role="alert">
          <h4>移除项目保存包？</h4>
          <p className="archive-reading" role="region" aria-label="待移除保存包完整名称" tabIndex={0}>
            {removing.title}
          </p>
          <ArchiveFacts value={removing} />
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
/**
 * 明确保存至项目，取消也等待权威结果。
 * EN: Explicitly save to the project; cancelling waits for an authoritative outcome.
 */
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
  /**
   * 为本次保存作业复用一个取消Promise；先等待创建返回，再按确定jobId请求删除，避免取消未知作业。
   * EN: Reuses one cancellation promise for this save job, waiting for creation before deleting the exact jobId to avoid cancelling an unknown job.
   */
  const cancelJob = (request: SaveRequest) =>
    (request.cancellation ??= request.creation.then(() =>
      api<ProjectDeliveryBundleJob>(
        base + '/bundle-jobs/' + request.jobId,
        body,
        'DELETE',
        AbortSignal.timeout(15_000),
      ),
    ));
  /**
   * 核对归档的项目、清单ID和清单哈希，防止把其他版本的保存结果应用到当前清单。
   * EN: Checks archive project, manifest ID, and manifest hash so a save result from another revision cannot be applied to this manifest.
   */
  const belongs = (value: Archive) =>
    value.projectId === manifest.projectId &&
    value.manifestId === manifest.id &&
    value.manifestHash === manifest.hash;
  /**
   * 读取当前清单的保存状态并核对响应身份；身份不符时抛错，防止展示其他清单的独立保存包。
   * EN: Reads archive state for this manifest and validates response identity, throwing on mismatch rather than displaying an archive from another manifest.
   */
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
  /**
   * 清单哈希、归档修订或重试变化时读取保存状态；旧请求中断后不回写loading、错误或保存包，避免跨清单显示。
   * EN: Reads archive state on manifest-hash, archive-revision, or retry changes; aborted reads cannot update loading, errors, or archives across manifests.
   */
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
  /**
   * 保存面板卸载时标记本次操作取消，中断浏览器读取并尽力取消精确服务端作业；完成保存仍由取消核对流程识别。
   * EN: On save-panel teardown, marks its operation cancelled, aborts browser reads, and best-effort cancels the exact server job; cancellation reconciliation still recognizes completed saves.
   */
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
  /**
   * 验证归档归属后向仍挂载的界面发布保存成功，并通知上层刷新；身份不符直接抛错。
   * EN: Validates archive ownership before publishing success to a live view and notifying the parent to refresh; an identity mismatch throws.
   */
  const accept = (value: Archive) => {
    if (!belongs(value)) throw Error('保存结果不属于当前清单，请重读项目保存包。');
    if (!live.current) return;
    setArchive(value);
    setNotice('已保存到项目。来源任务删除或产物变化后，此完整 ZIP 仍可独立下载。');
    setError('');
    onSaved?.();
  };
  /**
   * 读取精确作业的取消结果；若保存已完成则接受归档，否则确认终止并重新读取权威状态，避免把取消等同于回滚。
   * EN: Settles cancellation for the exact job. A completed save is accepted; otherwise termination is confirmed and authoritative archive state is reread, because cancellation does not imply rollback.
   */
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
  /**
   * 在无并发操作且清单可保存时创建独立保存作业，轮询并校验身份；取消后核对最终状态，完成结果由accept统一发布。
   * EN: Creates an isolated save job only when no operation is active and the manifest is eligible, polling with identity checks. Cancellation reconciles final state; accept publishes completed results.
   */
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
          /**
           * 结束一次轮询间隔等待并解除中断监听；定时完成和取消信号共用此收束路径。
           * EN: Ends one polling delay and removes its abort listener, sharing cleanup between timeout completion and cancellation.
           */
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
        <div>
          <p className="archive-state">
            {(loading || error) && '上次读取：'}已保存到项目，可从已保存文件包独立下载。
          </p>
          <ArchiveFacts value={archive} />
        </div>
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
        <div className="field-error" role="alert">
          <p className="archive-reading" role="region" aria-label="项目保存状态问题全文" tabIndex={0}>
            {error}
          </p>
        </div>
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
/**
 * 项目删除前读取全部保留集合身份，失败不能当作零。
 * EN: Read every retained-set identity before allowing project deletion; failures never mean zero.
 */
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
  const consentId = useId();
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
        <div className="archive-delete-consent">
          <p className="field-help" id={consentId}>
            删除项目会一并移除全部 {snapshot.count}{' '}
            个项目保存包。请先导出需要保留的文件包，或明确放弃这些文件包。
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={accepted}
              disabled={disabled}
              aria-describedby={consentId}
              onChange={(event) => {
                setAccepted(event.target.checked);
                onConsent(event.target.checked ? { projectId, setHash: snapshot.setHash } : undefined);
              }}
            />
            <span>已处理保存包，确认随项目删除</span>
          </label>
        </div>
      )}
    </div>
  );
}
