import type { Operation, RequestRecord, Run, Task } from '../../../packages/contracts/src/index';
import { modelTaskCanContinue, taskResumeReason } from './ModelSwitchGuards';
import './workflow.css';

export function TaskRecovery({
  task,
  detail,
  archived,
  busy,
  locate,
  resume,
}: {
  task: Task;
  detail: { run: Run; tasks: Task[]; requests: RequestRecord[]; operations: Operation[] };
  archived: boolean;
  busy: boolean;
  locate: (id: string) => void;
  resume: (id: string) => void;
}) {
  const reason = taskResumeReason(detail, archived, task.id);
  return (
    <div className="task-recovery">
      {task.waitReason === 'dependency_failed' && (
        <>
          <p className="field-help">
            {task.dependencyBlock?.causes.length
              ? '依赖分支失败、已取消或因重复错误暂停。请先处理下列来源，此任务会在依赖完成后继续。'
              : '依赖恢复中，等待完成；此任务无需手动恢复。'}
          </p>
          {task.dependencyBlock?.causes.map((cause) => (
            <div className="workflow-criterion" key={cause.taskId}>
              <p className="workflow-prose">
                {cause.chain
                  .map((id) => detail.tasks.find((item) => item.id === id)?.spec.title || id)
                  .join(' → ')}
              </p>
              <button className="text-button" onClick={() => locate(cause.taskId)}>
                定位
                {cause.waitReason === 'no_progress'
                  ? '重复错误'
                  : cause.status === 'CANCELLED'
                    ? '已取消'
                    : '失败'}
                分支
              </button>
            </div>
          ))}
        </>
      )}
      {task.waitReason === 'no_progress' && (
        <>
          <p className="field-help">
            相同工具错误重复发生，已暂停此代理。请先调整输入、权限问题或模型，再继续；累计预算保持。
          </p>
          {task.noProgress?.failures.map((failure) => (
            <p className="workflow-prose" key={failure.fingerprint}>
              {failure.tool} · {failure.code} · 重复 {failure.count} 次
            </p>
          ))}
        </>
      )}
      {modelTaskCanContinue(task) && (
        <button
          className="secondary"
          disabled={busy || !!reason || (!detail.run.authorized && task.phase !== 'planning')}
          title={reason || '仅恢复此代理，保留其他分支状态及累计预算'}
          onClick={() => resume(task.id)}
        >
          {task.status === 'FAILED'
            ? '重试此分支'
            : task.status === 'CANCELLED'
              ? '恢复此分支'
              : '继续此代理'}
        </button>
      )}
      {reason && modelTaskCanContinue(task) && <p className="field-help">{reason}</p>}
    </div>
  );
}
