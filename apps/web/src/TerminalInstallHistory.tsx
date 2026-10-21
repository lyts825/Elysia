import { useEffect, useRef, useState } from 'react';
import type {
  SurfaceTerminalSettings,
  TerminalAppId,
  TerminalCliInstallationJob,
} from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';
import { TerminalInstallFailure } from './TerminalInstallFailure';
import type { TerminalCliInstallRepair } from '../../../packages/contracts/src/cli-installation';

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
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    void api<Page>(
      `/terminal/control/installations?limit=10&appId=${appId}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '无法读取安装历史');
      });
    return () => controller.abort();
  }, [open, appId, cursor, refreshKey, api]);
  return (
    <details
      className="terminal-install-history"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>安装历史</summary>
      {page?.items.map((job) => {
        const profile = job.profileId
          ? settings.profiles.find((value) => value.id === job.profileId && value.agent === appId)
          : settings.profiles.find((value) => value.id === targets[job.id] && value.agent === appId);
        return (
          <article key={job.id} className="terminal-install-record">
            <header className="terminal-install-record-heading">
              <strong>{job.result?.version || job.requestedVersion || '预设版本'}</strong>
              <span className="terminal-install-status" data-status={job.status}>
                {statuses[job.status]}
              </span>
            </header>
            <p className="terminal-install-record-meta">
              <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
              <span>{installationPhase(job)}</span>
            </p>
            {job.status === 'completed' && job.result && (
              <div className="terminal-install-record-actions">
                {!job.profileId && (
                  <label className="terminal-install-target">
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
      {error && (
        <p className="terminal-install-error" role="alert" aria-label="安装历史读取失败详情" tabIndex={0}>
          {page && <strong>仍显示上次读取的记录。 </strong>}
          {error}
        </p>
      )}
      {page && (trail.length > 0 || page.nextCursor) && (
        <nav className="terminal-install-pagination" aria-label="安装历史分页">
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
          <span>共 {page.total} 条</span>
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
