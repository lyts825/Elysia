import { useEffect, useState } from 'react';
import type { Message, Operation, Task, ToolCall } from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';
import { Icon } from './Icon';
import './tool-activity.css';

const toolNames: Record<string, string> = {
  load_skill: '加载技能',
  list: '浏览目录',
  read: '读取文件',
  read_artifact: '读取产物',
  search: '搜索文件',
  write: '写入文件',
  apply_patch: '修改文件',
  exec: '执行命令',
  fetch_url: '读取网页',
  artifact: '登记产物',
  diff: '生成差异',
  integrate_worktrees: '集成子任务更改',
  clarify: '提出问题',
  propose_plan: '提出计划',
  spawn_task: '创建子任务',
  join_tasks: '等待子任务',
  submit_result: '提交验收结果',
};
const fieldNames: Record<string, string> = {
  id: '技能',
  path: '路径',
  program: '程序',
  args: '程序参数',
  cwd: '工作目录',
  timeout: '超时限制（毫秒）',
  outputLimit: '输出上限（字节）',
  query: '搜索内容',
  url: '网页地址',
  name: '名称',
  content: '内容',
  oldText: '原文',
  newText: '替换内容',
  questions: '问题',
  title: '标题',
  objective: '目标',
  summary: '摘要',
  deliverables: '交付物',
  acceptanceCriteria: '验收标准',
  evidence: '验证证据',
  incomplete: '未完成事项',
  source: '来源',
  bytes: '大小（字节）',
  exitCode: '退出码',
  stdout: '输出',
  stderr: '错误输出',
  timedOut: '是否超时',
  truncated: '内容是否截断',
  error: '错误原因',
  entries: '文件列表',
  matches: '搜索结果',
  inspected: '已检查文件数',
  directory: '是否为目录',
  symlink: '是否为链接',
  binary: '是否为二进制文件',
  line: '行号',
  text: '文本',
  mediaType: '文件格式',
  verified: '是否已核验',
  verifiedAt: '核验时间',
  version: '版本',
  limitation: '核验范围',
};
const internalFields = new Set([
  'id',
  'runId',
  'taskId',
  'taskIds',
  'agentId',
  'attemptId',
  'operationId',
  'toolCallId',
  'artifactId',
  'snapshotId',
  'snapshotIds',
  'sessionId',
  'eventId',
  'commandId',
  'revision',
  'objectRef',
  'contentRef',
  'providerNativeRef',
  'checkpointRef',
  'coordinatorAgentId',
  'rootTaskId',
  'parentTaskId',
  'parentAgentId',
  'lease',
  'expectedHash',
  'trust',
  'code',
]);
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function readable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readable);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !internalFields.has(key))
      .map(([key, item]) => [fieldNames[key] || key, readable(item)]),
  );
}
function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '暂无结果';
  return JSON.stringify(readable(value), null, 2) ?? '';
}
function command(args: Record<string, unknown>): string {
  const program = typeof args.program === 'string' ? args.program : '';
  const parameters = Array.isArray(args.args)
    ? args.args.map((arg) => (typeof arg === 'string' && /\s/.test(arg) ? JSON.stringify(arg) : String(arg)))
    : [];
  return [program, ...parameters].join(' ');
}
function size(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function resultSummary(name: string, outcome: unknown): string {
  const result = record(outcome);
  if (!result) return '已返回结果';
  const suffix = result?.truncated === true ? '（结果已截断）' : '';
  if (name === 'list' && Array.isArray(result?.entries))
    return Number(result.entriesTotal ?? result.entries.length)
      ? `列出 ${result.entriesTotal ?? result.entries.length} 项`
      : '目录为空';
  if (name === 'search' && Array.isArray(result?.matches))
    return `${Number(result.matchesTotal ?? result.matches.length) ? `找到 ${result.matchesTotal ?? result.matches.length} 处匹配` : '未找到匹配'}${suffix}`;
  if (name === 'read' || name === 'read_artifact')
    return `已读取${result?.binary === true ? '二进制文件' : '文件'}${size(result?.bytes) ? ` · ${size(result?.bytes)}` : ''}${suffix}`;
  if (name === 'write' || name === 'apply_patch')
    return `${name === 'write' ? '已写入文件' : '已修改文件'}${size(result?.bytes) ? ` · ${size(result?.bytes)}` : ''}`;
  if (name === 'exec')
    return `${result?.timedOut === true ? '命令超时' : result?.exitCode === 0 ? '命令执行完成' : typeof result?.exitCode === 'number' ? `退出码 ${result.exitCode}` : '已返回命令结果'}${suffix}`;
  const summaries: Record<string, string> = {
    load_skill: '技能已加载',
    fetch_url: `已读取网页${suffix}`,
    artifact: '产物已登记',
    diff: '差异已生成',
    integrate_worktrees: '更改已集成',
    clarify: '问题已提出',
    propose_plan: '计划已提交',
    spawn_task: '子任务已创建',
    submit_result: '验收结果已提交',
  };
  return summaries[name] || '已返回结果';
}
function resultPreview(name: string, outcome: unknown): string {
  const result = record(outcome);
  if (name === 'list' && Array.isArray(result?.entries)) {
    const entries = result.entries;
    const names = entries.slice(0, 5).flatMap((entry) => {
      const item = record(entry);
      return typeof item?.name === 'string' ? [item.name + (item.directory === true ? '/' : '')] : [];
    });
    if (entries.length > 5) names.push(`…另有 ${entries.length - 5} 项`);
    return names.join('\n');
  }
  const text =
    name === 'exec'
      ? result?.stdout
      : name === 'read' || name === 'read_artifact' || name === 'fetch_url'
        ? result?.content
        : typeof outcome === 'string'
          ? outcome
          : '';
  if (typeof text !== 'string' || !text.trim()) return '';
  const preview = text.trim().split(/\r?\n/).slice(0, 3).join('\n').slice(0, 240);
  return preview + (text.trim().length > preview.length ? '\n…' : '');
}

export function ToolActivity({
  call,
  operation: summaryOperation,
  taskStatus,
  toolResponse,
}: {
  call: ToolCall;
  operation?: Operation;
  taskStatus?: Task['status'];
  toolResponse?: Message;
}) {
  const { api } = useSurfaceClient();
  const [full, setFull] = useState<Operation | null>(null),
    [readError, setReadError] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false),
    [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    setFull(null);
    setReadError('');
  }, [summaryOperation?.id, summaryOperation?.revision]);
  const operation =
    full?.id === summaryOperation?.id && full?.revision === summaryOperation?.revision
      ? full
      : summaryOperation;
  useEffect(() => {
    if (
      !summaryOperation ||
      !(summaryOperation as Operation & { detailsOmitted?: boolean }).detailsOmitted ||
      !detailsOpen
    )
      return;
    const controller = new AbortController();
    setReadError('');
    void api<Operation>(
      `/runs/${summaryOperation.runId}/records/operations/${summaryOperation.id}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted && result.revision === summaryOperation.revision) setFull(result);
        else if (!controller.signal.aborted) setReadError('操作已更新，请刷新对话后重试。');
      })
      .catch((error) => {
        if (!controller.signal.aborted) setReadError(error instanceof Error ? error.message : '详情读取失败');
      });
    return () => controller.abort();
  }, [summaryOperation?.id, summaryOperation?.revision, detailsOpen, readAttempt, api]);
  let parsed: unknown = call.arguments;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    // 保留不可解析的参数，便于用户核对失败原因。
  }
  const args = operation?.args || record(parsed) || {};
  let response: unknown = toolResponse?.text;
  if (toolResponse) {
    try {
      response = JSON.parse(toolResponse.text);
    } catch {
      // 非 JSON 工具返回继续按文本展示。
    }
  }
  const returned = record(response);
  const outcome =
    operation?.result !== undefined
      ? operation.result
      : returned && 'result' in returned
        ? returned.result
        : response;
  const result = record(outcome);
  const responseFailed = !operation && typeof returned?.error === 'string';
  const responseError = responseFailed
    ? (returned.error as string) || '工具返回错误，但未提供具体原因。'
    : '';
  const commandFailed =
    call.name === 'exec' &&
    (operation?.status === 'DONE' || (!operation && !!toolResponse)) &&
    (result?.timedOut === true || (result !== null && 'exitCode' in result && result.exitCode !== 0));
  const stopped = !!taskStatus && ['DONE', 'FAILED', 'CANCELLED'].includes(taskStatus);
  let status = '待执行';
  let tone = 'pending';
  let statusIcon = 'history';
  if (operation?.status === 'UNCERTAIN') {
    status = '待核验';
    tone = 'uncertain';
    statusIcon = 'lock';
  } else if (operation?.status === 'FAILED' || commandFailed || responseFailed) {
    status = '失败';
    tone = 'failed';
    statusIcon = 'close';
  } else if (operation?.status === 'DONE' || (!operation && toolResponse)) {
    status = '已完成';
    tone = 'done';
    statusIcon = 'check';
  } else if (operation?.status === 'INTENT') {
    status = stopped ? '已中断' : taskStatus === 'WAITING' ? '等待继续' : '执行中';
    tone = stopped || taskStatus === 'WAITING' ? 'pending' : 'running';
    statusIcon = tone === 'running' ? 'refresh' : 'pause';
  } else if (stopped) {
    status = '未执行';
  }
  const target =
    call.name === 'exec'
      ? command(args)
      : typeof args.path === 'string'
        ? args.path
        : typeof args.url === 'string'
          ? args.url
          : call.name === 'load_skill' && typeof args.id === 'string'
            ? args.id
            : typeof args.title === 'string'
              ? args.title
              : typeof args.name === 'string'
                ? args.name
                : '';
  const error =
    operation?.error ||
    responseError ||
    (typeof result?.error === 'string' ? result.error : '') ||
    (commandFailed
      ? result?.timedOut
        ? '命令执行超时'
        : `${result?.exitCode === null ? '命令未正常退出' : '命令退出码为 ' + result?.exitCode}${typeof result?.stderr === 'string' && result.stderr.trim() ? '：' + result.stderr.trim() : ''}`
      : '');
  const fields = Object.entries(args).filter(
    ([key]) => !internalFields.has(key) || (call.name === 'load_skill' && key === 'id'),
  );
  const briefResult =
    !error && tone === 'done' && outcome !== undefined ? resultSummary(call.name, outcome) : '';
  const preview = !error && tone === 'done' ? resultPreview(call.name, outcome) : '';
  return (
    <details className={`tool-activity ${tone}`}>
      <summary>
        <span className="tool-activity-glyph">
          <Icon
            name={call.name === 'exec' ? 'code' : call.name === 'fetch_url' ? 'globe' : 'file'}
            size={15}
          />
        </span>
        <span className="tool-activity-heading">
          <span className="tool-activity-name">{toolNames[call.name] || call.name}</span>
          {(target || briefResult) && (
            <span className="tool-activity-overview">
              {target && <code title={target}>{target === '.' ? '当前目录' : target}</code>}
              {briefResult && <span>{briefResult}</span>}
            </span>
          )}
          {error && (
            <span className="tool-activity-error-summary" title={error}>
              {error.trim().split(/\r?\n/)[0]}
            </span>
          )}
        </span>
        <span className="tool-activity-status">
          <Icon name={statusIcon} size={12} />
          {status}
        </span>
        <span className="tool-activity-chevron">
          <Icon name="arrow" size={13} />
        </span>
      </summary>
      <div className="tool-activity-body">
        {preview && <pre className="tool-activity-preview">{preview}</pre>}
        {operation?.status === 'UNCERTAIN' && (
          <p className="tool-activity-note">结果待核验，请在产物中检查证据。</p>
        )}
        {!operation && !toolResponse && (
          <p className="tool-activity-note">{stopped ? '任务已停止，操作未执行。' : '等待执行。'}</p>
        )}
        {operation?.status === 'INTENT' && (
          <p className="tool-activity-note">
            {stopped ? '操作已中断，暂无结果。' : taskStatus === 'WAITING' ? '等待继续。' : '正在执行…'}
          </p>
        )}
        <details
          className="tool-activity-details"
          onToggle={(event) => {
            setDetailsOpen(event.currentTarget.open);
          }}
        >
          <summary>查看详情</summary>
          {readError && (
            <p role="alert">
              {readError}{' '}
              <button
                type="button"
                className="text-button"
                onClick={() => setReadAttempt((value) => value + 1)}
              >
                重试
              </button>
            </p>
          )}
          {!full &&
            (summaryOperation as (Operation & { detailsOmitted?: boolean }) | undefined)?.detailsOmitted && (
              <p className="tool-activity-note">当前显示摘要，完整参数与结果在展开时读取。</p>
            )}
          <section>
            <h4>输入参数</h4>
            {fields.length ? (
              <dl>
                {fields.map(([key, value]) => (
                  <div key={key}>
                    <dt>{fieldNames[key] || key}</dt>
                    <dd>
                      <pre>{format(value)}</pre>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : typeof parsed === 'string' ? (
              <pre>{parsed}</pre>
            ) : (
              <p className="tool-activity-note">没有额外参数。</p>
            )}
          </section>
          {error && (
            <section className="tool-activity-error">
              <h4>错误原因</h4>
              <pre>{error}</pre>
            </section>
          )}
          {outcome !== undefined && (
            <section>
              <h4>执行结果</h4>
              <pre>{format(outcome)}</pre>
            </section>
          )}
        </details>
      </div>
    </details>
  );
}
