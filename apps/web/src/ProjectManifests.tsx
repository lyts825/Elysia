import { useEffect, useState } from 'react';
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
  const [open, setOpen] = useState(false),
    [before, setBefore] = useState(''),
    [trail, setTrail] = useState<string[]>([]),
    [page, setPage] = useState<SourceOptions>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open || !item.current) return;
    const controller = new AbortController();
    setLoading(true);
    setPage(undefined);
    setError('');
    void api<SourceOptions>(
      `/runs/${item.current.runId}/handoff` + (before ? '?beforeArtifact=' + encodeURIComponent(before) : ''),
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.runId !== item.current?.runId || result.runRevision !== item.current.runRevision)
          throw Error('候选任务已变化，请先刷新项目工作台。已选元数据仍保留。');
        setPage(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setError(issue instanceof Error ? issue.message : '产物元数据读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, item.current?.runId, item.current?.runRevision, open, before, retry]);
  return (
    <div className="project-artifact-selection">
      <button type="button" className="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
        选择产物元数据 · 已选 {selected.length}/20
      </button>
      {open && (
        <>
          <p className="field-help">只冻结名称、版本、哈希等元数据，不保存文件正文。</p>
          {loading && <p>正在读取元数据…</p>}
          {error && <p className="field-error">{error}</p>}
          {page?.artifacts.map((artifact) => (
            <label className="check-row" key={artifact.id}>
              <input
                type="checkbox"
                checked={selected.includes(artifact.id)}
                disabled={
                  disabled ||
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
              disabled={loading || !trail.length}
              onClick={() => {
                setBefore(trail.at(-1) || '');
                setTrail(trail.slice(0, -1));
              }}
            >
              上一页产物
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading || !page?.artifactPage.hasMore}
              onClick={() => {
                setTrail([...trail, before]);
                setBefore(page?.artifactPage.nextBefore || '');
              }}
            >
              下一页产物
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => {
                setBefore('');
                setTrail([]);
                setRetry((n) => n + 1);
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
  action,
  openRun,
}: {
  board: ProjectDeliveryBoard;
  draft: ProjectBoardDraft;
  change: (update: (draft: ProjectBoardDraft) => ProjectBoardDraft) => void;
  busy: boolean;
  action: (path: string, body: Record<string, unknown>) => Promise<boolean>;
  openRun: (id: string, review?: boolean) => void;
}) {
  const { api, apiBytes } = useSurfaceClient();
  const [page, setPage] = useState<ProjectDeliveryManifestList>(),
    [detail, setDetail] = useState<ProjectDeliveryManifestView>(),
    [error, setError] = useState(''),
    [detailError, setDetailError] = useState('');
  const [before, setBefore] = useState(''),
    [trail, setTrail] = useState<string[]>([]),
    [retry, setRetry] = useState(0),
    [detailRetry, setDetailRetry] = useState(0),
    [loading, setLoading] = useState(false),
    [downloadBusy, setDownloadBusy] = useState(false);
  const base = `/projects/${board.projectId}/delivery-manifests`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setPage(undefined);
    void api<ProjectDeliveryManifestList>(
      base + (before ? '?before=' + encodeURIComponent(before) : ''),
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted && result.projectId === board.projectId) setPage(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '冻结历史读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, base, board.projectId, before, retry]);
  useEffect(() => {
    setDetail(undefined);
    setDetailError('');
    if (!draft.selectedManifest) return;
    const controller = new AbortController();
    void api<ProjectDeliveryManifestView>(
      base + '/' + draft.selectedManifest,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (
          !controller.signal.aborted &&
          result.manifest.projectId === board.projectId &&
          result.manifest.id === draft.selectedManifest
        )
          setDetail(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setDetailError(issue instanceof Error ? issue.message : '冻结清单读取失败');
      });
    return () => controller.abort();
  }, [api, base, board.projectId, draft.selectedManifest, detailRetry]);
  const manifest = draft.manifest;
  const chosen = board.items.filter((item) => manifest?.selected.includes(item.id));
  const canFreeze =
    !!manifest?.title.trim() &&
    chosen.length > 0 &&
    chosen.length === manifest?.selected.length &&
    chosen.every(
      (item) =>
        item.readiness === 'ready' &&
        item.current?.fingerprint &&
        item.current.reviewId &&
        item.current.runRevision !== null &&
        item.current.rootRevision !== null,
    ) &&
    board.items.filter((item) => item.required).every((item) => manifest?.selected.includes(item.id));
  const download = async (format: 'json' | 'markdown') => {
    if (!detail || downloadBusy) return;
    setDownloadBusy(true);
    setDetailError('');
    try {
      const bytes = await apiBytes(base + '/' + detail.manifest.id + '/export?format=' + format);
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
      setDetailError(issue instanceof Error ? issue.message : '下载失败，请重试');
    } finally {
      setDownloadBusy(false);
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
          disabled={busy || board.archived}
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
        清单不包含文件正文。可在清单详情检查所选文件并下载实际文件交付包；源文件缺失或已变化会阻止打包。修改项目说明或删除来源任务不会改写已冻结内容。删除整个项目会删除清单，请先下载需要保留的记录和文件。
      </p>
      {manifest && (
        <section className="project-freeze-form" aria-label="冻结交付确认">
          <label>
            本次交付名称
            <input
              maxLength={200}
              value={manifest.title}
              onChange={(e) =>
                change((value) => ({ ...value, manifest: { ...value.manifest!, title: e.target.value } }))
              }
            />
          </label>
          {manifest.selected
            .filter((id) => !board.items.some((item) => item.id === id))
            .map((id) => (
              <div key={id} className="field-error">
                原选交付项已不在当前计划中：{id}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
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
          {board.items.map((item) => (
            <div className="project-freeze-item" key={item.id}>
              <label className="check-row">
                <input
                  type="checkbox"
                  disabled={busy}
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
                  {item.readiness === 'ready' ? '可交付' : '尚未满足交付条件'}
                </span>
              </label>
              {manifest.selected.includes(item.id) && item.current && (
                <ArtifactSelection
                  key={`${item.id}:${item.current.runId}`}
                  item={item}
                  selected={manifest.artifacts[item.id] || []}
                  disabled={busy}
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
          {!canFreeze && (
            <p className="field-help">
              请填写交付名称，选齐必需交付项；每个纳入项须人工采纳、原意见复验通过并确认符合当前项目标准。
            </p>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy || board.archived || !canFreeze}
            onClick={() => {
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
                  setBefore('');
                  setTrail([]);
                  setRetry((n) => n + 1);
                }
              });
            }}
          >
            确认冻结本次交付清单
          </button>
        </section>
      )}
      <h3>已冻结清单</h3>
      {loading && <p>正在读取历史…</p>}
      {error && <p className="field-error">{error}</p>}
      {page?.items.map((item) => (
        <button
          type="button"
          key={item.id}
          className={'project-manifest-link ' + (draft.selectedManifest === item.id ? 'selected' : '')}
          onClick={() => change((value) => ({ ...value, selectedManifest: item.id }))}
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
          disabled={loading || !trail.length}
          onClick={() => {
            setBefore(trail.at(-1) || '');
            setTrail(trail.slice(0, -1));
          }}
        >
          上一页清单
        </button>
        <button
          type="button"
          className="secondary"
          disabled={loading || !page?.page.hasMore}
          onClick={() => {
            setTrail([...trail, before]);
            setBefore(page?.page.nextBefore || '');
          }}
        >
          下一页清单
        </button>
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => {
            setBefore('');
            setTrail([]);
            setRetry((n) => n + 1);
          }}
        >
          刷新清单历史
        </button>
      </div>
      {draft.selectedManifest && (
        <section className="project-manifest-detail" aria-label="冻结清单详情">
          {detailError && (
            <p className="field-error" role="alert">
              {detailError}
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
                      原任务当前：
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
                          原产物记录：
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
