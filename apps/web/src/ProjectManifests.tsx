import { useEffect, useRef, useState } from 'react';
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
  type Position = { before: string; trail: string[] };
  const firstPage = (): Position => ({ before: '', trail: [] });
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
  const request = (target: Position) => {
    currentRead.current?.abort();
    setIntent((previous) => ({ owner, position: target, attempt: (previous?.attempt ?? 0) + 1 }));
  };
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
            <p className="field-error" role="alert">
              {error}
            </p>
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
          {page?.artifacts.map((artifact) => (
            <label className="check-row" key={artifact.id}>
              <input
                type="checkbox"
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
                {artifact.name} · v{artifact.version}
                {!artifact.verified && ' · 未核验，不能纳入交付'}
                <small>{artifact.hash}</small>
              </span>
            </label>
          ))}
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
  type Position = { before: string; trail: string[] };
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
  const selectManifest = (manifestId: string, manifestHash: string) => {
    scrollToDetail.current = true;
    change((value) => ({ ...value, selectedManifest: manifestId, selectedManifestHash: manifestHash }));
    setDetailRetry((value) => value + 1);
  };
  useEffect(() => {
    const controller = new AbortController();
    listRequest.current = controller;
    const target = intent?.projectId === board.projectId ? intent.position : firstPage();
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
  const requestHistory = (target: Position) => {
    listRequest.current?.abort();
    setIntent((previous) => ({
      projectId: board.projectId,
      position: target,
      attempt: (previous?.attempt ?? 0) + 1,
    }));
  };
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
    <section aria-label="汇总交付清单">
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
                      <p>{blocker.reason}</p>
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
          <label>
            本次交付名称
            <input
              ref={manifestTitle}
              maxLength={200}
              value={manifest.title}
              onChange={(e) =>
                change((value) => ({ ...value, manifest: { ...value.manifest!, title: e.target.value } }))
              }
            />
          </label>
          {[...new Set(manifest.selected)]
            .filter((id) => !board.items.some((item) => item.id === id))
            .map((id) => (
              <div key={id} className="field-error">
                原选交付项已不在当前计划中：{id}
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
            {board.items.map((item) => (
              <div className="project-freeze-item" key={item.id}>
                <label className="check-row">
                  <input
                    ref={(node) => {
                      if (node) itemSelections.current.set(item.id, node);
                      else itemSelections.current.delete(item.id);
                    }}
                    type="checkbox"
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
                    {item.title} {item.required ? '（必需）' : '（可选）'} ·{' '}
                    {unavailable
                      ? '当前交付条件未知'
                      : item.readiness === 'ready'
                        ? '可交付'
                        : '尚未满足交付条件'}
                  </span>
                </label>
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
        <p className="field-error" role="alert">
          {error}
        </p>
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
          {listRead.status !== 'ready' && '上次读取：'}冻结清单第 {position.trail.length + 1} 页
          {listRead.status !== 'ready' && '，当前历史尚未重新确认。'}
        </p>
      )}
      {page?.items.map((item) => (
        <button
          type="button"
          key={item.id}
          className={'project-manifest-link ' + (draft.selectedManifest === item.id ? 'selected' : '')}
          onClick={() => selectManifest(item.id, item.hash)}
        >
          <strong>{item.title}</strong>
          <span>
            {new Date(item.createdAt).toLocaleString()} · {item.itemCount} 项
          </span>
        </button>
      ))}
      {page && !page.items.length && <p className="field-help">尚未冻结交付清单。</p>}
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
      {draft.selectedManifest && (
        <section
          ref={detailSection}
          tabIndex={-1}
          className="project-manifest-detail"
          aria-label="冻结清单详情"
        >
          {detailLoading && <p role="status">正在读取冻结依据与当前记录状态…</p>}
          {detailError && (
            <p className="field-error" role="alert">
              {detailError}
              {detail && ' 下方保留该清单上次读取的冻结依据，原任务与产物的当前状态尚未确认。'}
            </p>
          )}
          {downloadError && (
            <p className="field-error" role="alert">
              {downloadError}
            </p>
          )}
          <button type="button" className="secondary" onClick={() => setDetailRetry((n) => n + 1)}>
            重读清单与当前记录状态
          </button>
          {detail && (
            <>
              <h3>{detail.manifest.title}</h3>
              <p>
                冻结于 {new Date(detail.manifest.createdAt).toLocaleString()} · 项目计划版本{' '}
                {detail.manifest.boardRevision}
              </p>
              <p className="project-prose">{detail.manifest.goal}</p>
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
              {detail.manifest.items.map((entry) => {
                const availability = detail.availability.find((value) => value.itemId === entry.item.id);
                return (
                  <details key={entry.item.id}>
                    <summary>
                      {entry.item.title} · 标准版本 {entry.item.itemRevision}
                    </summary>
                    <h4>冻结的项目标准</h4>
                    <ol>
                      {entry.item.acceptanceCriteria.map((text, i) => (
                        <li key={i}>{text}</li>
                      ))}
                    </ol>
                    <h4>冻结的任务与复核</h4>
                    <p>
                      {entry.run.title} · 已采纳 · {entry.sourceNotes.resolved}/{entry.sourceNotes.total}{' '}
                      条原意见已解决
                    </p>
                    <p className="project-prose">{entry.review.note}</p>
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
                      <div key={artifact.id}>
                        <strong>
                          {artifact.name} · v{artifact.version}
                        </strong>
                        <small>{artifact.hash}</small>
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
                      <pre>
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
                <small>{detail.manifest.hash}</small>
              </details>
            </>
          )}
        </section>
      )}
    </section>
  );
}
