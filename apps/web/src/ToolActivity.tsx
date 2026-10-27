/* 展示工具调用及其活动信息。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message, Operation, Task, ToolCall } from '../../../packages/contracts/src/index';
import { useSurfaceClient } from './SurfaceClientContext';
import { Icon } from './Icon';
import './tool-activity.css';

// 为工具协议名称提供显示标签，原始名称仍用于关联调用及结果。
const toolNames: Record<string, string> = {
  load_skill: '加载技能',
  list_skills: '查找技能',
  load_skill_file: '读取技能参考文件',
  recall_context: '回查上下文',
  list_local_memories: '查找本机记忆',
  recall_local_memory: '读取本机记忆',
  list_mcp_servers: '查找 MCP 服务',
  mcp_list_tools: '查看 MCP 工具',
  mcp_call: '调用 MCP 工具',
  list_project_memories: '查找项目记忆',
  recall_project_memory: '读取项目记忆',
  list: '浏览目录',
  read: '读取文件',
  read_artifact: '读取产物',
  materialize_artifact: '复制来源文件',
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
  allocate_context: '分配上下文',
  join_tasks: '等待子任务',
  submit_result: '提交验收结果',
  submit_peer_review: '提交评审评分',
  read_peer_evidence: '读取评审证据',
};
const fieldNames: Record<string, string> = {
  id: '标识',
  serverId: 'MCP 服务',
  artifactId: '产物标识',
  taskId: '任务标识',
  taskIds: '任务标识',
  expectedHash: '预期文件哈希',
  expectedRevision: '预期版本',
  windowTokens: '上下文额度',
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
  candidateId: '候选输出标识',
  items: '逐项评分',
  score: '分数',
  verdict: '评审结论',
  evidenceRefs: '证据引用',
  source: '来源',
  server: 'MCP 服务',
  tool: '工具',
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
/** 仅将非数组对象作为结构化工具结果，字符串和空值仍按原文展示。 */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** 字符串原样显示，其他值以缩进 JSON 保留字段；undefined 明确显示尚无结果。 */
function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '暂无结果';
  return JSON.stringify(value, null, 2) ?? '';
}
/** 组装便于阅读的命令摘要，为含空白参数加 JSON 引号；此文本只展示，不用于再次执行。 */
function command(args: Record<string, unknown>): string {
  const program = typeof args.program === 'string' ? args.program : '';
  const parameters = Array.isArray(args.args)
    ? args.args.map((arg) => (typeof arg === 'string' && /\s/.test(arg) ? JSON.stringify(arg) : String(arg)))
    : [];
  return [program, ...parameters].join(' ');
}
/** 格式化非负有限字节数；未知/异常值不生成虚假大小。 */
function size(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * 结合工具语义生成摘要，优先区分等待登记、截断和命令退出状态。
 * 摘要仅描述本次回执，不把当时进入等待当作任务现在仍在等待，也不代替完整结果。
 */
function resultSummary(name: string, outcome: unknown): string {
  const result = record(outcome);
  if (!result) return '已返回结果';
  if (registeredWait(name, result))
    return result.reason === 'peer_review'
      ? '候选输出已提交，等待独立评审'
      : result.reason === 'peer_review_limit'
        ? '评审轮次已用完，目标尚未确认'
        : result.reason === 'children'
          ? '当时已登记等待子任务'
          : result.reason === 'user'
            ? '当时已登记等待回答'
            : '当时已登记等待';
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
  if (name === 'materialize_artifact')
    return `来源文件已复制${size(result?.bytes) ? ` · ${size(result?.bytes)}` : ''}${typeof result?.hash === 'string' ? ` · SHA256 ${result.hash.slice(0, 12)}` : ''}`;
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
    submit_peer_review: '评审评分已提交',
    read_peer_evidence: '评审证据已读取',
  };
  return summaries[name] || '已返回结果';
}
/** 只有声明支持等待的工具才解释 waiting 字段，防止任意结果字段改变界面状态。 */
function registeredWait(name: string, result: Record<string, unknown> | null): boolean {
  return (
    ['clarify', 'propose_plan', 'join_tasks', 'submit_result'].includes(name) && result?.waiting === true
  );
}
/** 命令元数据、stdout 和 stderr 分区显示；未知结构保留原文，空输出与字段缺失分别处理。 */
function ResultContent({ name, outcome }: { name: string; outcome: unknown }) {
  const value = record(outcome);
  if (name !== 'exec' || !value)
    return (
      <pre role="region" aria-label="工具返回结果全文">
        {format(outcome)}
      </pre>
    );
  const outputKeys = new Set(['stdout', 'stderr']);
  const facts = Object.entries(value).filter(([key]) => !outputKeys.has(key));
  return (
    <>
      {facts.length > 0 && (
        <pre role="region" aria-label="命令返回元数据全文">
          {format(Object.fromEntries(facts))}
        </pre>
      )}
      {(['stdout', 'stderr'] as const).map((key) =>
        typeof value[key] === 'string' ? (
          <div className="tool-activity-output" key={key}>
            <h5>
              {key === 'stdout' ? '标准输出' : '标准错误'} <code>{key}</code>
            </h5>
            {value[key] ? (
              <pre role="region" aria-label={key === 'stdout' ? '命令标准输出全文' : '命令标准错误全文'}>
                {value[key]}
              </pre>
            ) : (
              <p className="tool-activity-note">本次返回为空。</p>
            )}
          </div>
        ) : value[key] !== undefined ? (
          <pre key={key} role="region" aria-label={`${key} 返回原文`}>
            {format({ [key]: value[key] })}
          </pre>
        ) : null,
      )}
    </>
  );
}

/**
 * 将模型调用、操作账本和工具消息合并成可展开记录。账本结果优先，旧消息回执作为兼容来源。
 * 摘要缺省正文时仅在展开后补读，严格匹配运行/操作/调用身份与版本，保留原摘要供失败时查看。
 * DONE 只代表动作有结果，命令退出失败和 MCP isError 仍应显示失败。
 */
export function ToolActivity({
  call,
  operation: summaryOperation,
  taskStatus,
  toolResponse,
  focused = false,
  invocationLabel,
}: {
  call: ToolCall;
  operation?: Operation;
  taskStatus?: Task['status'];
  toolResponse?: Message;
  focused?: boolean;
  invocationLabel?: string;
}) {
  const { api } = useSurfaceClient();
  const [full, setFull] = useState<Operation | null>(null),
    [readError, setReadError] = useState(''),
    [loading, setLoading] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false),
    [readAttempt, setReadAttempt] = useState(0);
  const activity = useRef<HTMLDetailsElement>(null);
  const readErrorRef = useRef<HTMLParagraphElement>(null);
  const retryFocus = useRef(false);
  const [focusRequest, setFocusRequest] = useState<{ target: 'summary' | 'error' }>();
  /** 完整缓存必须匹配当前摘要的全部可用身份，不能跨修订或模型回复复用同名工具结果。 */
  const sameRecord = (value: Operation | null) =>
    !!value &&
    !!summaryOperation &&
    value.runId === summaryOperation.runId &&
    value.id === summaryOperation.id &&
    value.toolCallId === summaryOperation.toolCallId &&
    value.name === summaryOperation.name &&
    value.revision === summaryOperation.revision &&
    (!summaryOperation.assistantMessageId ||
      value.assistantMessageId === summaryOperation.assistantMessageId);
  const loaded = sameRecord(full) ? full : null;
  const operation = loaded || summaryOperation;
  const omitted = !!(summaryOperation as (Operation & { detailsOmitted?: boolean }) | undefined)
    ?.detailsOmitted;
  useLayoutEffect(() => {
    if (!focused) return;
    if (activity.current) activity.current.open = true;
    setDetailsOpen(true);
  }, [focused, toolResponse?.id]);
  useEffect(() => {
    setFull(null);
    setReadError('');
  }, [summaryOperation?.runId, summaryOperation?.id, summaryOperation?.revision]);
  // 仅按需读取被省略的正文；展开状态、调用身份和重试号变化会取消上一请求。
  useEffect(() => {
    if (!summaryOperation || !omitted || !detailsOpen || loaded) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const focusFeedback = retryFocus.current;
    retryFocus.current = false;
    setReadError('');
    setLoading(true);
    void api<Operation>(
      `/runs/${summaryOperation.runId}/records/operations/${summaryOperation.id}`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          !result ||
          result.runId !== summaryOperation.runId ||
          result.id !== summaryOperation.id ||
          result.toolCallId !== summaryOperation.toolCallId ||
          result.name !== summaryOperation.name ||
          result.toolCallId !== call.id ||
          result.name !== call.name ||
          (summaryOperation.assistantMessageId &&
            result.assistantMessageId !== summaryOperation.assistantMessageId)
        )
          throw new Error('操作详情归属无法核对，已保留当前摘要。');
        if (result.revision !== summaryOperation.revision)
          throw new Error('操作记录已更新，已保留当前摘要；请刷新会话后重试。');
        setFull(result);
        if (focusFeedback) setFocusRequest({ target: 'summary' });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setReadError(error instanceof Error ? error.message : '详情读取失败');
          if (focusFeedback) setFocusRequest({ target: 'error' });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    summaryOperation?.runId,
    summaryOperation?.id,
    summaryOperation?.revision,
    summaryOperation?.toolCallId,
    summaryOperation?.name,
    summaryOperation?.assistantMessageId,
    call.id,
    call.name,
    omitted,
    detailsOpen,
    loaded,
    readAttempt,
    api,
  ]);
  useEffect(() => {
    if (!focusRequest || !activity.current?.open) return;
    // Recover focus lost with the retry button, without interrupting another control.
    const active = document.activeElement;
    if (
      active !== document.body &&
      active !== activity.current.querySelector('.tool-activity-read-error > button')
    )
      return;
    const target =
      focusRequest.target === 'error' ? readErrorRef.current : activity.current.querySelector('summary');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }, [focusRequest]);
  let parsed: unknown = call.arguments;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    // Preserve invalid arguments so the actual request remains reviewable.
  }
  const args = operation?.args || record(parsed) || {};
  let response: unknown = toolResponse?.text;
  if (toolResponse) {
    try {
      response = JSON.parse(toolResponse.text);
    } catch {
      // Plain text tool results remain plain text.
    }
  }
  const returned = record(response);
  const outcome =
    operation?.result !== undefined
      ? operation.result
      : returned && 'result' in returned
        ? returned.result
        : response;
  // 操作已完成并不保证程序成功：退出码、超时和 MCP 错误属于具体结果语义，需额外判断。
  const result = record(outcome);
  const waiting = registeredWait(call.name, result);
  const mcpFailed = call.name === 'mcp_call' && record(result?.result)?.isError === true;
  const responseFailed = !operation && typeof returned?.error === 'string';
  const responseError = responseFailed
    ? (returned.error as string) || '工具返回错误，但未提供具体原因。'
    : '';
  const commandFailed =
    call.name === 'exec' &&
    (operation?.status === 'DONE' || (!operation && !!toolResponse)) &&
    (result?.timedOut === true || (result !== null && 'exitCode' in result && result.exitCode !== 0));
  const stopped = !!taskStatus && ['DONE', 'FAILED', 'CANCELLED'].includes(taskStatus);
  let status = '尚无执行记录',
    tone = 'pending',
    statusIcon = 'history';
  if (operation?.status === 'UNCERTAIN') {
    // 未知副作用优先于其他错误显示，不能因存在旧回执就降为普通失败或成功。
    status = '待核验';
    tone = 'uncertain';
    statusIcon = 'lock';
  } else if (operation?.status === 'FAILED' || commandFailed || responseFailed || mcpFailed) {
    status = '失败';
    tone = 'failed';
    statusIcon = 'close';
  } else if (operation?.status === 'DONE' || (!operation && toolResponse)) {
    status = operation && !waiting ? '已完成' : '已返回';
    tone = 'done';
    statusIcon = 'check';
  } else if (operation?.status === 'INTENT') {
    status = stopped ? '结果未记录' : '等待结果';
    tone = 'pending';
    statusIcon = 'history';
  }
  const target =
    call.name === 'exec'
      ? command(args)
      : call.name === 'mcp_call'
        ? [args.serverId, args.tool].filter((value) => typeof value === 'string').join(' · ')
        : typeof args.path === 'string'
          ? args.path
          : typeof args.url === 'string'
            ? args.url
            : typeof args.title === 'string'
              ? args.title
              : typeof args.name === 'string'
                ? args.name
                : typeof args.id === 'string'
                  ? args.id
                  : typeof args.artifactId === 'string'
                    ? args.artifactId
                    : typeof args.serverId === 'string'
                      ? args.serverId
                      : '';
  const error =
    operation?.error ||
    responseError ||
    (mcpFailed ? 'MCP 工具返回错误（isError: true），请查看执行结果。' : '') ||
    (operation?.status === 'FAILED' && typeof result?.error === 'string' ? result.error : '') ||
    (commandFailed
      ? result?.timedOut
        ? '命令执行超时'
        : `${result?.exitCode === null ? '命令未正常退出' : '命令退出码为 ' + result?.exitCode}${typeof result?.stderr === 'string' && result.stderr.trim() ? '：' + result.stderr.trim() : ''}`
      : '');
  const fields = Object.entries(args);
  const briefResult =
    !error && tone === 'done' && outcome !== undefined ? resultSummary(call.name, outcome) : '';
  return (
    <details
      ref={activity}
      className={`tool-activity ${tone}`}
      data-testid="tool-activity"
      data-tool-name={call.name}
      data-tool-call-id={call.id}
      data-operation-id={operation?.id}
      data-operation-state={operation?.status || (toolResponse ? 'RETURNED' : 'UNRECORDED')}
      data-history-anchor={toolResponse?.id}
      onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
    >
      <summary data-testid="tool-activity-toggle">
        <span className="tool-activity-glyph" aria-hidden="true">
          <Icon
            name={call.name === 'exec' ? 'code' : call.name === 'fetch_url' ? 'globe' : 'file'}
            size={15}
          />
        </span>
        <span className="tool-activity-heading">
          <span className="tool-activity-kind">
            {invocationLabel && <span>{invocationLabel}</span>}
            <span>工具调用</span>
            <code>{call.name}</code>
          </span>
          <span className="tool-activity-name">{toolNames[call.name] || '其他工具'}</span>
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
        <span className="tool-activity-status" data-testid="tool-activity-status">
          <Icon name={statusIcon} size={12} />
          {status}
        </span>
        <span className="tool-activity-chevron" aria-hidden="true">
          <Icon name="arrow" size={13} />
        </span>
      </summary>
      <div className="tool-activity-body" data-testid="tool-activity-body" aria-busy={loading}>
        {target && (
          <section aria-label="完整工具作用目标">
            <h4>完整作用目标</h4>
            <p
              className="tool-activity-target-reading"
              role="region"
              tabIndex={0}
              aria-label="工具调用完整目标"
            >
              {target === '.' ? '当前目录（.）' : target}
            </p>
          </section>
        )}
        {operation?.status === 'UNCERTAIN' && (
          <p className="tool-activity-note">操作可能已产生影响，结果尚待核验；请核对任务中的说明与证据。</p>
        )}
        {!operation && !toolResponse && <p className="tool-activity-note">当前未找到这次调用的结果记录。</p>}
        {operation?.status === 'INTENT' && (
          <p className="tool-activity-note">
            {stopped ? '当前只记录了调用意图，结果尚未记录。' : '调用已登记，等待结果记录。'}
          </p>
        )}
        {waiting && (
          <p className="tool-activity-note">该次调用返回时已登记等待；当前是否仍在等待，以会话进度为准。</p>
        )}
        {loading && (
          <p className="tool-activity-note" role="status">
            正在读取完整参数与结果，当前摘要仍保留。
          </p>
        )}
        {readError && (
          <div className="tool-activity-read-error" role="alert">
            <p ref={readErrorRef} tabIndex={0} role="region" aria-label="工具详情读取失败">
              {readError}
            </p>
            <button
              type="button"
              className="secondary"
              data-testid="tool-activity-retry"
              onClick={() => {
                retryFocus.current = true;
                setReadAttempt((value) => value + 1);
              }}
            >
              重试读取
            </button>
          </div>
        )}
        {!loaded && omitted && (
          <p className="tool-activity-note">当前显示摘要，参数与结果可能省略；完整记录在展开时读取。</p>
        )}
        <section aria-label="输入参数">
          <h4>输入参数</h4>
          {fields.length ? (
            <dl>
              {fields.map(([key, value]) => (
                <div key={key}>
                  <dt>
                    {fieldNames[key] ? (
                      <>
                        {fieldNames[key]} <code>({key})</code>
                      </>
                    ) : (
                      key
                    )}
                  </dt>
                  <dd>
                    <pre role="region" aria-label={`${fieldNames[key] || key} 参数完整内容`}>
                      {format(value)}
                    </pre>
                  </dd>
                </div>
              ))}
            </dl>
          ) : !operation && !record(parsed) ? (
            <pre role="region" aria-label="工具原始输入全文">
              {call.arguments}
            </pre>
          ) : (
            <p className="tool-activity-note">没有额外参数。</p>
          )}
        </section>
        {error && (
          <section className="tool-activity-error" aria-label="错误原因">
            <h4>错误原因</h4>
            <pre role="region" aria-label="工具失败完整原因">
              {error}
            </pre>
          </section>
        )}
        {outcome !== undefined ? (
          <section aria-label="执行结果">
            <h4>执行结果</h4>
            <ResultContent name={call.name} outcome={outcome} />
          </section>
        ) : operation?.status === 'DONE' ? (
          <p className="tool-activity-note">当前记录未包含返回内容。</p>
        ) : null}
        <section aria-label="工具记录来源与版本">
          <h4>记录来源与版本</h4>
          <dl
            className="tool-activity-record-reading"
            role="region"
            tabIndex={0}
            aria-label="工具调用完整记录来源"
          >
            <div>
              <dt>记录依据</dt>
              <dd>
                {loaded
                  ? '按需读回的完整操作记录'
                  : summaryOperation
                    ? omitted
                      ? '摘要操作记录，可能省略内容'
                      : '当前提供的操作记录'
                    : toolResponse
                      ? '工具返回消息'
                      : '只有调用参数，暂无结果记录'}
              </dd>
            </div>
            <div>
              <dt>返回内容来源</dt>
              <dd>
                {operation?.result !== undefined
                  ? '操作记录结果'
                  : toolResponse
                    ? '工具返回消息'
                    : '尚无返回内容'}
              </dd>
            </div>
            <div>
              <dt>调用标识</dt>
              <dd>{call.id}</dd>
            </div>
            {operation && (
              <>
                <div>
                  <dt>操作标识</dt>
                  <dd>{operation.id}</dd>
                </div>
                <div>
                  <dt>操作版本</dt>
                  <dd>{operation.revision ?? '未提供'}</dd>
                </div>
                <div>
                  <dt>所属执行</dt>
                  <dd>{operation.runId}</dd>
                </div>
              </>
            )}
            {toolResponse && (
              <div>
                <dt>返回消息标识</dt>
                <dd>{toolResponse.id}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>
    </details>
  );
}
