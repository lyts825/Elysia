import type { Agent, Run, Task, TaskSpec } from '../../../../../packages/contracts/src/index';
import type { ModelChoice, SelectableProvider } from '../../ModelPicker';

export const PLAN_ALIGNMENT_API_VERSION = 1;
export type PlanAlignmentProps = {
  detail: { run: Run; tasks: Task[]; agents: Agent[] };
  providers: SelectableProvider[];
  assignments: Record<string, ModelChoice>;
  assignmentReady: Record<string, boolean>;
  proposedChoice: (task: TaskSpec) => ModelChoice;
  busy: boolean;
  archived: boolean;
  changeAssignment: (key: string, choice: ModelChoice) => void;
  readyAssignment: (key: string, valid: boolean) => void;
  accept: () => void;
};
