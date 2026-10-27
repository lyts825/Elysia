/**
 * 展示和管理项目交付清单。
 * 从当前产物候选生成冻结交付清单并浏览历史、详情与保存包入口；分页和选择均绑定项目、运行或清单版本，过期数据不可直接提交。
 * EN: Prepares and browses frozen project manifests. Builds frozen delivery manifests from current artifact candidates and browses history/details/archive controls; pages and selections are revision-bound and stale data cannot be submitted directly.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type {
  ProjectDeliveryBoard,
  ProjectDeliveryItem,
  ProjectDeliveryManifestList,
  ProjectDeliveryManifestView,
} from '../../../packages/contracts/src/project-delivery';
import type { SourceOptions } from '../../../packages/contracts/src/workflow';
import type { ProjectBoardDraft } from './ProjectBoardDraft';
import { useSurfaceClient } from './SurfaceClientContext';
import { ProjectDeliveryBundle } from './ProjectDeliveryBundle';
import { ProjectDeliveryArchives } from './ProjectDeliveryArchive';
import { projectManifestReadiness, type ProjectManifestBlocker } from './project-manifest-readiness';
import './project-manifests.css';

/**
 * 为一个交付项分页挑选产物元数据。候选页绑定当前候选运行及修订；读取失败、取消
 * 或候选变化时保留已选 ID，要求用户刷新工作台后再核对，不能以旧页继续扩充选择。
 * EN: Page artifact metadata per item and current candidate run/revision. Failure/cancel/candidate change retains selected IDs but requires board refresh/review before adding candidates from an old page.
 */
function ArtifactSelection({
  item,
  selected,
  change,
  disabled,
}: {
  item: ProjectDeliveryItem;
  selected: string[];
  change: (ids: string[]) => void;
  disabled: boolean;
}) {
  const { api } = useSurfaceClient();
  const selectionId = useId();
  type Position = { before: string; trail: string[] };
  /**
   * 返回新的产物候选首页位置，避免多个分页实例共享返回轨迹。
   * EN: Returns a fresh first-page position for artifact candidates so pagination instances do not share a return trail.
   */
  const firstPage = (): Position => ({ before: '', trail: [] });
  /**
   * 产物候选页绑定当前执行及版本，执行变化后不能复用旧页选择。
   * EN: Candidate pages are bound to current run/version; changed run invalidates old page selection.
   */
  const owner = `${item.current?.runId}:${item.current?.runRevision}`;
  const [open, setOpen] = useState(false);
  const [display, setDisplay] = useState<{ owner: string; page: SourceOptions; position: Position }>();
  const [intent, setIntent] = useState<{ owner: string; position: Position; attempt: number }>();
  const [read, setRead] = useState<{ status: 'ready' | 'loading' | 'failed' | 'cancelled'; error: string }>({
    status: 'ready',
    error: '',
  });
  const currentRead = useRef<AbortController | undefined>(undefined);
  const shown = display?.owner === owner ? display : undefined;
  const page = shown?.page;
  const position = shown?.position ?? firstPage();
  const loading = read.status === 'loading';
  const error = read.error;
  useEffect(() => {
    if (!open || !item.current) return;
    const controller = new AbortController();
    currentRead.current = controller;
    const target = intent?.owner === owner ? intent.position : firstPage();
    /**
     * 确认候选页请求仍是当前控制器且未取消，旧运行或旧页回执不再发布。
     * EN: Confirms the candidate-page request is current and not aborted, preventing updates from an old run or page.
     */
    const active = () => currentRead.current === controller && !controller.signal.aborted;
    setRead({ status: 'loading', error: '' });
    void api<SourceOptions>(
      `/runs/${item.current.runId}/handoff` +
        (target.before ? '?beforeArtifact=' + encodeURIComponent(target.before) : ''),
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!active()) return;
        if (
          result.runId !== item.current?.runId ||
          result.runRevision !== item.current.runRevision ||
          (result.artifactPage.before ?? '') !== target.before
        )
          throw Error('候选任务已变化，请先刷新项目工作台。已选元数据仍保留。');
        setDisplay({ owner, page: result, position: target });
        setRead({ status: 'ready', error: '' });
      })
      .catch((issue) => {
        if (active())
          setRead({ status: 'failed', error: issue instanceof Error ? issue.message : '产物元数据读取失败' });
      });
    return () => {
      controller.abort();
      if (currentRead.current === controller) currentRead.current = undefined;
    };
  }, [api, item.current?.runId, item.current?.runRevision, owner, open, intent]);
  /**
   * 新分页意图取消旧请求，但可见页要等新页校验成功后才替换。
   * EN: Cancel previous paging intent but replace visible page only after successful validation.
   */
  const request = (target: Position) => {
    currentRead.current?.abort();
    setIntent((previous) => ({ owner, position: target, attempt: (previous?.attempt ?? 0) + 1 }));
  };
  /**
   * 取消产物候选读取并解除当前控制器，保留已显示选择并标记取消状态。
   * EN: Cancels candidate loading and detaches its controller while retaining visible selections and marking the read cancelled.
   */
  const cancel = () => {
    currentRead.current?.abort();
    currentRead.current = undefined;
    setRead({ status: 'cancelled', error: '' });
  };
  return (
    <div className="project-artifact-selection">
      <button
        type="button"
        className="secondary"
        onClick={() => {
          if (open) {
            if (loading) cancel();
            currentRead.current?.abort();
            currentRead.current = undefined;
            setOpen(false);
          } else {
            request(position);
            setOpen(true);
          }
        }}
        aria-expanded={open}
      >
        选择产物元数据 · 已选 {selected.length}/20
      </button>
      {open && (
        <>
          <p className="field-help">只冻结名称、版本、哈希等元数据，不保存文件正文。</p>
          {loading && (
            <div className="project-actions">
              <p role="status">正在读取元数据…</p>
              <button type="button" className="secondary" onClick={cancel}>
                取消本次元数据读取
              </button>
            </div>
          )}
          {read.status === 'cancelled' && (
            <p role="status">本次元数据读取已取消。已读页面和元数据选择保留，可明确重试或重读。</p>
          )}
          {error && (
            <div className="field-error" role="alert">
              <p
                className="manifest-reading"
                role="region"
                aria-label="产物元数据读取错误完整内容"
                tabIndex={0}
              >
                {error}
              </p>
            </div>
          )}
          {(read.status === 'failed' || read.status === 'cancelled') && (
            <button
              type="button"
              className="secondary"
              onClick={() => request(intent?.owner === owner ? intent.position : firstPage())}
            >
              重试本次元数据读取
            </button>
          )}
          {page && (
            <p className="field-help" role={read.status !== 'ready' ? 'status' : undefined}>
              {read.status !== 'ready' && '上次读取：'}产物第 {position.trail.length + 1} 页
              {read.status !== 'ready' && '，当前元数据尚未重新确认。'}
            </p>
          )}
          {page && !page.artifacts.length && <p className="field-help">此页没有产物元数据。</p>}
          {!!page?.artifacts.length && (
            <div
              className="manifest-artifact-options"
              role="region"
              aria-label="本页产物元数据候选"
              tabIndex={0}
            >
              {page?.artifacts.map((artifact, index) => (
                <article className="manifest-artifact-option" key={artifact.id}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      aria-describedby={`${selectionId}-${artifact.id}`}
                      checked={selected.includes(artifact.id)}
                      disabled={
                        disabled ||
                        read.status !== 'ready' ||
                        (!selected.includes(artifact.id) && (!artifact.verified || selected.length >= 20))
                      }
                      onChange={(e) =>
                        change(
                          e.target.checked
                            ? [...selected, artifact.id]
                            : selected.filter((id) => id !== artifact.id),
                        )
                      }
                    />
                    <span>
                      产物 {index + 1} · v{artifact.version}
                      {!artifact.verified && ' · 未核验，不能纳入交付'}
                    </span>
                  </label>
                  <div
                    id={`${selectionId}-${artifact.id}`}
                    className="manifest-reading manifest-artifact-metadata"
                    role="region"
                    aria-label={`产物 ${index + 1} 完整名称与哈希`}
                    tabIndex={0}
                  >
                    <p>{artifact.name}</p>
                    <small>哈希：{artifact.hash}</small>
                  </div>
                </article>
              ))}
            </div>
          )}
          {selected.length > 0 && (
            <button type="button" className="secondary" disabled={disabled} onClick={() => change([])}>
              清空此项的元数据选择
            </button>
          )}
          <div className="project-actions">
            <button
              type="button"
              className="secondary"
              disabled={loading || !position.trail.length}
              onClick={() => {
                request({ before: position.trail.at(-1) || '', trail: position.trail.slice(0, -1) });
              }}
            >
              上一页产物
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading || !page?.artifactPage.hasMore}
              onClick={() => {
                request({
                  before: page?.artifactPage.nextBefore || '',
                  trail: [...position.trail, position.before],
                });
              }}
            >
              下一页产物
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => {
                request(firstPage());
              }}
            >
              重读元数据
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 准备冻结清单、浏览冻结历史并读取清单详情。准备内容保存在项目工作台草稿中，
 * 历史页和详情分别校验项目、清单 ID 与哈希；下载只使用已核对详情并在选择变化时取消。
 * readiness 将冻结阻塞项映射到实际修复入口，而不是仅显示不可提交状态。
 * EN: Prepare frozen manifests in workbench draft; browse history/details with project/manifest/hash validation. Download verified details only and cancel on selection changes. readiness maps blockers to actionable repair targets.
 */
export function ProjectManifests({
  board,
  draft,
  change,
  busy,
  unavailable,
  action,
  openRun,
  onEditPlan,
  onSelectItem,
  onRefreshBoard,
}: {
  board: ProjectDeliveryBoard;
  draft: ProjectBoardDraft;
  change: (update: (draft: ProjectBoardDraft) => ProjectBoardDraft) => void;
  busy: boolean;
  unavailable: boolean;
  action: (path: string, body: Record<string, unknown>) => Promise<boolean>;
  openRun: (id: string, review?: boolean) => void;
  onEditPlan: () => void;
  onSelectItem: (id: string) => void;
  onRefreshBoard: () => void;
}) {
  const { api, apiBytes } = useSurfaceClient();
  const manifestId = useId();
  type Position = { before: string; trail: string[] };
  /**
   * 创建交付清单历史首页状态，清空游标和返回轨迹。
   * EN: Creates the initial manifest-history page state with no cursor or return trail.
   */
  const firstPage = (): Position => ({ before: '', trail: [] });
  const [display, setDisplay] = useState<{ page: ProjectDeliveryManifestList; position: Position }>();
  const [intent, setIntent] = useState<{ projectId: string; position: Position; attempt: number }>();
  const [listRead, setListRead] = useState<{
    status: 'ready' | 'loading' | 'failed' | 'cancelled';
    error: string;
  }>({ status: 'loading', error: '' });
  const listRequest = useRef<AbortController | undefined>(undefined);
  const shown = display?.page.projectId === board.projectId ? display : undefined;
  const page = shown?.page;
  const position = shown?.position ?? firstPage();
  const loading = listRead.status === 'loading';
  const error = listRead.error;
  const [readDetail, setDetail] = useState<ProjectDeliveryManifestView>(),
    [detailError, setDetailError] = useState(''),
    [downloadError, setDownloadError] = useState('');
  const [detailRetry, setDetailRetry] = useState(0),
    [detailLoading, setDetailLoading] = useState(false),
    [downloadBusy, setDownloadBusy] = useState(false),
    [archiveRevision, setArchiveRevision] = useState(0);
  const base = `/projects/${board.projectId}/delivery-manifests`;
  const detailSection = useRef<HTMLElement | null>(null),
    scrollToDetail = useRef(false),
    downloadRequest = useRef<AbortController | null>(null);
  const manifestTitle = useRef<HTMLInputElement | null>(null),
    manifestSelection = useRef<HTMLFieldSetElement | null>(null),
    itemSelections = useRef(new Map<string, HTMLInputElement>()),
    removedSelections = useRef(new Map<string, HTMLButtonElement>());
  const detail =
    readDetail?.manifest.projectId === board.projectId &&
    readDetail.manifest.id === draft.selectedManifest &&
    (!draft.selectedManifestHash || readDetail.manifest.hash === draft.selectedManifestHash)
      ? readDetail
      : undefined;
  /**
   * 保存清单身份及冻结哈希，并让后续详情读取将焦点移到详情区域。
   * EN: Save manifest identity/hash and move focus into its loaded details.
   */
  const selectManifest = (manifestId: string, manifestHash: string) => {
    scrollToDetail.current = true;
    change((value) => ({ ...value, selectedManifest: manifestId, selectedManifestHash: manifestHash }));
    setDetailRetry((value) => value + 1);
  };
  useEffect(() => {
    const controller = new AbortController();
    listRequest.current = controller;
    const target = intent?.projectId === board.projectId ? intent.position : firstPage();
    /**
     * 只允许仍为当前且未取消的清单列表请求更新界面，隔离快速翻页的旧响应。
     * EN: Allows only the current non-aborted manifest-list request to update the view, isolating obsolete responses during rapid navigation.
     */
    const active = () => listRequest.current === controller && !controller.signal.aborted;
    setListRead({ status: 'loading', error: '' });
    void api<ProjectDeliveryManifestList>(
      base + (target.before ? '?before=' + encodeURIComponent(target.before) : ''),
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!active()) return;
        if (result.projectId !== board.projectId || (result.page.before ?? '') !== target.before)
          throw Error('冻结历史不属于当前项目或页面，请重读。');
        setDisplay({ page: result, position: target });
        setListRead({ status: 'ready', error: '' });
      })
      .catch((issue) => {
        if (active())
          setListRead({
            status: 'failed',
            error: issue instanceof Error ? issue.message : '冻结历史读取失败',
          });
      });
    return () => {
      controller.abort();
      if (listRequest.current === controller) listRequest.current = undefined;
    };
  }, [api, base, board.projectId, intent]);
  /**
   * 分页意图属于当前项目；成功前继续展示上一页，错误不会伪造新页游标。
   * EN: Bind paging intent to project; retain old visible page until success and never fabricate its new cursor on error.
   */
  const requestHistory = (target: Position) => {
    listRequest.current?.abort();
    setIntent((previous) => ({
      projectId: board.projectId,
      position: target,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
  };
  /**
   * 取消清单历史读取并标记取消；保持已读页位置供显式重试或核对。
   * EN: Cancels manifest-history loading and marks it cancelled while retaining the loaded page position for explicit retry or inspection.
   */
  const cancelHistory = () => {
    listRequest.current?.abort();
    listRequest.current = undefined;
    setListRead({ status: 'cancelled', error: '' });
  };
  useEffect(() => {
    setDetailError('');
    if (!draft.selectedManifest) {
      setDetail(undefined);
      setDetailLoading(false);
      return;
    }
    if (scrollToDetail.current) {
      scrollToDetail.current = false;
      detailSection.current?.scrollIntoView({ block: 'start' });
      detailSection.current?.focus({ preventScroll: true });
    }
    const controller = new AbortController();
    setDetailLoading(true);
    void api<ProjectDeliveryManifestView>(
      base + '/' + draft.selectedManifest,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          result.manifest.projectId !== board.projectId ||
          result.manifest.id !== draft.selectedManifest ||
          (draft.selectedManifestHash && result.manifest.hash !== draft.selectedManifestHash)
        )
          throw Error('冻结清单与所选项目、清单或校验信息不一致，请重读后确认。');
        setDetail(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setDetailError(issue instanceof Error ? issue.message : '冻结清单读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [api, base, board.projectId, draft.selectedManifest, draft.selectedManifestHash, detailRetry]);
  useEffect(() => {
    setDownloadBusy(false);
    setDownloadError('');
    return () => {
      downloadRequest.current?.abort();
      downloadRequest.current = null;
    };
  }, [board.projectId, draft.selectedManifest, draft.selectedManifestHash]);
  const manifest = draft.manifest;
  const chosen = board.items.filter((item) => manifest?.selected.includes(item.id));
  const readiness = manifest
    ? projectManifestReadiness(board, manifest, { busy, unavailable })
    : { canFreeze: false, blockers: [] };
  /**
   * 将冻结前置条件定位到计划、交付项、复核、标题或对应勾选控件。
   * EN: Locate prerequisites in plan/item/review/title or relevant checkbox.
   */
  const goToBlocker = (blocker: ProjectManifestBlocker) => {
    if (blocker.target === 'plan') return onEditPlan();
    if (blocker.target === 'refresh') return onRefreshBoard();
    if (blocker.target === 'item' && blocker.itemId) return onSelectItem(blocker.itemId);
    if ((blocker.target === 'run' || blocker.target === 'review') && blocker.runId)
      return openRun(blocker.runId, blocker.target === 'review');
    const target =
      blocker.target === 'title'
        ? manifestTitle.current
        : blocker.target === 'remove' && blocker.itemId
          ? removedSelections.current.get(blocker.itemId)
          : blocker.itemId
            ? itemSelections.current.get(blocker.itemId)
            : manifestSelection.current?.querySelector<HTMLInputElement>('input') ||
              manifestSelection.current;
    target?.scrollIntoView({ block: 'center' });
    target?.focus({ preventScroll: true });
  };
  /**
   * 同时只下载一个已核对清单；项目或选择变化会中止请求，迟到的字节不触发下载。
   * JSON 和 Markdown 都由服务端按冻结清单导出，浏览器只负责创建下载链接。
   * EN: Download one verified manifest at a time. Project/selection changes abort; late bytes cannot download. Server exports frozen JSON/Markdown; browser only creates links.
   */
  const download = async (format: 'json' | 'markdown') => {
    if (!detail || downloadRequest.current) return;
    const controller = new AbortController();
    downloadRequest.current = controller;
    setDownloadBusy(true);
    setDownloadError('');
    try {
      const bytes = await apiBytes(
        base + '/' + detail.manifest.id + '/export?format=' + format,
        controller.signal,
      );
      if (controller.signal.aborted || downloadRequest.current !== controller) return;
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], {
          type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `project-delivery-${detail.manifest.id}.${format === 'json' ? 'json' : 'md'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (issue) {
      if (!controller.signal.aborted && downloadRequest.current === controller)
        setDownloadError(issue instanceof Error ? issue.message : '下载失败，请重试');
    } finally {
      if (downloadRequest.current === controller) {
        downloadRequest.current = null;
        setDownloadBusy(false);
      }
    }
  };
  return (
    <section className="project-manifests" aria-label="汇总交付清单">
      <div className="project-section-heading">
        <div>
          <h2>汇总交付</h2>
          <p>冻结当时的标准、候选、复核、原意见复验和所选产物元数据。</p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={busy || unavailable || board.archived}
          onClick={() =>
            change((value) => ({
              ...value,
              manifest: value.manifest || {
                title: '',
                selected: board.items.filter((item) => item.readiness === 'ready').map((item) => item.id),
                artifacts: {},
              },
            }))
          }
        >
          准备冻结交付清单
        </button>
      </div>
      <p className="field-help">
        清单不包含文件正文。可在清单详情检查、临时下载，或显式保存完整文件包到项目；新打包仍需核验当前来源。已保存包独立于来源任务，删除整个项目会同时删除清单和已保存包，请先导出需要保留的记录与文件。
      </p>
      <ProjectDeliveryArchives
        projectId={board.projectId}
        revision={archiveRevision}
        onChanged={() => setArchiveRevision((value) => value + 1)}
        onOpenManifest={(archive) => {
          if (archive.projectId !== board.projectId) return;
          selectManifest(archive.manifestId, archive.manifestHash);
        }}
      />
      {manifest && (
        <section className="project-freeze-form" aria-label="冻结交付确认">
          <section className="project-freeze-readiness" aria-label="冻结前核对">
            <h3>冻结前核对</h3>
            <p className="field-help">
              列出当前可确定的阻塞条件；每个纳入项先处理当前首个条件，再重读后核对。产物元数据可不选，提交时仍会核验最新版本与所选元数据。
            </p>
            {board.archived && (
              <p role="status">项目已归档，不能冻结新清单。请在「项目与归档」中恢复项目，再重读项目状态。</p>
            )}
            {busy && !unavailable && <p role="status">正在处理项目操作，请等待完成后再核对冻结条件。</p>}
            {readiness.blockers.length > 0 ? (
              <>
                <p role="status">
                  {unavailable ? '当前冻结条件未知。' : `仍有 ${readiness.blockers.length} 项需要处理。`}
                </p>
                <ul className="project-freeze-blockers">
                  {readiness.blockers.map((blocker) => (
                    <li className="project-todo-row" key={blocker.id}>
                      <p
                        className="manifest-reading"
                        role="region"
                        aria-label="冻结阻塞原因完整内容"
                        tabIndex={0}
                      >
                        {blocker.reason}
                      </p>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || (board.archived && blocker.target === 'plan')}
                        onClick={() => goToBlocker(blocker)}
                      >
                        {blocker.action}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              readiness.canFreeze && <p role="status">当前已知条件已满足，可以提交冻结核验。</p>
            )}
          </section>
          <label className="manifest-title-field">
            本次交付名称
            <input
              ref={manifestTitle}
              maxLength={200}
              aria-invalid={!manifest.title.trim() || manifest.title.trim().length > 200}
              aria-describedby={`${manifestId}-title-help`}
              value={manifest.title}
              onChange={(e) =>
                change((value) => ({ ...value, manifest: { ...value.manifest!, title: e.target.value } }))
              }
            />
            <small id={`${manifestId}-title-help`}>
              原文 {manifest.title.length} 字符 · 去除首尾空白后 {manifest.title.trim().length} / 200 字符
              {!manifest.title.trim()
                ? ' · 请填写本次交付名称，空白不能提交。'
                : manifest.title.trim().length > 200 && ' · 名称超过 200 字符，请缩短后再提交。'}
            </small>
          </label>
          {[...new Set(manifest.selected)]
            .filter((id) => !board.items.some((item) => item.id === id))
            .map((id) => (
              <div key={id} className="field-error manifest-removed-selection">
                <p className="manifest-reading" role="region" aria-label="失效交付项完整标识" tabIndex={0}>
                  原选交付项已不在当前计划中：{id}
                </p>
                <button
                  ref={(node) => {
                    if (node) removedSelections.current.set(id, node);
                    else removedSelections.current.delete(id);
                  }}
                  type="button"
                  className="secondary"
                  disabled={busy || unavailable}
                  onClick={() =>
                    change((value) => ({
                      ...value,
                      manifest: {
                        ...value.manifest!,
                        selected: value.manifest!.selected.filter((entry) => entry !== id),
                      },
                    }))
                  }
                >
                  从本次冻结选择中移除
                </button>
              </div>
            ))}
          <fieldset ref={manifestSelection} tabIndex={-1} aria-label="纳入本次冻结的交付项">
            <legend>
              纳入本次冻结的交付项 · 已选 {manifest.selected.length}/{board.items.length}
            </legend>
            {board.items.map((item, index) => (
              <div className="project-freeze-item" key={item.id}>
                <label className="check-row">
                  <input
                    ref={(node) => {
                      if (node) itemSelections.current.set(item.id, node);
                      else itemSelections.current.delete(item.id);
                    }}
                    type="checkbox"
                    aria-describedby={`${manifestId}-${item.id}`}
                    disabled={busy || unavailable}
                    checked={manifest.selected.includes(item.id)}
                    onChange={(e) =>
                      change((value) => ({
                        ...value,
                        manifest: {
                          ...value.manifest!,
                          selected: e.target.checked
                            ? [...value.manifest!.selected, item.id]
                            : value.manifest!.selected.filter((id) => id !== item.id),
                        },
                      }))
                    }
                  />
                  <span>
                    交付项 {index + 1} {item.required ? '（必需）' : '（可选）'} ·{' '}
                    {unavailable
                      ? '当前交付条件未知'
                      : item.readiness === 'ready'
                        ? '可交付'
                        : '尚未满足交付条件'}
                  </span>
                </label>
                <p
                  id={`${manifestId}-${item.id}`}
                  className="manifest-reading manifest-item-title"
                  role="region"
                  aria-label={`交付项 ${index + 1} 完整名称`}
                  tabIndex={0}
                >
                  {item.title}
                </p>
                {manifest.selected.includes(item.id) && item.current && (
                  <div className="manifest-current-candidate">
                    <small>
                      当前候选任务 · 标准版本 {item.itemRevision} · 任务版本{' '}
                      {item.current.runRevision ?? '未知'}
                    </small>
                    <p
                      className="manifest-reading"
                      role="region"
                      aria-label={`交付项 ${index + 1} 当前候选完整名称`}
                      tabIndex={0}
                    >
                      {item.current.title}
                    </p>
                  </div>
                )}
                {manifest.selected.includes(item.id) && item.current && (
                  <ArtifactSelection
                    key={`${item.id}:${item.current.runId}`}
                    item={item}
                    selected={manifest.artifacts[item.id] || []}
                    disabled={busy || unavailable}
                    change={(ids) =>
                      change((value) => ({
                        ...value,
                        manifest: {
                          ...value.manifest!,
                          artifacts: { ...value.manifest!.artifacts, [item.id]: ids },
                        },
                      }))
                    }
                  />
                )}
              </div>
            ))}
          </fieldset>
          <button
            type="button"
            className="primary"
            disabled={!readiness.canFreeze}
            aria-describedby={`${manifestId}-title-help`}
            onClick={() => {
              if (!readiness.canFreeze) return;
              const sent = JSON.stringify(manifest);
              void action(base, {
                title: manifest.title,
                items: chosen.map((item) => ({
                  itemId: item.id,
                  expectedItemRevision: item.itemRevision,
                  runId: item.current!.runId,
                  expectedRunRevision: item.current!.runRevision,
                  expectedRootRevision: item.current!.rootRevision,
                  expectedFingerprint: item.current!.fingerprint,
                  expectedReviewId: item.current!.reviewId,
                  artifactIds: manifest.artifacts[item.id] || [],
                })),
              }).then((ok) => {
                if (ok) {
                  change((value) =>
                    JSON.stringify(value.manifest) === sent ? { ...value, manifest: undefined } : value,
                  );
                  requestHistory(firstPage());
                }
              });
            }}
          >
            确认冻结本次交付清单
          </button>
        </section>
      )}
      <section className="manifest-history" aria-label="已冻结清单历史">
        <h3>已冻结清单</h3>
        {loading && (
          <div className="project-actions">
            <p role="status">正在读取历史…</p>
            <button type="button" className="secondary" onClick={cancelHistory}>
              取消本次清单历史读取
            </button>
          </div>
        )}
        {listRead.status === 'cancelled' && (
          <p role="status">本次冻结历史读取已取消。已读页面和清单选择保留，可明确重试或刷新。</p>
        )}
        {error && (
          <div className="field-error" role="alert">
            <p
              className="manifest-reading"
              role="region"
              aria-label="冻结清单历史读取错误完整内容"
              tabIndex={0}
            >
              {error}
            </p>
          </div>
        )}
        {(listRead.status === 'failed' || listRead.status === 'cancelled') && (
          <button
            type="button"
            className="secondary"
            onClick={() =>
              requestHistory(intent?.projectId === board.projectId ? intent.position : firstPage())
            }
          >
            重试本次清单历史读取
          </button>
        )}
        {page && (
          <p className="field-help" role={listRead.status !== 'ready' ? 'status' : undefined}>
            {listRead.status !== 'ready' && '上次读取：'}冻结清单第 {position.trail.length + 1} 页 · 本页{' '}
            {page.items.length} 项{listRead.status !== 'ready' && '，当前历史尚未重新确认。'}
          </p>
        )}
        {!!page?.items.length && (
          <div className="manifest-history-list" role="group" aria-label="本页已冻结清单" tabIndex={0}>
            {page?.items.map((item) => (
              <button
                type="button"
                key={item.id}
                className={'project-manifest-link ' + (draft.selectedManifest === item.id ? 'selected' : '')}
                aria-pressed={draft.selectedManifest === item.id}
                onClick={() => selectManifest(item.id, item.hash)}
              >
                <strong>{item.title}</strong>
                <span>
                  {new Date(item.createdAt).toLocaleString()} · {item.itemCount} 项
                </span>
              </button>
            ))}
          </div>
        )}
        {page && !page.items.length && (
          <p className="field-help">{position.trail.length ? '此页没有冻结清单。' : '尚未冻结交付清单。'}</p>
        )}
        <div className="project-actions">
          <button
            type="button"
            className="secondary"
            disabled={loading || !position.trail.length}
            onClick={() => {
              requestHistory({ before: position.trail.at(-1) || '', trail: position.trail.slice(0, -1) });
            }}
          >
            上一页清单
          </button>
          <button
            type="button"
            className="secondary"
            disabled={loading || !page?.page.hasMore}
            onClick={() => {
              requestHistory({
                before: page?.page.nextBefore || '',
                trail: [...position.trail, position.before],
              });
            }}
          >
            下一页清单
          </button>
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => {
              requestHistory(firstPage());
            }}
          >
            刷新清单历史
          </button>
        </div>
      </section>
      {draft.selectedManifest && (
        <section
          ref={detailSection}
          tabIndex={-1}
          className="project-manifest-detail"
          aria-label="冻结清单详情"
        >
          {detailLoading && <p role="status">正在读取冻结依据与当前记录状态…</p>}
          {detailError && (
            <div className="field-error" role="alert">
              <p
                className="manifest-reading"
                role="region"
                aria-label="冻结清单详情读取错误完整内容"
                tabIndex={0}
              >
                {detailError}
                {detail && ' 下方保留该清单上次读取的冻结依据，原任务与产物的当前状态尚未确认。'}
              </p>
            </div>
          )}
          {downloadError && (
            <div className="field-error" role="alert">
              <p className="manifest-reading" role="region" aria-label="清单下载错误完整内容" tabIndex={0}>
                {downloadError}
              </p>
            </div>
          )}
          <button type="button" className="secondary" onClick={() => setDetailRetry((n) => n + 1)}>
            重读清单与当前记录状态
          </button>
          {detail && (
            <>
              <h3>所选冻结清单</h3>
              <p
                className="manifest-reading manifest-detail-title"
                role="region"
                aria-label="所选冻结清单完整名称"
                tabIndex={0}
              >
                {detail.manifest.title}
              </p>
              <p>
                冻结于 {new Date(detail.manifest.createdAt).toLocaleString()} · 项目计划版本{' '}
                {detail.manifest.boardRevision}
              </p>
              <h4>冻结的项目目标</h4>
              <p
                className="project-prose manifest-reading"
                role="region"
                aria-label="冻结的项目目标完整内容"
                tabIndex={0}
              >
                {detail.manifest.goal}
              </p>
              <div className="project-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={downloadBusy}
                  onClick={() => void download('json')}
                >
                  下载 JSON
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={downloadBusy}
                  onClick={() => void download('markdown')}
                >
                  下载 Markdown
                </button>
              </div>
              <ProjectDeliveryBundle
                key={`${detail.manifest.projectId}:${detail.manifest.id}:${detail.manifest.hash}`}
                manifest={detail.manifest}
                archived={board.archived}
                archiveRevision={archiveRevision}
                onSaved={() => setArchiveRevision((value) => value + 1)}
              />
              {detail.manifest.items.map((entry, index) => {
                const availability = detail.availability.find((value) => value.itemId === entry.item.id);
                return (
                  <details className="manifest-frozen-item" key={entry.item.id}>
                    <summary>
                      交付项 {index + 1} · 标准版本 {entry.item.itemRevision}
                    </summary>
                    <p
                      className="manifest-reading manifest-item-title"
                      role="region"
                      aria-label={`冻结交付项 ${index + 1} 完整名称`}
                      tabIndex={0}
                    >
                      {entry.item.title}
                    </p>
                    <h4>冻结的项目标准</h4>
                    <ol
                      className="manifest-reading"
                      role="region"
                      aria-label={`冻结交付项 ${index + 1} 全部项目标准`}
                      tabIndex={0}
                    >
                      {entry.item.acceptanceCriteria.map((text, i) => (
                        <li key={i}>{text}</li>
                      ))}
                    </ol>
                    <h4>冻结的任务与复核</h4>
                    <p>
                      已采纳 · {entry.sourceNotes.resolved}/{entry.sourceNotes.total} 条原意见已解决
                    </p>
                    <p
                      className="manifest-reading"
                      role="region"
                      aria-label={`冻结交付项 ${index + 1} 任务完整名称`}
                      tabIndex={0}
                    >
                      {entry.run.title}
                    </p>
                    <p
                      className="project-prose manifest-reading"
                      role="region"
                      aria-label={`冻结交付项 ${index + 1} 完整复核意见`}
                      tabIndex={0}
                    >
                      {entry.review.note || '未填写复核意见。'}
                    </p>
                    <p>
                      {detailLoading || detailError ? '上次读取时原任务：' : '原任务当前：'}
                      {
                        {
                          available: '可读取',
                          missing: '已删除',
                          changed: '已变化',
                          unavailable: '无法读取',
                        }[availability?.run || 'unavailable']
                      }
                    </p>
                    {availability?.run !== 'missing' && (
                      <button type="button" className="secondary" onClick={() => openRun(entry.run.id, true)}>
                        查看任务当前交付
                      </button>
                    )}
                    <h4>冻结的产物元数据（不含正文）</h4>
                    {!entry.artifacts.length && <p>未选入产物元数据。</p>}
                    {entry.artifacts.map((artifact) => (
                      <div className="manifest-frozen-artifact" key={artifact.id}>
                        <div
                          className="manifest-reading"
                          role="region"
                          aria-label="冻结产物完整名称与哈希"
                          tabIndex={0}
                        >
                          <strong>
                            {artifact.name} · v{artifact.version}
                          </strong>
                          <small>哈希：{artifact.hash}</small>
                        </div>
                        <p>
                          {detailLoading || detailError ? '上次读取时原产物记录：' : '原产物记录：'}
                          {
                            {
                              available: '仍一致',
                              missing: '已缺失',
                              changed: '已变化',
                              unavailable: '无法读取',
                            }[
                              availability?.artifacts.find((value) => value.id === artifact.id)?.state ||
                                'unavailable'
                            ]
                          }
                        </p>
                      </div>
                    ))}
                    <details>
                      <summary>查看全部冻结依据</summary>
                      <pre
                        className="manifest-reading"
                        role="region"
                        aria-label={`冻结交付项 ${index + 1} 全部冻结依据`}
                        tabIndex={0}
                      >
                        {JSON.stringify(
                          {
                            confirmation: entry.confirmation,
                            review: entry.review,
                            sourceFeedback: entry.sourceFeedback,
                            evidence: entry.evidence,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </details>
                );
              })}
              <details>
                <summary>清单校验信息</summary>
                <small className="manifest-reading" role="region" aria-label="清单完整校验哈希" tabIndex={0}>
                  {detail.manifest.hash}
                </small>
              </details>
            </>
          )}
        </section>
      )}
    </section>
  );
}
