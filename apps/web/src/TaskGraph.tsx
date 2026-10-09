import type { Run, Task } from '../../../packages/contracts/src/index';
import { Icon } from './Icon';

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
export type TaskGraphDetail = {
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
  tasks: Pick<Task, 'id' | 'parentTaskId' | 'spec' | 'status' | 'phase'>[];
  edges: { taskId: string; dependencyId: string }[];
};

export function TaskGraph({ detail, archived = false }: { detail: TaskGraphDetail; archived?: boolean }) {
  const tasks = detail.tasks.filter((task) => task.parentTaskId);
  const root = detail.tasks.find((task) => !task.parentTaskId);
  const pendingPlan =
    detail.run.plan && (!detail.run.authorized || detail.run.acceptedPlanVersion !== detail.run.plan.version)
      ? detail.run.plan
      : null;
  const readOnly = archived || detail.run.archived;
  const ended = ['DONE', 'CANCELLED'].includes(detail.run.status);
  const awaitingPlan =
    pendingPlan && !readOnly && detail.run.status === 'WAITING' && detail.run.reason === 'plan';
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
    <div className="task-graph">
      <div className="graph-root" title={root ? `${rootLabel} · ${statusLabels[root.status]}` : rootLabel}>
        <Icon name="spark" size={15} />
        {rootLabel}
        {root && <span>· {statusLabels[root.status]}</span>}
      </div>
      {pendingPlan && (
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
              {readOnly
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
              <div className="graph-level" key={rank}>
                <span className="graph-rank">阶段 {rank + 1}</span>
                {tasks
                  .filter((task) => ranks.get(task.id) === rank)
                  .map((task) => {
                    const names = dependencies(task.id).map((dependency) => dependency.spec.title);
                    const status = statusLabels[task.status];
                    return (
                      <div className="graph-node" key={task.id} title={`${task.spec.title} · ${status}`}>
                        <span className={'status-dot ' + task.status.toLowerCase()} aria-hidden="true" />
                        <span>{task.spec.title}</span>
                        <span>{status}</span>
                        {names.length > 0 && <small>依赖：{names.join('、')}</small>}
                      </div>
                    );
                  })}
              </div>
            ))}
      <small className="graph-caption">
        {awaitingPlan
          ? '接受计划后按依赖顺序创建并执行子任务'
          : pendingPlan
            ? '保留计划供查看，子任务尚未创建'
            : readOnly || ended
              ? '已保存任务依赖与状态记录'
              : '任务按依赖顺序推进'}
      </small>
    </div>
  );
}
