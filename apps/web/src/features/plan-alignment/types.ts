/* 定义计划对齐功能使用的数据类型。 */
import type { Agent, Run, Task, TaskSpec, ContextPolicy } from '../../../../../packages/contracts/src/index';
import type { ModelChoice, SelectableProvider } from '../../ModelPicker';

// 与宿主核对动态模块接口版本，防止加载不兼容的面板。
export const PLAN_ALIGNMENT_API_VERSION = 1;
export type AgentModelAssignment = ModelChoice & { contextPolicy?: ContextPolicy };
/**
 * 动态计划面板与宿主的固定接口。detail 是展示快照，assignments 是用户尚未接受的选择；
 * 面板通过回调报告修改与逐项就绪，不能直接请求内核或写入任务。
 */
export type PlanAlignmentProps = {
  // 显示运行快照与已选模型；readyAssignment 单独反馈每项配置的有效性。
  detail: { run: Run; tasks: Task[]; agents: Agent[] };
  providers: SelectableProvider[];
  assignments: Record<string, AgentModelAssignment>;
  assignmentReady: Record<string, boolean>;
  proposedChoice: (task: TaskSpec) => AgentModelAssignment;
  busy: boolean;
  archived: boolean;
  readOnlyReason?: string;
  changeAssignment: (key: string, choice: AgentModelAssignment) => void;
  readyAssignment: (key: string, valid: boolean) => void;
  accept: () => void;
};
