/**
 * 定义计划对齐功能使用的数据类型。
 * 约定功能manifest版本、任务模型分配与面板回调载荷，供动态加载双方共享；仅定义类型和协议常量。
 * EN: Defines the plan-alignment feature interface. Defines feature-manifest version, task-model assignments, and panel callback payloads shared across dynamic loading, containing only types and protocol constants.
 */
import type { Agent, Run, Task, TaskSpec, ContextPolicy } from '../../../../../packages/contracts/src/index';
import type { ModelChoice, SelectableProvider } from '../../ModelPicker';

/**
 * 与宿主核对动态模块接口版本，防止加载不兼容的面板。
 * EN: Check dynamic interface version with host to reject incompatible panels.
 */
export const PLAN_ALIGNMENT_API_VERSION = 1;
export type AgentModelAssignment = ModelChoice & { contextPolicy?: ContextPolicy };
/**
 * 动态计划面板与宿主的固定接口。detail 是展示快照，assignments 是用户尚未接受的选择；
 * 面板通过回调报告修改与逐项就绪，不能直接请求内核或写入任务。
 * EN: Fixed host/panel contract: detail is display snapshot and assignments are unaccepted choices. Report changes/readiness through callbacks; panel cannot call kernel or write tasks directly.
 */
export type PlanAlignmentProps = {
  /**
   * 显示运行快照与已选模型；readyAssignment 单独反馈每项配置的有效性。
   * EN: Show run snapshot/chosen model and report each configuration's validity separately through readyAssignment.
   */
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
