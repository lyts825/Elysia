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
        终端状态 ·{' '}
        {snapshot.executor.queue.length
          ? `${snapshot.executor.queue.length} 项排队`
          : snapshot.terminal.tasks.length
            ? phases[snapshot.terminal.tasks.at(-1)!.phase]
            : '空闲'}
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
                    <strong>{names.get(item.taskId) || '终端任务'}</strong>
                    <span className="terminal-runtime-state">队列第 {item.position} 位</span>
                  </div>
                  <p>{reasons[item.reason]}</p>
                  {item.resourcePreset && (
                    <p className="field-help">
                      资源规格：{{ light: '轻量', standard: '标准', large: '大型' }[item.resourcePreset]}
                    </p>
                  )}
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
                    <strong>{names.get(item.taskId) || '终端任务'}</strong>
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
                </article>
              ))}
            </div>
          </section>
        )}
        <section aria-label="终端资源">
          <h4>
            终端资源 <span>已预留 / 容量</span>
          </h4>
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
            <p className="field-help" role="status">
              {resource.message}
            </p>
          )}
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
                    <div className="terminal-runtime-owner">
                      <strong>{item.owner.runTitle}</strong>
                      <span>{item.owner.taskTitle}</span>
                    </div>
                  )}
                  <p>
                    {item.owner ? item.owner.reason : item.reason || '终端停止状态尚待核验，资源暂时保留。'}
                  </p>
                  {item.kind === 'probe' && (
                    <p className="field-help">请在终端管理中重新检测，以核验并清理已知检测容器。</p>
                  )}
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
