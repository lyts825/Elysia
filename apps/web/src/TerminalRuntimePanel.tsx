/* 展示终端任务的运行状态。 */
import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index';
import type {
  ExecutorRuntimeSnapshot,
  TerminalRuntimeSnapshot,
  RuntimeQueueReason,
  TerminalRuntimePhase,
} from '../../../packages/contracts/src/terminal-runtime';
import './terminal-runtime.css';

const phases: Record<TerminalRuntimePhase, string> = {
  preparing: '准备环境',
  starting: '启动终端',
  running: '执行中',
  finalizing: '保存结果',
  review: '等待审阅',
  verification: '等待核验',
  unavailable: '环境不可用',
  stopped: '已停止',
};
const reasons: Record<RuntimeQueueReason, string> = {
  ready: '等待调度',
  'global-concurrency': '等待可用执行位',
  'run-concurrency': '等待本任务执行位',
  'account-concurrency': '等待账号执行位',
  dependencies: '等待前置任务',
  'execution-preparing': '正在检查执行环境',
  'execution-unavailable': '执行环境检查失败，等待重试',
  'terminal-resources': '等待终端资源',
  'terminal-capacity': '规格超出 Docker 容量，请增加 Docker 资源或新建较小规格任务',
  'terminal-engine': '等待 Docker 引擎',
};
/** 无法格式化的时间保留原值，避免隐藏异常数据。 */
function runtimeTime(timestamp: number) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? (
    <span>时间无法格式化（原值：{String(timestamp)}）</span>
  ) : (
    <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
  );
}
/** 展示执行队列、终端阶段和资源预约；任务名称从调用方提供的列表中匹配。 */
export function TerminalRuntimePanel({
  snapshot,
  tasks,
  onNavigate,
}: {
  snapshot: { executor: ExecutorRuntimeSnapshot; terminal: TerminalRuntimeSnapshot };
  tasks: Task[];
  onNavigate?: (runId: string, operationId?: string) => void;
}) {
  const [time, setTime] = useState(Date.now());
  const working = snapshot.terminal.tasks.some((task) =>
    ['preparing', 'starting', 'running', 'finalizing'].includes(task.phase),
  );
  useEffect(() => {
    if (!working) return;
    // 只在存在活动阶段时刷新经过时间，空闲时不保留计时器。
    setTime(Date.now());
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);
  const age = (timestamp: number) => {
    const seconds = Math.max(0, Math.floor((time - timestamp) / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  };
  const names = new Map(tasks.map((task) => [task.id, task.spec.title]));
  const resource = snapshot.terminal.resources;
  const held = resource.reservations.filter((item) => item.held);
  return (
    <details className="terminal-activity terminal-runtime">
      <summary>
        <span>终端状态</span>
        <span className="terminal-runtime-summary-state">
          {snapshot.executor.queue.length ? `${snapshot.executor.queue.length} 项排队 · ` : ''}
          {snapshot.terminal.tasks.length
            ? `${snapshot.terminal.tasks.length} 项运行记录`
            : snapshot.executor.queue.length
              ? '暂无运行记录'
              : '空闲'}
          {held.length > 0 && ` · ${held.length} 项资源暂留`}
        </span>
      </summary>
      <div className="terminal-runtime-body">
        {snapshot.executor.queue.length > 0 && (
          <section aria-label="排队任务">
            <h4>
              排队任务 <span>{snapshot.executor.queue.length} 项</span>
            </h4>
            <div className="terminal-runtime-list" aria-live="polite">
              {snapshot.executor.queue.map((item) => (
                <article className="terminal-runtime-item" key={item.taskId}>
                  <div className="terminal-runtime-item-heading">
                    <strong
                      className="terminal-runtime-reading"
                      role="region"
                      aria-label="排队任务完整名称"
                      tabIndex={0}
                    >
                      {names.get(item.taskId) || '终端任务'}
                    </strong>
                    <span className="terminal-runtime-state">队列第 {item.position} 位</span>
                  </div>
                  <p
                    className="terminal-runtime-reading"
                    role="region"
                    aria-label="完整排队原因"
                    tabIndex={0}
                  >
                    {reasons[item.reason]}
                  </p>
                  {item.resourcePreset && (
                    <p className="field-help">
                      资源规格：{{ light: '轻量', standard: '标准', large: '大型' }[item.resourcePreset]}
                    </p>
                  )}
                  <details className="terminal-runtime-source">
                    <summary>队列标识</summary>
                    <dl
                      className="terminal-runtime-reading"
                      role="region"
                      aria-label="排队任务完整标识"
                      tabIndex={0}
                    >
                      <div>
                        <dt>对话</dt>
                        <dd>{item.runId}</dd>
                      </div>
                      <div>
                        <dt>任务</dt>
                        <dd>{item.taskId}</dd>
                      </div>
                    </dl>
                  </details>
                </article>
              ))}
            </div>
          </section>
        )}
        {snapshot.terminal.tasks.length > 0 && (
          <section aria-label="任务运行状态">
            <h4>
              任务运行状态 <span>{snapshot.terminal.tasks.length} 项</span>
            </h4>
            <div className="terminal-runtime-list">
              {snapshot.terminal.tasks.map((item) => (
                <article className="terminal-runtime-item" key={item.taskId}>
                  <div className="terminal-runtime-item-heading" aria-live="polite">
                    <strong
                      className="terminal-runtime-reading"
                      role="region"
                      aria-label="运行任务完整名称"
                      tabIndex={0}
                    >
                      {names.get(item.taskId) || '终端任务'}
                    </strong>
                    <span className="terminal-runtime-state" data-phase={item.phase}>
                      {phases[item.phase]}
                    </span>
                  </div>
                  <div className="terminal-runtime-times">
                    {['preparing', 'starting', 'running', 'finalizing'].includes(item.phase) && (
                      <span>已持续 {age(item.phaseStartedAt)}</span>
                    )}
                    {item.lastPublicActivityAt && <span>最近输出 {age(item.lastPublicActivityAt)}前</span>}
                  </div>
                  <details className="terminal-runtime-source">
                    <summary>阶段时间与标识</summary>
                    <dl
                      className="terminal-runtime-reading"
                      role="region"
                      aria-label="运行阶段完整时间与标识"
                      tabIndex={0}
                    >
                      <div>
                        <dt>阶段开始</dt>
                        <dd>{runtimeTime(item.phaseStartedAt)}</dd>
                      </div>
                      {item.lastPublicActivityAt && (
                        <div>
                          <dt>最近公开输出</dt>
                          <dd>{runtimeTime(item.lastPublicActivityAt)}</dd>
                        </div>
                      )}
                      <div>
                        <dt>对话</dt>
                        <dd>{item.runId}</dd>
                      </div>
                      <div>
                        <dt>任务</dt>
                        <dd>{item.taskId}</dd>
                      </div>
                      {item.operationId && (
                        <div>
                          <dt>操作</dt>
                          <dd>{item.operationId}</dd>
                        </div>
                      )}
                      <div>
                        <dt>运行记录版本</dt>
                        <dd>{item.revision}</dd>
                      </div>
                    </dl>
                  </details>
                </article>
              ))}
            </div>
          </section>
        )}
        <section aria-label="终端资源">
          <h4>
            终端资源 <span>已预留 / 容量</span>
          </h4>
          <p className="terminal-runtime-resource-state" role="status">
            {resource.status === 'ready'
              ? '资源已就绪'
              : resource.status === 'unknown'
                ? '资源容量待核实'
                : '资源暂不可用'}
            {` · ${resource.waitingInstallations} 项安装等待 · ${resource.waitingProbes} 项检测等待`}
          </p>
          <dl className="terminal-runtime-resources">
            <div>
              <dt>终端会话</dt>
              <dd>
                {resource.reserved.sessions} / {resource.capacity.sessions}
              </dd>
            </div>
            <div>
              <dt>CPU</dt>
              <dd>
                {resource.reserved.cpus} / {resource.capacity.cpus}
              </dd>
            </div>
            <div>
              <dt>
                内存 <span>MiB</span>
              </dt>
              <dd>
                {resource.reserved.memoryMiB} / {resource.capacity.memoryMiB}
              </dd>
            </div>
          </dl>
          {resource.status !== 'ready' && (
            <p
              className="field-help terminal-runtime-reading"
              role="status"
              aria-label="终端资源完整说明"
              tabIndex={0}
            >
              {resource.message}
            </p>
          )}
          <details className="terminal-runtime-source">
            <summary>快照版本</summary>
            <dl
              className="terminal-runtime-reading"
              role="region"
              aria-label="终端运行完整快照版本"
              tabIndex={0}
            >
              <div>
                <dt>执行队列</dt>
                <dd>{snapshot.executor.revision}</dd>
              </div>
              <div>
                <dt>终端运行</dt>
                <dd>{snapshot.terminal.revision}</dd>
              </div>
              <div>
                <dt>终端资源</dt>
                <dd>{resource.revision}</dd>
              </div>
            </dl>
          </details>
        </section>
        {held.length > 0 && (
          <section aria-label="暂时保留的资源">
            <h4>
              暂时保留的资源 <span>{held.length} 项</span>
            </h4>
            <div className="terminal-runtime-list">
              {held.map((item) => (
                <article className="terminal-runtime-item terminal-runtime-held" key={item.id}>
                  {item.owner && (
                    <div
                      className="terminal-runtime-owner terminal-runtime-reading"
                      role="region"
                      aria-label="暂留资源所属对话与任务全文"
                      tabIndex={0}
                    >
                      <strong>{item.owner.runTitle}</strong>
                      <span>{item.owner.taskTitle}</span>
                    </div>
                  )}
                  <p
                    className="terminal-runtime-reading"
                    role="region"
                    aria-label="资源暂留完整原因"
                    tabIndex={0}
                  >
                    {item.owner ? item.owner.reason : item.reason || '终端停止状态尚待核验，资源暂时保留。'}
                  </p>
                  {item.kind === 'probe' && (
                    <p className="field-help">请在终端管理中重新检测，以核验并清理已知检测容器。</p>
                  )}
                  <details className="terminal-runtime-source">
                    <summary>资源标识与占用</summary>
                    <dl
                      className="terminal-runtime-reading"
                      role="region"
                      aria-label="暂留资源完整标识与占用"
                      tabIndex={0}
                    >
                      <div>
                        <dt>资源标识</dt>
                        <dd>{item.id}</dd>
                      </div>
                      <div>
                        <dt>占用</dt>
                        <dd>
                          {item.resources.sessions} 个会话 · {item.resources.cpus} CPU ·{' '}
                          {item.resources.memoryMiB} MiB
                        </dd>
                      </div>
                      {item.owner && (
                        <>
                          <div>
                            <dt>对话</dt>
                            <dd>{item.owner.runId}</dd>
                          </div>
                          <div>
                            <dt>任务</dt>
                            <dd>{item.owner.taskId}</dd>
                          </div>
                          {item.owner.operationId && (
                            <div>
                              <dt>操作</dt>
                              <dd>{item.owner.operationId}</dd>
                            </div>
                          )}
                        </>
                      )}
                    </dl>
                  </details>
                  {item.owner && onNavigate && (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => onNavigate(item.owner!.runId, item.owner!.operationId)}
                    >
                      打开待核验对话
                    </button>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}
        <p className="field-help">暂时没有输出时仍保留运行状态，可查看日志或手动暂停。</p>
      </div>
    </details>
  );
}
