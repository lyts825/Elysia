import { useEffect, useState } from 'react';
import type { Run, RunListItem } from '../../../packages/contracts/src/index';
import type {
  TerminalMaintenanceOverview,
  TerminalMaintenancePlan,
  TerminalSessionBackupView,
} from '../../../packages/contracts/src/terminal-maintenance';
import { useSurfaceClient } from './SurfaceClientContext';
const endpoint = '/terminal/control/maintenance';
const size = (bytes: number) =>
  bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
export function TerminalDataMaintenance({
  disabled,
  perform,
}: {
  disabled: boolean;
  perform: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const { api, mutation } = useSurfaceClient();
  const [overview, setOverview] = useState<TerminalMaintenanceOverview | null>(null),
    [backups, setBackups] = useState<TerminalSessionBackupView[]>([]),
    [runs, setRuns] = useState<RunListItem[]>([]);
  const [runId, setRunId] = useState(''),
    [backupId, setBackupId] = useState(''),
    [plan, setPlan] = useState<TerminalMaintenancePlan | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function load(signal?: AbortSignal) {
    const [next, history, conversations] = await Promise.all([
      api<TerminalMaintenanceOverview>(endpoint, undefined, undefined, signal),
      api<TerminalSessionBackupView[]>(endpoint + '/backups', undefined, undefined, signal),
      api<{ runs: RunListItem[] }>('/runs?limit=100', undefined, undefined, signal),
    ]);
    if (signal?.aborted) return;
    setOverview(next);
    setBackups(history);
    setRuns(conversations.runs);
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((issue) => {
      if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '无法读取数据占用');
    });
    return () => controller.abort();
  }, [api]);
  async function preview(kind: TerminalMaintenancePlan['kind']) {
    await perform(async () => {
      setError('');
      setNotice('');
      setPlan(null);
      const backup = backups.find((b) => b.id === backupId);
      const selectedId = kind === 'backup' ? runId : backup?.runId;
      const selected = kind === 'cleanup' ? null : await api<Run>('/runs/' + selectedId + '/header');
      const body =
        kind === 'cleanup'
          ? {}
          : kind === 'backup'
            ? { runId, expectedRevision: selected!.revision }
            : { backupId, expectedRevision: selected!.revision };
      setPlan(
        await api<TerminalMaintenancePlan>(
          endpoint +
            (kind === 'cleanup'
              ? '/cleanup/plan'
              : kind === 'backup'
                ? '/backups/plan'
                : '/backups/restore/plan'),
          body,
        ),
      );
    });
  }
  async function apply() {
    if (!plan) return;
    await perform(async () => {
      const result = await mutation<{ message?: string }>(
        endpoint +
          (plan.kind === 'cleanup'
            ? '/cleanup/apply'
            : plan.kind === 'backup'
              ? '/backups/create'
              : '/backups/restore'),
        { planId: plan.id, expectedRevision: plan.revision },
      );
      setNotice(result.message || (plan.kind === 'cleanup' ? '孤立数据已清理。' : '一致会话快照已保存。'));
      setPlan(null);
      await load();
    });
  }
  return (
    <section className="terminal-data-maintenance">
      <div className="terminal-control-heading">
        <div>
          <h3>终端数据维护</h3>
          <p>只操作本入口的已停止会话。工作区、冻结镜像及未知数据不参与清理。</p>
        </div>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() =>
            void perform(async () => {
              setPlan(null);
              await load();
            })
          }
        >
          刷新占用
        </button>
      </div>
      {error && (
        <p role="alert" className="cli-app-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="terminal-control-notice">
          {notice}
        </p>
      )}
      {overview && (
        <>
          <div className="terminal-data-groups">
            {overview.groups.map((group) => (
              <div key={group.id}>
                <strong>{group.label}</strong>
                <span>{size(group.bytes)}</span>
                <small>{group.files} 个文件</small>
              </div>
            ))}
          </div>
          <p className="field-help">
            已计入 {size(overview.totalBytes)}。凭据库只保留，不读取内容；大目录或链接占用可能未计入。
          </p>
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            onClick={() => void preview('cleanup')}
          >
            预览可清理项
          </button>
          <details className="terminal-data-references">
            <summary>会话归属与保留原因（{overview.sessions.length}）</summary>
            {overview.sessions.map((session) => (
              <p key={session.taskId}>
                <strong>
                  {runs.find((r) => r.id === session.runId)?.title ||
                    runs.find((r) => r.id === session.runId)?.objective ||
                    session.taskId}
                </strong>
                <span>
                  {size(session.bytes)} · {session.reason}
                </span>
              </p>
            ))}
            {overview.preserved.map((item) => (
              <p key={item.path}>
                <code>{item.path}</code>
                <span>{item.reason}</span>
              </p>
            ))}
          </details>
          <div className="terminal-data-backups">
            <h4>选定会话快照</h4>
            <p className="field-help">
              含私有 CLI 会话与业务文件；不含密钥库、CLI
              认证配置、环境文件和镜像。业务文件内自行嵌入的秘密无法识别。仅同机、同任务与当前最新轮次可恢复，普通数据库备份不能恢复
              CLI 会话。
            </p>
            <label>
              已停止的可靠 Codex 会话
              <select
                aria-label="备份终端会话"
                value={runId}
                disabled={disabled}
                onChange={(e) => {
                  setRunId(e.target.value);
                  setPlan(null);
                }}
              >
                <option value="">选择会话…</option>
                {overview.sessions
                  .filter((s) => s.backupEligible && s.runId)
                  .map((s) => (
                    <option key={s.taskId} value={s.runId!}>
                      {runs.find((r) => r.id === s.runId)?.title ||
                        runs.find((r) => r.id === s.runId)?.objective ||
                        s.taskId}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={disabled || !runId}
              onClick={() => void preview('backup')}
            >
              预览备份
            </button>
            <label>
              同机快照
              <select
                aria-label="恢复终端快照"
                value={backupId}
                disabled={disabled}
                onChange={(e) => {
                  setBackupId(e.target.value);
                  setPlan(null);
                }}
              >
                <option value="">选择快照…</option>
                {backups.map((b) => (
                  <option key={b.id} value={b.id} disabled={!b.consistent}>
                    {new Date(b.createdAt).toLocaleString()} ·{' '}
                    {runs.find((r) => r.id === b.runId)?.title || b.taskId} · {size(b.bytes)}
                    {b.consistent ? '' : ' · 恢复前保全（不可续接）'}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={disabled || !backups.find((b) => b.id === backupId)?.consistent}
              onClick={() => void preview('restore')}
            >
              预览恢复
            </button>
          </div>
        </>
      )}
      {plan && (
        <div className="terminal-maintenance-plan" role="region" aria-label="维护计划预览">
          <h4>
            {plan.kind === 'cleanup' ? '清理计划' : plan.kind === 'backup' ? '备份计划' : '恢复计划'} ·{' '}
            {size(plan.bytes)}
          </h4>
          {plan.items.map((item) => (
            <p key={item.kind + item.ref}>
              <code>{item.ref}</code>
              <span>{size(item.bytes)}</span>
            </p>
          ))}
          {!plan.items.length && <p>没有可证明孤立的数据。</p>}
          {plan.warnings.map((warning) => (
            <p className="field-help" key={warning}>
              {warning}
            </p>
          ))}
          <div className="terminal-control-form-actions">
            <button className="secondary" type="button" disabled={disabled} onClick={() => setPlan(null)}>
              取消计划
            </button>
            <button
              className="primary"
              type="button"
              disabled={disabled || (!plan.items.length && plan.kind === 'cleanup')}
              onClick={() => void apply()}
            >
              {plan.kind === 'cleanup'
                ? '确认清理'
                : plan.kind === 'backup'
                  ? '创建一致快照'
                  : '确认恢复文件'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
