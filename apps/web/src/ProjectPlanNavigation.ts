/* 管理项目计划离开页面时的导航保护。 */
import type { PlanImportLifecycle } from './ProjectPlanTransfer';

export type ProjectPlanNavigationLifecycle = PlanImportLifecycle & { projectId: string };
export type ProjectPlanNavigationContext = {
  projectId: string;
  runId: string;
  spaceId: string;
  epoch: number;
};
export type PendingProjectPlanLeave = {
  intent: number;
  source: ProjectPlanNavigationContext;
  action: () => void;
  label: string;
};

/** One pending destination for the currently displayed project's temporary import preview. */
export class ProjectPlanNavigationGuard {
  private intent = 0;
  private pending: PendingProjectPlanLeave | null = null;
  constructor(
    private context: () => ProjectPlanNavigationContext,
    private lifecycle: () => ProjectPlanNavigationLifecycle | null,
    private changed: (pending: PendingProjectPlanLeave | null) => void,
  ) {}
  begin() {
    this.intent++;
    this.pending = null;
    this.changed(null);
    return this.intent;
  }
  current(intent: number) {
    return intent === this.intent;
  }
  request(
    action: () => void,
    options: { intent?: number; leaving?: boolean; bypass?: boolean; label?: string } = {},
  ) {
    const intent = options.intent ?? this.begin();
    if (!this.current(intent)) return false;
    const source = this.context(),
      owner = this.lifecycle();
    if (
      !options.bypass &&
      options.leaving !== false &&
      !source.runId &&
      source.projectId &&
      owner?.projectId === source.projectId &&
      owner.hasPending()
    ) {
      this.pending = { intent, source: { ...source }, action, label: options.label ?? '所选页面' };
      this.changed(this.pending);
      return false;
    }
    action();
    return true;
  }
  cancel() {
    this.begin();
  }
  confirm() {
    const pending = this.pending,
      context = this.context(),
      owner = this.lifecycle();
    if (!pending || !this.current(pending.intent)) return false;
    if (
      context.projectId !== pending.source.projectId ||
      context.runId !== pending.source.runId ||
      context.spaceId !== pending.source.spaceId ||
      context.epoch !== pending.source.epoch ||
      owner?.projectId !== pending.source.projectId
    ) {
      this.begin();
      return false;
    }
    this.pending = null;
    this.changed(null);
    owner.discard();
    pending.action();
    return true;
  }
}
