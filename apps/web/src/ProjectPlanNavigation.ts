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

/**
 * 保存当前项目临时导入预览的一项待确认导航。intent 隔离异步目标，来源 epoch 隔离界面
 * 已发生的导航；confirm 只有在原项目、空间和运行仍一致时才丢弃预览并执行目的动作。
 */
export class ProjectPlanNavigationGuard {
  private intent = 0;
  private pending: PendingProjectPlanLeave | null = null;
  constructor(
    private context: () => ProjectPlanNavigationContext,
    private lifecycle: () => ProjectPlanNavigationLifecycle | null,
    private changed: (pending: PendingProjectPlanLeave | null) => void,
  ) {}
  begin() {
    // 新导航意图使旧的确认请求失效，避免异步回调跳转到过期目标。
    this.intent++;
    this.pending = null;
    this.changed(null);
    return this.intent;
  }
  current(intent: number) {
    return intent === this.intent;
  }
  /** 返回 true 表示动作已执行，false 表示意图失效或等待用户处理当前导入预览。 */
  request(
    action: () => void,
    options: { intent?: number; leaving?: boolean; bypass?: boolean; label?: string } = {},
  ) {
    const intent = options.intent ?? this.begin();
    if (!this.current(intent)) return false;
    const source = this.context(),
      owner = this.lifecycle();
    // 仅拦截当前项目的待处理导入；普通导航及明确绕过的动作立即执行。
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
  /** 重新核验来源后执行原目的动作；来源变化时只撤销旧确认，不影响当前页面的新预览。 */
  confirm() {
    const pending = this.pending,
      context = this.context(),
      owner = this.lifecycle();
    if (!pending || !this.current(pending.intent)) return false;
    // 确认前复核项目、运行、空间和界面代次，避免丢弃另一页面的新预览。
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
