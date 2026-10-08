import type { Agent, Run, Task, TaskSpec, ContextPolicy } from '../../../../../packages/contracts/src/index';
import type { ModelChoice, SelectableProvider } from '../../ModelPicker';

export const PLAN_ALIGNMENT_API_VERSION = 1;
export type AgentModelAssignment = ModelChoice & { contextPolicy?: ContextPolicy };
export type PlanAlignmentProps = {
  detail: { run: Run; tasks: Task[]; agents: Agent[] };
  providers: SelectableProvider[];
  assignments: Record<string, AgentModelAssignment>;
  assignmentReady: Record<string, boolean>;
  proposedChoice: (task: TaskSpec) => AgentModelAssignment;
  busy: boolean;
  archived: boolean;
  changeAssignment: (key: string, choice: AgentModelAssignment) => void;
  readyAssignment: (key: string, valid: boolean) => void;
  accept: () => void;
};
