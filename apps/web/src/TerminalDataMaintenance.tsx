import { useEffect, useRef, useState } from 'react';
import type { Run, RunListItem } from '../../../packages/contracts/src/index';
import type {
  TerminalMaintenanceOverview,
  TerminalMaintenancePlan,
  TerminalMaintenanceScan,
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
  const [scan, setScan] = useState<TerminalMaintenanceScan | null>(null);
  const controllerRef = useRef<AbortController | null>(null),
    scanIdRef = useRef<string | null>(null);
  const scanning = scan?.status === 'running';
  function failedScan(controller: AbortController, issue: unknown, fallback: string) {
    if (controller.signal.aborted) return;
    const scanId = scanIdRef.current;
    controller.abort();
    scanIdRef.current = null;
    if (scanId) void api(endpoint + '/scans/' + scanId + '/cancel', {}).catch(() => {});
    setScan((current) => (current ? { ...current, status: 'failed' } : null));
    setError(issue instanceof Error ? issue.message : fallback);
  }
  async function scanRequest(body: Record<string, unknown>, signal: AbortSignal) {
    let current = await api<TerminalMaintenanceScan>(endpoint + '/scans', body, undefined, signal);
    scanIdRef.current = current.id;
    if (signal.aborted) {
      void api(endpoint + '/scans/' + current.id + '/cancel', {}).catch(() => {});
      throw new DOMException('已取消', 'AbortError');
    }
    setScan(current);
    while (current.status === 'running') {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('已取消', 'AbortError'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, 250);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      current = await api<TerminalMaintenanceScan>(
        endpoint + '/scans/' + current.id,
        undefined,
        undefined,
        signal,
      );
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      setScan(current);
    }
    scanIdRef.current = null;
    if (current.status !== 'completed') throw new Error(current.message || '维护扫描未完成');
    return current;
  }
  function beginScan() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setScan({
      id: '',
      kind: 'overview',
      status: 'running',
      phase: 'references',
      filesVisited: 0,
      bytesProcessed: 0,
      groupsCompleted: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    setError('');
    setNotice('');
    setPlan(null);
    return controller;
  }
  async function load(signal?: AbortSignal) {
    const controller = beginScan(),
      abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const [next, history, conversations] = await Promise.all([
        scanRequest({ kind: 'overview' }, controller.signal),
        api<TerminalSessionBackupView[]>(endpoint + '/backups', undefined, undefined, controller.signal),
        api<{ runs: RunListItem[] }>('/runs?limit=100', undefined, undefined, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setOverview(next.overview!);
      setBackups(history);
      setRuns(conversations.runs);
    } catch (issue) {
      failedScan(controller, issue, '无法读取数据占用');
    } finally {
      signal?.removeEventListener('abort', abort);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }
  async function cancelScan() {
    const scanId = scanIdRef.current;
    controllerRef.current?.abort();
    controllerRef.current = null;
    scanIdRef.current = null;
    setScan((current) => (current ? { ...current, status: 'cancelled' } : null));
    setNotice('扫描已取消，未生成计划或修改文件。');
    if (scanId)
      await api(endpoint + '/scans/' + scanId + '/cancel', {}).catch(() =>
        setError('取消请求未确认；请刷新后检查扫描状态'),
      );
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      controllerRef.current?.abort();
      const scanId = scanIdRef.current;
      if (scanId) void api(endpoint + '/scans/' + scanId + '/cancel', {}).catch(() => {});
    };
  }, [api]);
  async function preview(
    kind: TerminalMaintenancePlan['kind'],
    retry?: TerminalMaintenanceOverview['pendingCleanup'][number],
  ) {
    const controller = beginScan();
    try {
      const backup = backups.find((b) => b.id === backupId),
        selectedId = kind === 'backup' ? runId : backup?.runId;
      const selected =
        kind === 'cleanup'
          ? null
          : await api<Run>('/runs/' + selectedId + '/header', undefined, undefined, controller.signal);
      const body = retry
        ? { kind: 'retry', retryId: retry.id, expectedRevision: retry.revision }
        : kind === 'cleanup'
          ? { kind }
          : kind === 'backup'
            ? { kind, runId, expectedRevision: selected!.revision }
            : { kind, backupId, expectedRevision: selected!.revision };
      const result = await scanRequest(body, controller.signal);
      if (!controller.signal.aborted) setPlan(result.plan!);
    } catch (issue) {
      failedScan(controller, issue, '无法生成维护计划');
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }
  async function apply() {
    if (!plan) return;
    await perform(async () => {
      const result = await mutation<{ message?: string }>(
        endpoint +
          (plan.kind === 'cleanup'
            ? plan.retryId
              ? '/cleanup/retries/' + plan.retryId + '/apply'
              : '/cleanup/apply'
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
        <button className="secondary" disabled={disabled || scanning} onClick={() => void load()}>
          刷新占用
        </button>
      </div>
      {scanning && scan && (
        <div className="terminal-maintenance-scan" role="status" aria-label="维护扫描进度">
          <span>
            {
              (
                {
                  references: '检查引用',
                  sessions: '扫描会话',
                  storage: '扫描占用',
                  ownership: '核对归属',
                  hashing: '校验文件摘要',
                  verification: '复核版本',
                  complete: '已完成',
                } as const
              )[scan.phase]
            }{' '}
            · {scan.filesVisited} 个文件
            {scan.bytesProcessed > 0 ? ' · 已读取 ' + size(scan.bytesProcessed) : ''}
          </span>
          <button type="button" className="secondary" onClick={() => void cancelScan()}>
            取消扫描
          </button>
        </div>
      )}
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
                <span>
                  {group.coverage === 'unknown'
                    ? '占用未知'
                    : (group.coverage === 'partial' ? '至少 ' : '') + size(group.bytes)}
                </span>
                <small>
                  {group.coverage === 'complete'
                    ? '完整计入'
                    : group.coverage === 'partial'
                      ? '部分计入'
                      : '未计入'}
                  {group.coverage !== 'unknown' ? ' · ' + group.files + ' 个文件' : ''}
                </small>
                {group.measurementReason && <small>{group.measurementReason}</small>}
              </div>
            ))}
          </div>
          <p className="field-help">
            {overview.coverage === 'complete' ? '维护范围已完整计入' : '占用仅为已计入部分'}{' '}
            {size(overview.totalBytes)}。凭据库只保留，不读取内容；未知占用未计入合计。
          </p>
          <button
            type="button"
            className="secondary"
            disabled={disabled || scanning}
            onClick={() => void preview('cleanup')}
          >
            预览可清理项
          </button>
          {overview.pendingCleanup.length > 0 && (
            <div className="terminal-pending-cleanup">
              <h4>待完成的暂存清理</h4>
              {overview.pendingCleanup.map((item) => (
                <div key={item.id}>
                  <p>
                    {new Date(item.createdAt).toLocaleString()} · {item.items} 项 · {size(item.bytes)}
                  </p>
                  <p className="field-help">{item.message}</p>
                  <button
                    className="secondary"
                    type="button"
                    disabled={disabled || scanning}
                    onClick={() => void preview('cleanup', item)}
                  >
                    预览重试清理
                  </button>
                </div>
              ))}
            </div>
          )}
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
                  {session.coverage === 'unknown'
                    ? '占用未知'
                    : (session.coverage === 'partial' ? '至少 ' : '') + size(session.bytes)}{' '}
                  · {session.reason}
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
                disabled={disabled || scanning}
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
              disabled={disabled || scanning || !runId}
              onClick={() => void preview('backup')}
            >
              预览备份
            </button>
            <label>
              同机快照
              <select
                aria-label="恢复终端快照"
                value={backupId}
                disabled={disabled || scanning}
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
              disabled={disabled || scanning || !backups.find((b) => b.id === backupId)?.consistent}
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
            {plan.kind === 'cleanup'
              ? plan.retryId
                ? '暂存重试计划'
                : '清理计划'
              : plan.kind === 'backup'
                ? '备份计划'
                : '恢复计划'}{' '}
            · {size(plan.bytes)}
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
            <button
              className="secondary"
              type="button"
              disabled={disabled || scanning}
              onClick={() => setPlan(null)}
            >
              取消计划
            </button>
            <button
              className="primary"
              type="button"
              disabled={disabled || scanning || (!plan.items.length && plan.kind === 'cleanup')}
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
