/* 展示任务及其依赖关系。 */
import { useId } from 'react';
import type { Run, Task } from '../../../packages/contracts/src/index';
import { Icon } from './Icon';
import type { DetailReadState } from './DetailReadState';
import './task-graph.css';

const statusLabels: Record<Task['status'], string> = {
  DRAFT: '待开始',
  READY: '就绪',
  RUNNING: '执行中',
  WAITING: '等待',
  VERIFYING: '待验收',
  DONE: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};
export type TaskGraphDetail = DetailReadState & {
  run: Pick<
    Run,
    | 'plan'
    | 'planMode'
    | 'execution'
    | 'authorized'
    | 'acceptedPlanVersion'
    | 'status'
    | 'archived'
    | 'reason'
  >;
  tasks: Pick<Task, 'id' | 'parentTaskId' | 'spec' | 'status' | 'phase' | 'waitReason'>[];
  edges: { taskId: string; dependencyId: string }[];
};
const taskStatus = (task: TaskGraphDetail['tasks'][number]) =>
  task.status === 'WAITING' && task.waitReason === 'dependency_failed'
    ? '依赖阻塞'
    : task.status === 'WAITING' && task.waitReason === 'no_progress'
      ? '重复错误暂停'
      : statusLabels[task.status];

/**
 * 根据已读任务和依赖边绘制分层状态图，未接受计划以候选计划单独提示，不伪造已创建子任务。
 * 任务读取不完整时明确降低图的完整性声明；selectTask 只定位现有任务，不执行状态操作。
 */
export function TaskGraph({
  detail,
  archived = false,
  selectTask,
}: {
  detail: TaskGraphDetail;
  archived?: boolean;
  selectTask?: (id: string) => void;
}) {
  const id = useId();
  const tasks = detail.tasks.filter((task) => task.parentTaskId);
  const root = detail.tasks.find((task) => !task.parentTaskId);
  // 任务覆盖不完整时，界面不能把当前可见分支当作完整依赖图。
  const incomplete = detail.detailCoverage?.tasks.complete === false;
  const pendingPlan =
    detail.run.plan && (!detail.run.authorized || detail.run.acceptedPlanVersion !== detail.run.plan.version)
      ? detail.run.plan
      : null;
  const readOnly = archived || detail.run.archived;
  const ended = ['DONE', 'CANCELLED'].includes(detail.run.status);
  const awaitingPlan =
    pendingPlan && !readOnly && detail.run.status === 'WAITING' && detail.run.reason === 'plan';
  // 兼容计划 key 与持久任务 ID 的引用，但所有展示名称仍来自本次实际读取的任务。
  const findTask = (reference: string) =>
    detail.tasks.find((task) => task.id === reference) ||
    detail.tasks.find((task) => task.spec.key === reference);
  const dependencies = (taskId: string) =>
    detail.edges
      .filter((edge) => edge.taskId === taskId)
      .map((edge) => findTask(edge.dependencyId))
      .filter((task): task is TaskGraphDetail['tasks'][number] => !!task);
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  /** 用最长依赖路径确定显示层；缓存已求层级，遇到环只中断本次递归，不把图显示当作业务校验。 */
  const rankOf = (task: TaskGraphDetail['tasks'][number]): number => {
    const known = ranks.get(task.id);
    if (known !== undefined) return known;
    if (visiting.has(task.id)) return 0;
    visiting.add(task.id);
    const deps = dependencies(task.id);
    const rank = deps.length ? Math.max(...deps.map(rankOf)) + 1 : 0;
    visiting.delete(task.id);
    ranks.set(task.id, rank);
    return rank;
  };
  for (const task of tasks) rankOf(task);
  const rootLabel =
    detail.run.execution?.kind === 'docker-agent'
      ? 'Agent 终端 · 执行与验收'
      : root?.phase === 'planning'
        ? '总代理 · 需求与计划'
        : detail.run.planMode === false
          ? '总代理 · 执行与验收'
          : '总代理 · 集成与验收';
  return (
    <section className="task-graph" aria-label="任务依赖与执行状态">
      <div className="graph-root" title={root ? `${rootLabel} · ${taskStatus(root)}` : rootLabel}>
        <span className="graph-root-label">
          <Icon name="spark" size={15} />
          {rootLabel}
        </span>
        {root && (
          <span className="graph-status" data-status={root.status.toLowerCase()}>
            {taskStatus(root)}
          </span>
        )}
        {!root && incomplete && <span className="graph-status">记录暂不可读</span>}
      </div>
      {incomplete && (
        <p className="field-help">任务记录不完整，仅展示已读任务；完整依赖关系与完成数量仍未知。</p>
      )}
      {pendingPlan && !incomplete && (
        <div className="graph-single" role="status">
          {awaitingPlan
            ? pendingPlan.tasks.length
              ? `计划待接受，${pendingPlan.tasks.length} 个子任务尚未创建。`
              : '计划待接受，接受后由总代理执行。'
            : pendingPlan.tasks.length
              ? `计划已保留，${pendingPlan.tasks.length} 个子任务尚未创建。`
              : '计划已保留，尚未接受。'}
        </div>
      )}
      {!tasks.length
        ? !pendingPlan && (
            <div className="graph-single">
              {incomplete
                ? '当前未能读取子任务，不能判断是否存在或已完成。'
                : readOnly
                  ? '已归档，未创建子任务。'
                  : ended
                    ? '任务已结束，未创建子任务。'
                    : root?.phase === 'planning'
                      ? ['READY', 'RUNNING'].includes(detail.run.status) &&
                        ['READY', 'RUNNING'].includes(root.status)
                        ? '正在制定计划，子任务尚未创建。'
                        : '尚未创建子任务。'
                      : detail.run.execution?.kind === 'docker-agent'
                        ? '内部调度由 Agent 终端管理'
                        : '单 Agent 执行'}
            </div>
          )
        : [...new Set(tasks.map((task) => ranks.get(task.id) || 0))]
            .sort((a, b) => a - b)
            .map((rank) => (
              <section
                className="graph-level"
                key={rank}
                aria-label={incomplete ? `已读任务分组 ${rank + 1}` : `阶段 ${rank + 1}`}
              >
                <h4 className="graph-rank">{incomplete ? '已读任务' : `阶段 ${rank + 1}`}</h4>
                <ul className="graph-tasks">
                  {tasks
                    .filter((task) => ranks.get(task.id) === rank)
                    .map((task) => {
                      const names = dependencies(task.id).map((dependency) => dependency.spec.title);
                      const status = taskStatus(task);
                      return (
                        <li className="graph-node" key={task.id}>
                          <span className="graph-status" data-status={task.status.toLowerCase()}>
                            <span className={'status-dot ' + task.status.toLowerCase()} aria-hidden="true" />
                            {status}
                          </span>
                          <p
                            className="graph-task-title"
                            id={`${id}-${task.id}`}
                            role="region"
                            aria-label="任务完整名称"
                            tabIndex={0}
                          >
                            {task.spec.title}
                          </p>
                          {names.length > 0 && (
                            <details className="graph-dependencies">
                              <summary>
                                {incomplete ? '已读依赖' : '依赖'} {names.length} 项
                              </summary>
                              <div
                                className="graph-dependency-reading"
                                role="region"
                                aria-label="依赖任务完整名称"
                                tabIndex={0}
                              >
                                <ul>
                                  {names.map((name, index) => (
                                    <li key={index}>{name}</li>
                                  ))}
                                </ul>
                              </div>
                            </details>
                          )}
                          {(selectTask && ['FAILED', 'CANCELLED'].includes(task.status)) ||
                          (selectTask &&
                            ['dependency_failed', 'no_progress'].includes(task.waitReason || '')) ? (
                            <button
                              type="button"
                              className="text-button"
                              aria-describedby={`${id}-${task.id}`}
                              onClick={() => selectTask?.(task.id)}
                            >
                              查看原因与恢复
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                </ul>
              </section>
            ))}
      <small className="graph-caption">
        {incomplete
          ? '修复后重试读取，原任务与运行状态保持不变'
          : awaitingPlan
            ? '接受计划后按依赖顺序创建并执行子任务'
            : pendingPlan
              ? '保留计划供查看，子任务尚未创建'
              : readOnly || ended
                ? '已保存任务依赖与状态记录'
                : '任务按依赖顺序推进'}
      </small>
    </section>
  );
}
