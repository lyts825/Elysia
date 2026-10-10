import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index';
import type {
  ExecutorRuntimeSnapshot,
  TerminalRuntimeSnapshot,
  RuntimeQueueReason,
  TerminalRuntimePhase,
} from '../../../packages/contracts/src/terminal-runtime';

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
  'terminal-resources': '等待终端资源',
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
      <div aria-live="polite">
        {snapshot.executor.queue.map((item) => (
          <p key={item.taskId}>
            {names.get(item.taskId) || '终端任务'} · 队列第 {item.position} 位 · {reasons[item.reason]}
          </p>
        ))}
        {snapshot.terminal.tasks.map((item) => (
          <p key={item.taskId}>
            {names.get(item.taskId) || '终端任务'} · {phases[item.phase]}
            {['preparing', 'starting', 'running', 'finalizing'].includes(item.phase) &&
              ` · 已持续 ${age(item.phaseStartedAt)}`}
            {item.lastPublicActivityAt && ` · 最近输出 ${age(item.lastPublicActivityAt)}前`}
          </p>
        ))}
        <p>
          终端资源：{resource.reserved.sessions}/{resource.capacity.sessions} · CPU {resource.reserved.cpus}/
          {resource.capacity.cpus} · 内存 {resource.reserved.memoryMiB}/{resource.capacity.memoryMiB} MiB
        </p>
        {resource.status !== 'ready' && <p className="field-help">{resource.message}</p>}
        {resource.reservations
          .filter((item) => item.held)
          .map((item) => (
            <p className="field-help" key={item.id}>
              {item.owner
                ? `${item.owner.runTitle} · ${item.owner.taskTitle}：${item.owner.reason}`
                : item.reason || '终端停止状态尚待核验，资源暂时保留。'}
              {item.owner && onNavigate && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => onNavigate(item.owner!.runId, item.owner!.operationId)}
                >
                  打开待核验对话
                </button>
              )}
              {item.kind === 'probe' && ' 请在终端管理中重新检测，以核验并清理已知检测容器。'}
            </p>
          ))}
        <p className="field-help">暂时没有输出时仍保留运行状态，可查看日志或手动暂停。</p>
      </div>
    </details>
  );
}
