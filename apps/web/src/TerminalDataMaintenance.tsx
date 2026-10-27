/**
 * 管理终端数据及清理操作。
 *
 * EN: Manages terminal data and maintenance actions.
 *
 * 本模块展示数据占用扫描、备份历史、恢复资格及维护计划，按当前计划身份和版本提交确认操作；本地取消与远端取消分别处理，未确认计划保留以供后续核对。
 * EN: Displays usage scans, backup history, eligibility, and maintenance plans, submitting confirmations with current plan identity/revision. Local and remote cancellation are separate; unconfirmed plans remain available for reconciliation.
 */
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
/**
 * 将字节数格式化为一位小数的 KiB 或 MiB 展示文本；假定输入是服务端给出的非负字节计数。
 * EN: Formats a server-supplied nonnegative byte count as KiB or MiB with one decimal place for display.
 */
const size = (bytes: number) =>
  bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
/**
 * 管理终端数据扫描、清理计划和会话快照。危险操作先生成计划，
 * 用户确认后通过 perform 和当前计划版本提交。
 *
 * EN: Manages scans, cleanup previews, and session snapshots; risky actions need a plan and explicit submission through perform with its revision.
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
    /**
     * 待取消集合保留尚未收到服务端确认的计划，不能因关闭预览就遗忘远端计划。
     *
     * EN: Pending cancellations retain unconfirmed remote plans even after their local preview closes.
     */
    pendingPlanCancellation = useRef(new Set<string>()),
    planCancellation = useRef<Promise<void> | null>(null);
  const selectedBackup = backups.find((backup) => backup.id === backupId);
  const planHeading = useRef<HTMLHeadingElement>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const [feedbackFocus, setFeedbackFocus] = useState<{ target: 'plan' | 'error'; origin: Element | null }>();
  /**
   * 异步结果只在焦点仍停留于触发位置时接管焦点，避免打断用户已转向的输入。
   *
   * EN: Async feedback takes focus only while the user remains at the initiating control, avoiding interruption of later input.
   */
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
  /**
   * 先清除界面上的旧计划，再串行请求取消；未确认的计划保留待下次重试。
   *
   * EN: Clears the displayed plan before serial cancellation; unconfirmed cancellations remain for a later retry.
   */
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
  /**
   * 选择、查询或目标改变后立即撤下旧预览；远端取消失败明确提示，下一次预览前重试。
   *
   * EN: Selection/query/target changes remove the old preview immediately; failed remote cancellation is shown and retried before a new preview.
   */
  function cancelPlanForChange() {
    void clearPlan().catch((issue) =>
      setError(
        '旧计划取消未确认，预览新计划前将重试。' +
          (issue instanceof Error ? issue.message : '请检查连接后重试'),
      ),
    );
  }
  /**
   * 读取一页备份历史；所选备份不在新页时清除选择并取消关联计划。
   *
   * EN: Reads one backup-history page; losing the selected backup clears selection and cancels its linked plan.
   */
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
      /**
       * 查询输入防抖；游标变化也使用同一路径，过期读取由 cleanup 中止。
       *
       * EN: Debounces query input; cursor changes share this path and cleanup aborts stale reads.
       */
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
  /**
   * 快照资格随历史版本改变而失效，不能沿用早先“可恢复”的结果生成新计划。
   *
   * EN: Backup eligibility expires when history revision changes; old restorable status cannot authorize a new plan.
   */
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
  /**
   * 当前扫描失败后中止本地轮询并尽力取消远端任务；已有取消信号的旧请求不更新界面。
   *
   * EN: On current-scan failure, stops polling and best-effort cancels the remote scan; already-aborted stale requests never update the UI.
   */
  function failedScan(controller: AbortController, issue: unknown, fallback: string) {
    if (controller.signal.aborted) return;
    const scanId = scanIdRef.current;
    controller.abort();
    scanIdRef.current = null;
    if (scanId) void api(endpoint + '/scans/' + scanId + '/cancel', {}).catch(() => {});
    setScan((current) => (current ? { ...current, status: 'failed' } : null));
    setError(issue instanceof Error ? issue.message : fallback);
  }
  /**
   * 创建扫描并每 250 毫秒读取状态；调用方负责取消已创建的服务端扫描。
   *
   * EN: Creates a scan and polls every 250 ms; the caller must cancel any created server scan.
   */
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
        /**
         * 取消扫描等待时清除延迟并拒绝当前 Promise，使轮询立即退出；远端扫描由上层负责取消。
         * EN: Clears the delay and rejects the pending wait on cancellation so polling exits immediately; the caller cancels the remote scan.
         */
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
  /**
   * 建立新的扫描身份和占位进度，取消旧读取并使任何旧维护计划失效。
   *
   * EN: Establishes a new scan identity/placeholder progress, cancelling old reads and invalidating old maintenance plans.
   */
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
  /**
   * 刷新历史首页后并行读取占用扫描和可选运行列表，成功结果才替换 overview。
   * 外部 signal 转发到本次扫描；focusFeedback 只用于用户主动刷新失败后的可访问性反馈。
   *
   * EN: After refreshing history page one, reads usage scan/run choices concurrently and replaces overview only on success. External signal forwards cancellation; focusFeedback serves accessibility feedback after an explicit refresh failure.
   */
  async function load(signal?: AbortSignal, focusFeedback = false) {
    const origin = document.activeElement;
    const controller = beginScan(),
      /**
       * 把外部读取取消传给本次扫描控制器；只停止本地请求，服务端清理由扫描取消路径处理。
       * EN: Forwards external read cancellation to this scan controller; it stops local requests while scan cancellation paths handle the server side.
       */
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
  /**
   * 先停止本地等待，再向已知服务端扫描发送取消；取消未确认时保留错误提示供刷新核验。
   *
   * EN: Stops local waiting first, then cancels a known remote scan; unconfirmed cancellation leaves an error for refresh/reconciliation.
   */
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
      /**
       * 卸载或入口客户端变化时撤销全部读取，并尽力释放已知扫描及预览计划。
       *
       * EN: Unmount/client changes cancel all reads and best-effort release known scans/previews.
       */
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
  /**
   * 必须先确认旧计划已取消，再为所选操作创建扫描预览。备份/恢复取最新运行 revision，
   * 重试清理绑定旧清理记录 revision；返回的计划是后续提交的唯一依据，不在此修改数据。
   *
   * EN: Requires confirmed cancellation of the old plan before creating a preview. Backup/restore reads the latest run revision; cleanup retry binds the prior cleanup revision. The returned plan alone authorizes later submission; this function changes no data.
   */
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
  /**
   * 按预览类型选择提交端点，只传计划 ID 与其 revision，由服务端重新核验预览前提。
   * perform 统一管理外层禁用与错误；成功后清空计划和选择并重新扫描，失败保留待核对状态。
   *
   * EN: Chooses the apply endpoint from plan kind and sends only plan ID/revision for server revalidation. perform handles outer busy/errors; success clears plan/selection and rescans, failure retains reconciliation state.
   */
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
