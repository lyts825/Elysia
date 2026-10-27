/* 展示终端安装历史及运行进度。 */
import { useEffect, useRef, useState } from 'react';
import type {
  SurfaceTerminalSettings,
  TerminalAppId,
  TerminalCliInstallationJob,
} from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';
import { TerminalInstallFailure } from './TerminalInstallFailure';
import type { TerminalCliInstallRepair } from '../../../packages/contracts/src/cli-installation';
import './terminal-install-history.css';

type Page = { items: TerminalCliInstallationJob[]; total: number; nextCursor: string | null };
const statuses = { completed: '已安装', failed: '失败', running: '安装中', cancelled: '已取消' };
const phases: Record<string, string> = {
  queued: '等待开始',
  engine: '检查 Docker',
  'base-image': '检查基础镜像',
  build: '构建镜像',
  verify: '验证 CLI',
  complete: '完成',
};
export function installationPhase(job: TerminalCliInstallationJob) {
  return phases[job.phase || 'queued'] || job.phase || '安装中';
}
export function InstallationElapsed({ job }: { job: TerminalCliInstallationJob }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((clock - Date.parse(job.phaseStartedAt || job.createdAt)) / 1000));
  return (
    <small>
      本阶段已用 {seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`}
    </small>
  );
}
export function TerminalInstallHistory({
  appId,
  settings,
  refreshKey,
  disabled,
  perform,
  saved,
  repair,
}: {
  appId: TerminalAppId;
  settings: SurfaceTerminalSettings;
  refreshKey: string;
  disabled: boolean;
  perform: (action: () => Promise<unknown>) => Promise<unknown>;
  saved: (settings: SurfaceTerminalSettings) => void;
  repair?: (job: TerminalCliInstallationJob, action: TerminalCliInstallRepair) => void;
}) {
  const { api, mutation } = useSurfaceClient();
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<Page | null>(null),
    [error, setError] = useState('');
  const [cursor, setCursor] = useState(''),
    [trail, setTrail] = useState<string[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [readRequest, setReadRequest] = useState(0);
  const [readPage, setReadPage] = useState<{ number: number; appId: TerminalAppId } | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    setBusy(true);
    void api<Page>(
      `/terminal/control/installations?limit=10&appId=${appId}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setPage(result);
          setReadPage({ number: trail.length + 1, appId });
        }
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '无法读取安装历史');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, appId, cursor, refreshKey, api, readRequest]);
  return (
    <details
      className="terminal-history-panel"
      open={open}
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary>安装历史</summary>
      <div className="terminal-history-page-heading">
        <p role="status">
          {busy
            ? '正在读取安装记录…'
            : page
              ? `本页 ${page.items.length} 条 · 共 ${page.total} 条`
              : '尚未读取安装记录'}
        </p>
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => setReadRequest((value) => value + 1)}
        >
          重新读取
        </button>
      </div>
      {page && readPage && (
        <p className="terminal-history-page-source">
          已读 {readPage.appId} 安装历史 · 第 {readPage.number} 页{error || busy ? '（保留上次结果）' : ''}
        </p>
      )}
      {error && (
        <p className="terminal-history-error" role="alert" aria-label="安装历史读取失败详情" tabIndex={0}>
          {page && <strong>仍显示上次读取的记录。 </strong>}
          {error}
        </p>
      )}
      {page?.items.map((job) => {
        const profile = job.profileId
          ? settings.profiles.find((value) => value.id === job.profileId && value.agent === appId)
          : settings.profiles.find((value) => value.id === targets[job.id] && value.agent === appId);
        return (
          <article key={job.id} className="terminal-history-record">
            <header className="terminal-history-record-heading">
              <strong
                className="terminal-history-reading"
                role="region"
                aria-label="安装记录完整版本"
                tabIndex={0}
              >
                {job.result?.version || job.requestedVersion || '预设版本'}
              </strong>
              <span className="terminal-history-status" data-status={job.status}>
                {statuses[job.status]}
              </span>
            </header>
            <p className="terminal-history-record-meta">
              <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
              <span>{installationPhase(job)}</span>
            </p>
            <details className="terminal-history-source">
              <summary>记录来源与镜像</summary>
              <dl
                className="terminal-history-reading"
                role="region"
                aria-label="安装记录完整标识与镜像"
                tabIndex={0}
              >
                <div>
                  <dt>安装标识</dt>
                  <dd>{job.id}</dd>
                </div>
                <div>
                  <dt>记录版本</dt>
                  <dd>{job.revision}</dd>
                </div>
                <div>
                  <dt>应用</dt>
                  <dd>{job.appId}</dd>
                </div>
                <div>
                  <dt>原模板标识</dt>
                  <dd>{job.profileId || '安装时未关联模板'}</dd>
                </div>
                <div>
                  <dt>基础镜像</dt>
                  <dd>{job.baseImage}</dd>
                </div>
                <div>
                  <dt>请求版本</dt>
                  <dd>{job.requestedVersion || '预设版本'}</dd>
                </div>
                {job.result && (
                  <>
                    <div>
                      <dt>已安装版本</dt>
                      <dd>{job.result.version}</dd>
                    </div>
                    <div>
                      <dt>镜像标签</dt>
                      <dd>{job.result.imageTag}</dd>
                    </div>
                    <div>
                      <dt>镜像标识</dt>
                      <dd>{job.result.image}</dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>创建时间原值</dt>
                  <dd>{job.createdAt}</dd>
                </div>
                <div>
                  <dt>更新时间原值</dt>
                  <dd>{job.updatedAt}</dd>
                </div>
              </dl>
            </details>
            {job.status !== 'failed' && job.message && (
              <p
                className="terminal-history-reading"
                role="region"
                aria-label="安装记录完整说明"
                tabIndex={0}
              >
                {job.message}
              </p>
            )}
            {job.status === 'completed' && job.result && (
              <div className="terminal-history-record-actions">
                {!job.profileId && (
                  <label className="terminal-history-target">
                    恢复目标模板
                    <select
                      aria-label="历史镜像目标模板"
                      value={targets[job.id] || ''}
                      disabled={disabled}
                      onChange={(event) =>
                        setTargets((current) => ({ ...current, [job.id]: event.target.value }))
                      }
                    >
                      <option value="">选择模板…</option>
                      {settings.profiles
                        .filter((value) => value.agent === appId)
                        .map((value) => (
                          <option key={value.id} value={value.id}>
                            {value.label}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {profile && (
                  <div
                    className="terminal-history-current-target terminal-history-reading"
                    role="region"
                    aria-label="恢复目标模板完整名称与镜像"
                    tabIndex={0}
                  >
                    <strong>{profile.label}</strong>
                    <span>当前镜像：{profile.image}</span>
                  </div>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || !profile || profile.image === job.result.image}
                  onClick={() =>
                    void perform(async () => {
                      const next = await mutation<SurfaceTerminalSettings>(
                        `/terminal/control/installations/${job.id}/restore`,
                        {
                          profileId: profile!.id,
                          expectedRevision: settings.revision,
                          expectedImage: profile!.image,
                        },
                      );
                      saved(next);
                    })
                  }
                >
                  {profile?.image === job.result.image ? '正在使用' : '恢复到模板'}
                </button>
                {job.profileId && !profile && <small>原模板已删除</small>}
              </div>
            )}
            <TerminalInstallFailure job={job} disabled={disabled} repair={repair} />
          </article>
        );
      })}
      {page && !page.items.length && <p className="field-help">暂无安装记录。</p>}
      {page && (trail.length > 0 || page.nextCursor) && (
        <nav className="terminal-history-pagination" aria-label="安装历史分页">
          <button
            type="button"
            className="secondary"
            disabled={!trail.length}
            onClick={() => {
              const next = [...trail];
              setCursor(next.pop() || '');
              setTrail(next);
            }}
          >
            上一页
          </button>
          <span>
            本页 {page.items.length} 条 · 共 {page.total} 条
          </span>
          <button
            type="button"
            className="secondary"
            disabled={!page.nextCursor}
            onClick={() => {
              setTrail([...trail, cursor]);
              setCursor(page.nextCursor!);
            }}
          >
            更早记录
          </button>
        </nav>
      )}
    </details>
  );
}
