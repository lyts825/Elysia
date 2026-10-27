/* 管理终端数据及清理操作。 */
import { useEffect, useRef, useState } from 'react';
import type { Run, RunListItem } from '../../../packages/contracts/src/index';
import type {
  TerminalMaintenanceOverview,
  TerminalMaintenancePlan,
  TerminalMaintenanceScan,
  TerminalBackupHistoryItem,
  TerminalBackupPage,
  TerminalBackupEligibility,
} from '../../../packages/contracts/src/terminal-maintenance';
import { useSurfaceClient } from './SurfaceClientContext';
import './terminal-maintenance.css';
const endpoint = '/terminal/control/maintenance';
const size = (bytes: number) =>
  bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
/**
 * 管理终端数据扫描、清理计划和会话快照。危险操作先生成计划，
 * 用户确认后通过 perform 和当前计划版本提交。
 */
export function TerminalDataMaintenance({
  disabled,
  perform,
}: {
  disabled: boolean;
  perform: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const { api, mutation } = useSurfaceClient();
  const [overview, setOverview] = useState<TerminalMaintenanceOverview | null>(null),
    [backups, setBackups] = useState<TerminalBackupHistoryItem[]>([]),
    [runs, setRuns] = useState<RunListItem[]>([]);
  const [runId, setRunId] = useState(''),
    [backupId, setBackupId] = useState(''),
    [plan, setPlan] = useState<TerminalMaintenancePlan | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [scan, setScan] = useState<TerminalMaintenanceScan | null>(null);
  const [historyQuery, setHistoryQuery] = useState(''),
    [historyCursor, setHistoryCursor] = useState<string | undefined>(),
    [historyTrail, setHistoryTrail] = useState<(string | undefined)[]>([]),
    [historyPage, setHistoryPage] = useState<TerminalBackupPage | null>(null),
    [historyBusy, setHistoryBusy] = useState(false),
    [eligibility, setEligibility] = useState<TerminalBackupEligibility | null>(null);
  const planRef = useRef<TerminalMaintenancePlan | null>(null),
    historyStarted = useRef(false),
    pendingPlanCancellation = useRef(new Set<string>()),
    planCancellation = useRef<Promise<void> | null>(null);
  const selectedBackup = backups.find((backup) => backup.id === backupId);
  const planHeading = useRef<HTMLHeadingElement>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const [feedbackFocus, setFeedbackFocus] = useState<{ target: 'plan' | 'error'; origin: Element | null }>();
  useEffect(() => {
    if (!feedbackFocus) return;
    if (document.activeElement !== document.body && document.activeElement !== feedbackFocus.origin) return;
    const target = feedbackFocus.target === 'plan' ? planHeading.current : errorElement.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }, [feedbackFocus]);
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);
  /** 先清除界面上的旧计划，再串行请求取消；未确认的计划保留待下次重试。 */
  async function clearPlan() {
    const current = planRef.current;
    planRef.current = null;
    setPlan(null);
    if (current) pendingPlanCancellation.current.add(current.id);
    if (planCancellation.current) return planCancellation.current;
    const request = (async () => {
      for (const id of pendingPlanCancellation.current) {
        await api(endpoint + '/plans/' + id + '/cancel', {});
        pendingPlanCancellation.current.delete(id);
      }
    })();
    planCancellation.current = request;
    try {
      await request;
    } finally {
      if (planCancellation.current === request) planCancellation.current = null;
    }
  }
  function cancelPlanForChange() {
    void clearPlan().catch((issue) =>
      setError(
        '旧计划取消未确认，预览新计划前将重试。' +
          (issue instanceof Error ? issue.message : '请检查连接后重试'),
      ),
    );
  }
  /** 读取一页备份历史；所选备份不在新页时清除选择并取消关联计划。 */
  async function readHistory(query: string, cursor: string | undefined, signal?: AbortSignal) {
    const params = new URLSearchParams({ query, limit: '20' });
    if (cursor) params.set('cursor', cursor);
    const next = await api<TerminalBackupPage>(
      endpoint + '/backups/page?' + params,
      undefined,
      undefined,
      signal,
    );
    if (signal?.aborted) return;
    setBackups(next.items);
    setHistoryPage(next);
    setBackupId((current) => (next.items.some((item) => item.id === current) ? current : ''));
    const currentPlan = planRef.current;
    if (currentPlan?.backupId && !next.items.some((item) => item.id === currentPlan.backupId))
      void clearPlan().catch((issue) =>
        setError(issue instanceof Error ? issue.message : '旧维护计划取消未确认'),
      );
  }
  useEffect(() => {
    if (!historyStarted.current) {
      historyStarted.current = true;
      return;
    }
    const controller = new AbortController(),
      timer = setTimeout(() => {
        setHistoryBusy(true);
        void readHistory(historyQuery, historyCursor, controller.signal)
          .catch((issue) => {
            if (!controller.signal.aborted)
              setError(issue instanceof Error ? issue.message : '无法读取快照历史');
          })
          .finally(() => {
            if (!controller.signal.aborted) setHistoryBusy(false);
          });
      }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, historyQuery, historyCursor]);
  useEffect(() => {
    setEligibility(null);
    if (!backupId) return;
    const controller = new AbortController();
    void api<TerminalBackupEligibility>(
      endpoint + '/backups/' + backupId + '/eligibility',
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setEligibility(value);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '无法确认快照资格');
      });
    return () => controller.abort();
  }, [api, backupId, historyPage?.revision]);

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
  /** 创建扫描并每 250 毫秒读取状态；调用方负责取消已创建的服务端扫描。 */
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
    void clearPlan().catch((issue) =>
      setError(issue instanceof Error ? issue.message : '无法取消旧维护计划'),
    );
    return controller;
  }
  async function load(signal?: AbortSignal, focusFeedback = false) {
    const origin = document.activeElement;
    const controller = beginScan(),
      abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await readHistory(historyQuery, undefined, controller.signal);
      setHistoryCursor(undefined);
      setHistoryTrail([]);
      const [next, conversations] = await Promise.all([
        scanRequest({ kind: 'overview' }, controller.signal),
        api<{ runs: RunListItem[] }>('/runs?limit=100', undefined, undefined, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setOverview(next.overview!);
      setRuns(conversations.runs);
    } catch (issue) {
      const showFeedback = focusFeedback && !controller.signal.aborted;
      failedScan(controller, issue, '无法读取数据占用');
      if (showFeedback) setFeedbackFocus({ target: 'error', origin });
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
      const currentPlan = planRef.current;
      if (currentPlan) pendingPlanCancellation.current.add(currentPlan.id);
      for (const id of pendingPlanCancellation.current)
        void api(endpoint + '/plans/' + id + '/cancel', {}).catch(() => {});
    };
  }, [api]);
  /** 取消旧计划后，按操作类型取得必要的运行版本并生成新预览。 */
  async function preview(
    kind: TerminalMaintenancePlan['kind'],
    retry?: TerminalMaintenanceOverview['pendingCleanup'][number],
  ) {
    const origin = document.activeElement;
    try {
      await clearPlan();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : '无法取消旧计划，请刷新后重试');
      setFeedbackFocus({ target: 'error', origin });
      return;
    }
    const controller = beginScan();
    try {
      const backup = backups.find((b) => b.id === backupId),
        selectedId = kind === 'backup' ? runId : (eligibility?.runId ?? backup?.runId);
      const selected = ['cleanup', 'delete'].includes(kind)
        ? null
        : await api<Run>('/runs/' + selectedId + '/header', undefined, undefined, controller.signal);
      const body = retry
        ? { kind: 'retry', retryId: retry.id, expectedRevision: retry.revision }
        : kind === 'cleanup'
          ? { kind }
          : kind === 'delete'
            ? { kind, backupId }
            : kind === 'backup'
              ? { kind, runId, expectedRevision: selected!.revision }
              : { kind, backupId, expectedRevision: selected!.revision };
      const result = await scanRequest(body, controller.signal);
      if (!controller.signal.aborted) {
        planRef.current = result.plan!;
        setPlan(result.plan!);
        setFeedbackFocus({ target: 'plan', origin });
      }
    } catch (issue) {
      const showFeedback = !controller.signal.aborted;
      failedScan(controller, issue, '无法生成维护计划');
      if (showFeedback) setFeedbackFocus({ target: 'error', origin });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }
  /** 按预览类型提交计划 ID 和版本，完成后重新读取维护状态。 */
  async function apply() {
    if (!plan) return;
    await perform(async () => {
      const result = await mutation<{ message?: string }>(
        endpoint +
          (plan.kind === 'cleanup'
            ? plan.retryId
              ? '/cleanup/retries/' + plan.retryId + '/apply'
              : '/cleanup/apply'
            : plan.kind === 'delete'
              ? '/backups/delete'
              : plan.kind === 'backup'
                ? '/backups/create'
                : '/backups/restore'),
        { planId: plan.id, expectedRevision: plan.revision },
      );
      setNotice(result.message || (plan.kind === 'cleanup' ? '孤立数据已清理。' : '一致会话快照已保存。'));
      setPlan(null);
      planRef.current = null;
      setBackupId('');
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
          disabled={disabled || scanning}
          onClick={() => void load(undefined, true)}
        >
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
        <p
          ref={errorElement}
          role="alert"
          className="terminal-maintenance-error"
          aria-label="终端数据维护错误"
          tabIndex={0}
        >
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
                {group.measurementReason && (
                  <small
                    className="terminal-maintenance-reading"
                    role="region"
                    aria-label={`${group.label}占用说明`}
                    tabIndex={0}
                  >
                    {group.measurementReason}
                  </small>
                )}
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
                  <p
                    className="terminal-maintenance-reading"
                    role="region"
                    aria-label="暂存清理完整说明"
                    tabIndex={0}
                  >
                    {item.message}
                  </p>
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
            <div
              className="terminal-maintenance-reading"
              role="region"
              aria-label="会话归属与保留原因全文"
              tabIndex={0}
            >
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
            </div>
          </details>
          <div className="terminal-data-backups">
            <h4>会话快照</h4>
            <p className="field-help">
              含私有 CLI 会话与业务文件；不含密钥库、CLI
              认证配置、环境文件和镜像。业务文件内自行嵌入的秘密无法识别。仅同机、同任务与当前最新轮次可恢复，普通数据库备份不能恢复
              CLI 会话。
            </p>
            <section className="terminal-backup-section" aria-label="创建会话快照">
              <h5>创建快照</h5>
              <label>
                已停止的可靠 Codex 会话
                <select
                  aria-label="备份终端会话"
                  value={runId}
                  disabled={disabled || scanning}
                  onChange={(e) => {
                    setRunId(e.target.value);
                    void clearPlan().catch((issue) =>
                      setError(issue instanceof Error ? issue.message : '取消计划失败'),
                    );
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
              {runId && (
                <p className="terminal-maintenance-selected-title">
                  已选会话：
                  {runs.find((run) => run.id === runId)?.title ||
                    runs.find((run) => run.id === runId)?.objective ||
                    overview.sessions.find((session) => session.runId === runId)?.taskId}
                </p>
              )}
              <button
                type="button"
                className="secondary"
                disabled={disabled || scanning || !runId}
                onClick={() => void preview('backup')}
              >
                预览备份
              </button>
            </section>
            <section className="terminal-backup-section" aria-label="恢复与删除会话快照">
              <h5>快照历史</h5>
              <label>
                快照历史搜索
                <input
                  aria-label="搜索快照历史"
                  maxLength={200}
                  value={historyQuery}
                  disabled={disabled || scanning}
                  placeholder="标题、任务或快照 ID"
                  onChange={(event) => {
                    setHistoryQuery(event.target.value);
                    setHistoryCursor(undefined);
                    setHistoryTrail([]);
                    setBackupId('');
                    cancelPlanForChange();
                  }}
                />
              </label>
              <p className="field-help">
                {historyBusy
                  ? '正在读取快照历史…'
                  : `共 ${historyPage?.total ?? 0} 份，当前页 ${backups.length} 份`}
              </p>
              <nav className="terminal-backup-pages" aria-label="快照历史分页">
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || scanning || historyBusy || !historyTrail.length}
                  onClick={() => {
                    setHistoryCursor(historyTrail.at(-1));
                    setHistoryTrail((values) => values.slice(0, -1));
                    setBackupId('');
                    cancelPlanForChange();
                  }}
                >
                  较新快照
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || scanning || historyBusy || !historyPage?.page.hasMore}
                  onClick={() => {
                    setHistoryTrail((values) => [...values, historyCursor]);
                    setHistoryCursor(historyPage?.page.nextCursor ?? undefined);
                    setBackupId('');
                    cancelPlanForChange();
                  }}
                >
                  更早快照
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || scanning || historyBusy || !historyTrail.length}
                  onClick={() => {
                    setHistoryCursor(undefined);
                    setHistoryTrail([]);
                    setBackupId('');
                    cancelPlanForChange();
                  }}
                >
                  返回最新
                </button>
              </nav>
              <label>
                同机快照
                <select
                  aria-label="恢复终端快照"
                  value={backupId}
                  disabled={disabled || scanning}
                  onChange={(e) => {
                    setBackupId(e.target.value);
                    void clearPlan().catch((issue) =>
                      setError(issue instanceof Error ? issue.message : '取消计划失败'),
                    );
                  }}
                >
                  <option value="">选择快照…</option>
                  {backups.map((b) => (
                    <option key={b.id} value={b.id}>
                      {new Date(b.createdAt).toLocaleString()} · {b.title || b.taskId} · {size(b.bytes)}
                      {b.consistent ? '' : ' · 恢复前保全（不可续接）'}
                    </option>
                  ))}
                </select>
              </label>
              {selectedBackup && (
                <div className="terminal-backup-selection" aria-label="选定快照详情">
                  <strong>{selectedBackup.title || selectedBackup.taskId}</strong>
                  <dl>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{new Date(selectedBackup.createdAt).toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>文件占用</dt>
                      <dd>
                        {size(selectedBackup.bytes)} · {selectedBackup.files} 个文件
                      </dd>
                    </div>
                    <div>
                      <dt>快照类型</dt>
                      <dd>{selectedBackup.consistent ? '一致会话快照' : '恢复前保全（不可续接）'}</dd>
                    </div>
                    <div>
                      <dt>快照 ID</dt>
                      <dd>
                        <code>{selectedBackup.id}</code>
                      </dd>
                    </div>
                  </dl>
                </div>
              )}
              <button
                type="button"
                className="secondary"
                disabled={disabled || scanning || historyBusy || !eligibility?.canRestore}
                onClick={() => void preview('restore')}
              >
                预览恢复
              </button>
              {backupId && (
                <div className="terminal-backup-eligibility" role="status" aria-label="当前快照恢复资格">
                  <p>{eligibility?.message ?? '正在检查当前恢复资格…'}</p>
                  {eligibility && <small>{eligibility.deleteReason}</small>}
                </div>
              )}
              <button
                type="button"
                className="secondary danger"
                disabled={disabled || scanning || historyBusy || !eligibility?.canDelete}
                onClick={() => void preview('delete')}
              >
                预览删除快照
              </button>
            </section>
          </div>
        </>
      )}
      {plan && (
        <div className="terminal-maintenance-plan" role="region" aria-label="维护计划预览">
          <h4 ref={planHeading} tabIndex={-1}>
            {plan.kind === 'cleanup'
              ? plan.retryId
                ? '暂存重试计划'
                : '清理计划'
              : plan.kind === 'backup'
                ? '备份计划'
                : plan.kind === 'delete'
                  ? '快照删除计划'
                  : '恢复计划'}{' '}
            <span>
              {plan.items.length} 项 · {size(plan.bytes)}
            </span>
          </h4>
          <div
            className="terminal-maintenance-reading terminal-maintenance-items"
            role="region"
            aria-label="维护计划完整文件清单"
            tabIndex={0}
          >
            {plan.items.map((item) => (
              <p key={item.kind + item.ref}>
                <code>{item.ref}</code>
                <span>{size(item.bytes)}</span>
              </p>
            ))}
            {!plan.items.length && <p>没有可证明孤立的数据。</p>}
          </div>
          {plan.warnings.length > 0 && (
            <div
              className="terminal-maintenance-reading terminal-maintenance-warnings"
              role="region"
              aria-label="维护计划完整注意事项"
              tabIndex={0}
            >
              {plan.warnings.map((warning) => (
                <p className="field-help" key={warning}>
                  {warning}
                </p>
              ))}
            </div>
          )}
          <div className="terminal-control-form-actions">
            <button
              className="secondary"
              type="button"
              disabled={disabled || scanning}
              onClick={() =>
                void clearPlan().catch((issue) =>
                  setError(issue instanceof Error ? issue.message : '无法取消计划'),
                )
              }
            >
              取消计划
            </button>
            <button
              className={'primary' + (['cleanup', 'delete'].includes(plan.kind) ? ' danger-confirm' : '')}
              type="button"
              disabled={disabled || scanning || (!plan.items.length && plan.kind === 'cleanup')}
              onClick={() => void apply()}
            >
              {plan.kind === 'cleanup'
                ? '确认清理'
                : plan.kind === 'backup'
                  ? '创建一致快照'
                  : plan.kind === 'delete'
                    ? '确认删除快照'
                    : '确认恢复文件'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
