/**
 * 展示任务恢复相关操作。
 *
 * EN: Displays task recovery actions.
 *
 * 本模块为原生模型任务计算局部恢复入口和禁用原因，必要时定位依赖失败来源；实际恢复命令交给父层，预算、授权和任务生命周期由后端核验。
 * EN: Computes local recovery actions/disabled reasons for native model tasks and locates failed dependencies when needed. The parent issues recovery commands; the backend validates budgets, authorization, and lifecycle.
 */
import { useId } from 'react';
import type { Operation, RequestRecord, Run, Task } from '../../../packages/contracts/src/index';
import { modelTaskCanContinue, taskResumeReason } from './ModelSwitchGuards';
import './workflow.css';
import './task-recovery.css';

/**
 * 为单个模型任务提供局部恢复入口，按运行归档、未知请求/操作与授权规则决定禁用原因。
 * 依赖阻塞仅定位真正失败的来源分支，等待依赖恢复的父任务不会被重复恢复；
 * 本组件只传任务 ID 给外层命令，累计预算和其他分支状态由内核保持。
 *
 * EN: Offers local model-task recovery subject to archive, unknown-request/operation, and authorization checks. Dependency blocks locate the actual source rather than repeatedly resuming the waiting parent. The component passes IDs only; the kernel preserves budgets and other branches.
 */
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
  const reasonId = useId();
  /**
   * 依赖失败先定位阻塞来源；其他可继续状态再根据读取和授权边界决定恢复入口。
   *
   * EN: Dependency failure first locates its source; other restartable states use read/authorization guards for the resume action.
   */
  const canContinue = modelTaskCanContinue(task);
  const reason =
    taskResumeReason(detail, archived, task.id) ||
    (!detail.run.authorized && task.phase !== 'planning' ? '当前任务尚未授权执行，请先完成执行确认。' : '');
  if (!canContinue && !['dependency_failed', 'no_progress'].includes(task.waitReason || '')) return null;
  return (
    <section className="task-recovery" aria-label="任务恢复与依赖">
      <h4>恢复与依赖</h4>
      {task.waitReason === 'dependency_failed' && (
        <>
          <p className="field-help">
            {task.dependencyBlock?.causes.length
              ? '依赖分支失败、已取消或因重复错误暂停。请先处理下列来源，此任务会在依赖完成后继续。'
              : '依赖恢复中，等待完成；此任务无需手动恢复。'}
          </p>
          <ol className="task-recovery-sources">
            {task.dependencyBlock?.causes.map((cause, index) => (
              <li className="task-recovery-source" key={cause.taskId}>
                <h5>依赖来源 {index + 1}</h5>
                <p className="task-recovery-state" data-status={cause.status}>
                  {cause.waitReason === 'no_progress'
                    ? '重复错误暂停'
                    : cause.status === 'CANCELLED'
                      ? '已取消'
                      : '失败'}
                </p>
                <details open>
                  <summary>依赖路径 · {cause.chain.length} 项</summary>
                  <div
                    className="task-recovery-reading"
                    role="region"
                    aria-label={`依赖路径 ${index + 1}`}
                    tabIndex={0}
                  >
                    <ol>
                      {cause.chain.map((id, chainIndex) => (
                        <li key={`${id}:${chainIndex}`}>
                          {detail.tasks.find((item) => item.id === id)?.spec.title || id}
                        </li>
                      ))}
                    </ol>
                  </div>
                </details>
                <button type="button" className="text-button" onClick={() => locate(cause.taskId)}>
                  定位
                  {cause.waitReason === 'no_progress'
                    ? '重复错误'
                    : cause.status === 'CANCELLED'
                      ? '已取消'
                      : '失败'}
                  分支
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      {task.waitReason === 'no_progress' && (
        <>
          <p className="field-help">
            相同工具错误重复发生，已暂停此代理。请先调整输入、权限问题或模型，再继续；累计预算保持。
          </p>
          {!!task.noProgress?.failures.length && (
            <div className="task-recovery-reading" role="region" aria-label="重复工具错误记录" tabIndex={0}>
              <ul className="task-recovery-failures">
                {task.noProgress.failures.map((failure) => (
                  <li className="task-recovery-failure" key={failure.fingerprint}>
                    <dl>
                      <div>
                        <dt>工具</dt>
                        <dd>{failure.tool}</dd>
                      </div>
                      <div>
                        <dt>错误代码</dt>
                        <dd>
                          <code>{failure.code}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>重复次数</dt>
                        <dd>{failure.count} 次</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {canContinue && (
        <button
          type="button"
          className="secondary task-recovery-resume"
          disabled={busy || !!reason}
          aria-describedby={reason ? reasonId : undefined}
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
      {reason && canContinue && (
        <p
          className="field-help task-recovery-reading"
          id={reasonId}
          role="region"
          aria-label="暂不可恢复原因"
          tabIndex={0}
        >
          {reason}
        </p>
      )}
    </section>
  );
}
