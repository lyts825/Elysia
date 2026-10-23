import { useEffect, useId, useRef, useState } from 'react';
import type { ProjectScheduleHistory as HistoryPage } from '../../../packages/contracts/src/project-schedules';
import { executionLabel } from './ProjectRunList';
import { useSurfaceClient } from './SurfaceClientContext';
import './project-schedule-history.css';

type Props = {
  projectId: string;
  scheduleId: string;
  name: string;
  close: () => void;
  openRun: (id: string) => Promise<void>;
};
type Position = { before: string | null; trail: (string | null)[] };
type Display = { page: HistoryPage; position: Position; receivedAt: string };
const first = (): Position => ({ before: null, trail: [] });
const message = (error: unknown) => (error instanceof Error ? error.message : '历史读取失败，请重试。');

export function ProjectScheduleHistory(props: Props) {
  const { surface } = useSurfaceClient();
  return <ScheduleHistory key={`${surface}:${props.projectId}:${props.scheduleId}`} {...props} />;
}

function ScheduleHistory({ projectId, scheduleId, name, close, openRun }: Props) {
  const { api } = useSurfaceClient();
  const identity = useId();
  const [display, setDisplay] = useState<Display>();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed' | 'cancelled'>('loading');
  const [readError, setReadError] = useState(''),
    [openError, setOpenError] = useState('');
  const [opening, setOpening] = useState('');
  const reader = useRef<AbortController | null>(null),
    live = useRef(true),
    target = useRef<Position>(first());

  async function read(position: Position) {
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    target.current = position;
    setPhase('loading');
    setReadError('');
    const query = new URLSearchParams();
    if (position.before) query.set('before', position.before);
    try {
      const page = await api<HistoryPage>(
        `/projects/${projectId}/schedules/${scheduleId}/history${query.size ? '?' + query : ''}`,
        undefined,
        undefined,
        controller.signal,
      );
      if (!live.current || controller.signal.aborted || reader.current !== controller) return;
      if (
        !page ||
        page.projectId !== projectId ||
        page.scheduleId !== scheduleId ||
        !page.page ||
        page.page.before !== position.before ||
        !page.coverage ||
        typeof page.coverage.complete !== 'boolean' ||
        !Array.isArray(page.items) ||
        page.items.length > 20 ||
        page.items.some((item) => !item || typeof item.dispatchId !== 'string')
      )
        throw Error('历史记录与当前项目、定时任务或页码不一致，请重新读取。');
      setDisplay({ page, position, receivedAt: new Date().toISOString() });
      setPhase('ready');
    } catch (error) {
      if (live.current && !controller.signal.aborted && reader.current === controller) {
        setPhase('failed');
        setReadError(message(error));
      }
    }
  }
  useEffect(() => {
    live.current = true;
    void read(first());
    return () => {
      live.current = false;
      reader.current?.abort();
    };
  }, [api, projectId, scheduleId]);
  async function navigate(id: string) {
    if (opening) return;
    setOpening(id);
    setOpenError('');
    try {
      await openRun(id);
    } catch (error) {
      if (live.current) setOpenError(message(error));
    } finally {
      if (live.current) setOpening('');
    }
  }
  const page = display?.page,
    position = display?.position ?? first(),
    loading = phase === 'loading';
  return (
    <section className="schedule-history" aria-label="定时任务创建历史">
      <header>
        <div>
          <h3>创建历史</h3>
          <p>{name}</p>
        </div>
        <button type="button" className="text-button" onClick={close}>
          收起创建历史
        </button>
      </header>
      <p className="field-help">
        这里展示此定时任务精确关联的创建记录与当前任务状态。已删除或无法读取的记录会说明缺口；不按同名任务推断归属。
      </p>
      <div className="schedule-actions">
        <button type="button" className="secondary" disabled={loading} onClick={() => void read(first())}>
          刷新创建历史
        </button>
        {loading && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              reader.current?.abort();
              setPhase('cancelled');
              setReadError('历史读取已取消，保留上次成功页；可重试本次读取。');
            }}
          >
            取消历史读取
          </button>
        )}
        {(phase === 'failed' || phase === 'cancelled') && (
          <button type="button" className="secondary" onClick={() => void read(target.current)}>
            重试历史读取
          </button>
        )}
      </div>
      {loading && <p role="status">正在读取创建历史…{display ? '暂时显示上次成功页。' : ''}</p>}
      {readError && (
        <p className="field-error schedule-history-error" role="alert" aria-label="创建历史读取问题全文">
          历史读取问题：{readError}
        </p>
      )}
      {openError && (
        <p className="field-error schedule-history-error" role="alert" aria-label="历史任务打开失败详情">
          打开任务失败：{openError}
        </p>
      )}
      {display && page && (
        <>
          <p className="field-help">
            {phase === 'ready' ? '读取于' : '上次成功读取于'} {new Date(display.receivedAt).toLocaleString()}{' '}
            · 第 {position.trail.length + 1} 页 · 已读定时任务版本 {page.scheduleRevision}
          </p>
          <dl className="schedule-history-summary">
            <div>
              <dt>累计创建</dt>
              <dd>{page.createdCount} 次</dd>
            </div>
            <div>
              <dt>已读记录</dt>
              <dd>{page.coverage.retainedDispatches} 条</dd>
            </div>
            <div>
              <dt>可定位任务</dt>
              <dd>{page.coverage.traceableRuns} 个</dd>
            </div>
          </dl>
          {!page.coverage.complete && (
            <p className="schedule-history-notice" role="status">
              {page.coverage.message}
            </p>
          )}
          {page.coverage.missingDispatches > 0 && (
            <p className="field-help">
              有 {page.coverage.missingDispatches} 次创建已无可追溯记录，无法还原其内容。
            </p>
          )}
          {!page.items.length && (
            <p>{page.createdCount ? '当前页没有现存创建记录。' : '尚未通过此定时任务创建任务。'}</p>
          )}
          <ol className="schedule-history-items">
            {page.items.map((item, index) => (
              <li key={item.dispatchId} data-unavailable={!item.run || undefined}>
                <p className="field-help">
                  调度时段：{item.dueAt ? new Date(item.dueAt).toLocaleString() : '无法读取'}
                </p>
                {item.run ? (
                  <>
                    <strong className="schedule-history-title" id={`${identity}-run-${index}`}>
                      {item.run.title}
                    </strong>
                    <p className="schedule-history-status" data-state={item.run.status}>
                      {executionLabel(item.run.status)}
                      {item.run.reason === 'paused' ? ' · 已暂停' : ''}
                      {item.run.archived ? ' · 已归档' : ''}
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={!!opening}
                      aria-describedby={`${identity}-run-${index}`}
                      onClick={() => void navigate(item.run!.id)}
                    >
                      {opening === item.run.id ? '正在打开任务…' : '打开历史任务'}
                    </button>
                  </>
                ) : (
                  <p>此条记录暂时无法定位任务。</p>
                )}
                {item.issue && <p className="schedule-history-issue">{item.issue.message}</p>}
                <details className="schedule-history-origin">
                  <summary>创建记录完整标识与时间</summary>
                  <dl>
                    <div>
                      <dt>调度记录</dt>
                      <dd>{item.dispatchId}</dd>
                    </div>
                    <div>
                      <dt>调度时间原值</dt>
                      <dd>{item.dueAt || '未记录'}</dd>
                    </div>
                    {item.run && (
                      <>
                        <div>
                          <dt>任务标识</dt>
                          <dd>{item.run.id}</dd>
                        </div>
                        <div>
                          <dt>任务创建时间原值</dt>
                          <dd>{item.run.createdAt}</dd>
                        </div>
                      </>
                    )}
                  </dl>
                </details>
              </li>
            ))}
          </ol>
          <nav className="schedule-history-pagination" aria-label="创建历史分页">
            <span>
              第 {position.trail.length + 1} 页 · 本页 {page.items.length} 条
            </span>
            <div className="schedule-history-page-actions">
              <button
                type="button"
                className="secondary"
                disabled={loading || !position.trail.length}
                onClick={() =>
                  void read({ before: position.trail.at(-1) ?? null, trail: position.trail.slice(0, -1) })
                }
              >
                上一页历史
              </button>
              <button
                type="button"
                className="secondary"
                disabled={phase !== 'ready' || !page.page.hasMore || !page.page.nextBefore}
                onClick={() =>
                  void read({ before: page.page.nextBefore, trail: [...position.trail, position.before] })
                }
              >
                下一页历史
              </button>
            </div>
          </nav>
        </>
      )}
    </section>
  );
}
