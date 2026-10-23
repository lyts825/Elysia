import { Activity, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Artifact } from '../../../packages/contracts/src/index';
import { ArtifactFilePreview, type TerminalLogContext } from './ArtifactFilePreview';
import { Icon } from './Icon';
import { usePresenceMotion } from './Motion';
import { useSurfaceClient, useSurfaceRoot } from './SurfaceClientContext';
import './preview-dock.css';
import { readingCheckpoint, saveReadingCheckpoint } from './ReadingCheckpoint';

function savedRatio(ratioKey: string) {
  try {
    const value = Number(localStorage.getItem(ratioKey));
    if (Number.isFinite(value) && value > 0 && value < 1) return value;
  } catch {
    // The split still works when browser storage is unavailable.
  }
  return 0.5;
}

export function PreviewDock({
  children,
  workspaceAvailable,
  artifacts,
  selectedArtifactId,
  workspaceRequestId,
  logContexts,
  checkpointKey,
  allowLogContextLookup = true,
  selectArtifact,
  close,
}: {
  children: ReactNode;
  workspaceAvailable: boolean;
  artifacts: Artifact[];
  selectedArtifactId?: string;
  workspaceRequestId?: string;
  logContexts?: Record<string, TerminalLogContext>;
  checkpointKey?: string;
  allowLogContextLookup?: boolean;
  selectArtifact: (artifact: Artifact | null) => void;
  close: () => void;
}) {
  const client = useSurfaceClient(),
    { apiUrl, surfaceStorageKey, surface } = client;
  const savedKey = JSON.stringify(['preview-dock', checkpointKey]);
  const saved = checkpointKey
    ? readingCheckpoint<{ view: string; artifactId?: string; requestId?: string; wide: boolean }>(
        client,
        savedKey,
      )
    : undefined;
  const surfaceRoot = useSurfaceRoot();
  const ratioKey = surfaceStorageKey('elysia.preview.split-ratio');
  const panel = useRef<HTMLElement>(null);
  const present = usePresenceMotion(panel, 'panel');
  const [ratio, setRatio] = useState(() => savedRatio(ratioKey));
  const [available, setAvailable] = useState(0);
  const [wide, setWide] = useState(saved?.wide || false);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState(
    selectedArtifactId || !workspaceAvailable ? 'artifacts' : saved?.view || 'workspace',
  );
  const [workspaceVisited, setWorkspaceVisited] = useState(
    workspaceAvailable && !selectedArtifactId && view === 'workspace',
  );
  const [artifactsVisited, setArtifactsVisited] = useState(view === 'artifacts');
  const [lastArtifactId, setLastArtifactId] = useState(selectedArtifactId || saved?.artifactId);
  const handledWorkspaceRequest = useRef(saved?.requestId || '');
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const single = available < 668;
  const usable = Math.max(0, available - 8);
  const minimum = 320;
  const maximum = Math.max(minimum, usable - 320);
  const width = Math.max(minimum, Math.min(maximum, usable * ratio));
  const wantedArtifactId = selectedArtifactId || lastArtifactId;
  const listedArtifact = artifacts.find((item) => item.id === wantedArtifactId);
  const [historicalArtifact, setHistoricalArtifact] = useState<{
    runId: string;
    id: string;
    value?: Artifact;
    error?: string;
  } | null>(null);
  const [artifactRetry, setArtifactRetry] = useState(0);
  const historical =
    historicalArtifact &&
    historicalArtifact.runId === checkpointKey &&
    historicalArtifact.id === wantedArtifactId
      ? historicalArtifact
      : null;
  const artifact =
    listedArtifact || historical?.value || (!wantedArtifactId || !checkpointKey ? artifacts[0] : undefined);
  const artifactChoices =
    artifact && !artifacts.some((item) => item.id === artifact.id) ? [artifact, ...artifacts] : artifacts;
  useEffect(() => {
    if (!checkpointKey || view !== 'artifacts' || !wantedArtifactId || listedArtifact || historical) return;
    const controller = new AbortController();
    void client
      .api<Artifact>(
        `/runs/${checkpointKey}/records/artifacts/${wantedArtifactId}`,
        undefined,
        undefined,
        controller.signal,
      )
      .then((value) => {
        if (!controller.signal.aborted)
          setHistoricalArtifact({ runId: checkpointKey, id: wantedArtifactId, value });
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setHistoricalArtifact({
            runId: checkpointKey,
            id: wantedArtifactId,
            error: issue instanceof Error ? issue.message : '读取产物失败',
          });
      });
    return () => controller.abort();
  }, [client, checkpointKey, view, wantedArtifactId, listedArtifact, artifactRetry]);

  useLayoutEffect(() => {
    const layout = panel.current!.parentElement!;
    const measure = () => setAvailable(layout.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const layout = panel.current!.parentElement!;
    layout.toggleAttribute('data-preview-single', single && present);
    layout.toggleAttribute('data-preview-expanded', wide && present);
    layout.toggleAttribute('data-preview-resizing', dragging && present);
    return () => {
      layout.removeAttribute('data-preview-single');
      layout.removeAttribute('data-preview-expanded');
      layout.removeAttribute('data-preview-resizing');
    };
  }, [single, wide, dragging, present]);
  useLayoutEffect(() => {
    if (!(single || wide) || !present) return;
    const conversation = panel.current!.parentElement!.querySelector<HTMLElement>('.conversation');
    const previous = document.activeElement as HTMLElement | null;
    const wasInert = conversation?.inert;
    if (conversation) conversation.inert = true;
    panel.current!.querySelector<HTMLButtonElement>('[data-preview-close]')?.focus({ preventScroll: true });
    return () => {
      if (conversation) conversation.inert = wasInert || false;
      if (
        previous?.isConnected &&
        !previous.closest('[inert]') &&
        !surfaceRoot?.current?.querySelector('.overlay')
      )
        previous.focus({ preventScroll: true });
    };
  }, [single, wide, present]);
  useEffect(() => {
    if (selectedArtifactId) {
      setLastArtifactId(selectedArtifactId);
      setArtifactsVisited(true);
      setView('artifacts');
    }
  }, [selectedArtifactId]);
  useEffect(() => {
    if (workspaceRequestId && workspaceAvailable && handledWorkspaceRequest.current !== workspaceRequestId) {
      handledWorkspaceRequest.current = workspaceRequestId;
      setWorkspaceVisited(true);
      setView('workspace');
    }
  }, [workspaceRequestId, workspaceAvailable]);
  useEffect(() => {
    if (!workspaceAvailable) {
      setArtifactsVisited(true);
      setView('artifacts');
    }
  }, [workspaceAvailable]);
  useEffect(() => {
    if (checkpointKey)
      saveReadingCheckpoint(client, savedKey, {
        view,
        artifactId: wantedArtifactId || artifact?.id,
        requestId: handledWorkspaceRequest.current,
        wide,
      });
  }, [client, savedKey, view, artifact?.id, workspaceRequestId, wide]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(ratioKey, String(ratio));
      } catch {
        // Resizing is usable without persisted preferences.
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [ratio]);
  useEffect(() => {
    if (single || wide || !present) {
      drag.current = null;
      setDragging(false);
    }
  }, [single, wide, present]);

  const resize = (next: number) => {
    if (usable > 0) setRatio(Math.max(minimum, Math.min(maximum, next)) / usable);
  };
  const dismiss = () => {
    close();
    surfaceRoot?.current?.querySelector<HTMLElement>('.preview-toggle')?.focus({ preventScroll: true });
  };
  return (
    <>
      <div
        className="preview-divider"
        role="separator"
        aria-label="调整对话与预览宽度"
        aria-orientation="vertical"
        aria-controls={surface + '-run-preview'}
        aria-valuemin={minimum}
        aria-valuemax={Math.round(maximum)}
        aria-valuenow={Math.round(width)}
        aria-valuetext={`预览宽度 ${Math.round(width)} 像素`}
        title="拖动调整宽度，双击恢复均分；方向键微调"
        tabIndex={0}
        hidden={single || wide || !present}
        onDoubleClick={() => setRatio(0.5)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 80 : 24;
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'Enter') setRatio(0.5);
          else
            resize(
              event.key === 'Home'
                ? minimum
                : event.key === 'End'
                  ? maximum
                  : width + (event.key === 'ArrowLeft' ? step : -step),
            );
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, width };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (drag.current?.id === event.pointerId)
            resize(drag.current.width + drag.current.x - event.clientX);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
      />
      <aside
        ref={panel}
        id={surface + '-run-preview'}
        className={'preview-dock' + (wide ? ' preview-expanded' : '')}
        style={{ width: single || wide ? '100%' : width }}
        aria-label="分屏预览"
        data-leaving={!present || undefined}
        inert={!present}
        onKeyDown={(event) => {
          if (
            event.key === 'Escape' &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing &&
            !(event.target instanceof HTMLSelectElement)
          ) {
            event.preventDefault();
            dismiss();
          }
        }}
      >
        <header className="preview-dock-heading">
          <span>
            <Icon name="panel" size={17} />
            <strong>预览</strong>
          </span>
          <div>
            {!single && (
              <button
                className="icon-button"
                aria-label={wide ? '恢复分屏' : '展开预览'}
                aria-pressed={wide}
                onClick={() => setWide(!wide)}
              >
                <Icon name={wide ? 'collapse' : 'expand'} size={16} />
              </button>
            )}
            <button
              className={single ? 'quiet-button' : 'icon-button'}
              data-preview-close
              aria-label={single ? '返回对话' : '关闭预览'}
              onClick={dismiss}
            >
              {single && '返回对话'}
              <Icon name="close" size={17} />
            </button>
          </div>
        </header>
        <div className="preview-dock-tabs" role="group" aria-label="预览内容">
          {workspaceAvailable && (
            <button
              aria-pressed={view === 'workspace'}
              onClick={() => {
                setView('workspace');
                setWorkspaceVisited(true);
                selectArtifact(null);
              }}
            >
              <Icon name="folder" size={15} />
              工作区
            </button>
          )}
          <button
            aria-pressed={view === 'artifacts'}
            onClick={() => {
              setArtifactsVisited(true);
              setView('artifacts');
            }}
          >
            <Icon name="file" size={15} />
            产物<span>{artifacts.length}</span>
          </button>
        </div>
        {workspaceVisited && (
          <Activity mode={view === 'workspace' && workspaceAvailable ? 'visible' : 'hidden'}>
            <div className="preview-dock-workspace" inert={view !== 'workspace' || !workspaceAvailable}>
              {children}
            </div>
          </Activity>
        )}
        {artifactsVisited && (
          <Activity mode={view === 'artifacts' ? 'visible' : 'hidden'}>
            <div className="preview-dock-artifacts" inert={view !== 'artifacts'}>
              {artifact ? (
                <>
                  <div className="preview-artifact-selector">
                    <Icon name="file" size={16} />
                    <select
                      aria-label="选择预览产物"
                      value={artifact.id}
                      onChange={(event) => {
                        setLastArtifactId(event.target.value);
                        selectArtifact(artifacts.find((item) => item.id === event.target.value) || null);
                      }}
                    >
                      {artifactChoices.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} · v{item.version}
                        </option>
                      ))}
                    </select>
                  </div>
                  <details className="preview-dock-identity">
                    <summary>所选产物完整信息</summary>
                    <dl
                      className="preview-dock-identity-fields"
                      role="region"
                      aria-label="所选产物完整元数据"
                      tabIndex={0}
                    >
                      <div>
                        <dt>名称</dt>
                        <dd>{artifact.name}</dd>
                      </div>
                      <div>
                        <dt>格式与版本</dt>
                        <dd>
                          {artifact.mediaType} · v{artifact.version}
                        </dd>
                      </div>
                      <div>
                        <dt>核验状态</dt>
                        <dd>{artifact.verified ? '证据已核验' : '待验收'}</dd>
                      </div>
                      <div>
                        <dt>产物标识</dt>
                        <dd>{artifact.id}</dd>
                      </div>
                      <div>
                        <dt>哈希</dt>
                        <dd>{artifact.hash}</dd>
                      </div>
                    </dl>
                  </details>
                  <ArtifactFilePreview
                    key={artifact.id}
                    id={artifact.id}
                    checkpointKey={checkpointKey}
                    resolveLogContext={allowLogContextLookup}
                    logContext={logContexts?.[artifact.id]}
                  />
                  <footer className="preview-dock-footer">
                    <span>
                      {artifact.verified ? '证据已核验' : '待验收'} · v{artifact.version}
                    </span>
                    <a
                      className="secondary"
                      href={apiUrl('/artifacts/' + artifact.id)}
                      download
                      aria-label={`下载产物 ${artifact.name}`}
                    >
                      下载产物
                      <Icon name="arrow" size={14} />
                    </a>
                  </footer>
                </>
              ) : (
                <div className="preview-empty">
                  <Icon name="file" size={28} />
                  <h3>
                    {wantedArtifactId && checkpointKey
                      ? historical?.error
                        ? '无法读取所选产物'
                        : '正在读取所选产物…'
                      : '产物将在这里交付'}
                  </h3>
                  <p
                    className={historical?.error ? 'preview-dock-read-error' : undefined}
                    role={historical?.error ? 'alert' : undefined}
                    aria-label={historical?.error ? '所选产物读取失败详情' : undefined}
                    tabIndex={historical?.error ? 0 : undefined}
                  >
                    {wantedArtifactId && checkpointKey
                      ? historical?.error || '正在核对当前任务的历史产物。'
                      : workspaceAvailable
                        ? '选择工作区可以先查看代理正在修改的文件。'
                        : '对话中交付的文件会显示在这里。'}
                  </p>
                  {historical?.error && (
                    <button
                      className="secondary"
                      onClick={() => {
                        setHistoricalArtifact(null);
                        setArtifactRetry((value) => value + 1);
                      }}
                    >
                      重试
                    </button>
                  )}
                </div>
              )}
            </div>
          </Activity>
        )}
      </aside>
    </>
  );
}
