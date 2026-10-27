/**
 * 管理项目计划离开页面时的导航保护。
 * 对含未处理导入预览的离开动作提供意图编号和来源复核，延后执行目标动作；不自行决定丢弃哪些草稿。
 * EN: Guards leaving a temporary project-plan import preview. Guards leave actions with unresolved import previews through intent tokens and origin revalidation, deferring destination actions without deciding which drafts to discard.
 */
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
 * EN: Keep one pending navigation. intent isolates asynchronous destinations and source epoch isolates newer UI navigation. Confirm discards preview/executes only if original project/space/run still match.
 */
export class ProjectPlanNavigationGuard {
  private intent = 0;
  private pending: PendingProjectPlanLeave | null = null;
  /**
   * 注入当前导航上下文、导入生命周期和待确认状态回调；使用延迟读取以在确认时核对最新来源。
   * EN: Injects current navigation context, import lifecycle, and pending-confirmation publication. Deferred access allows confirmation to revalidate the latest origin.
   */
  constructor(
    private context: () => ProjectPlanNavigationContext,
    private lifecycle: () => ProjectPlanNavigationLifecycle | null,
    private changed: (pending: PendingProjectPlanLeave | null) => void,
  ) {}
  /**
   * 开始新的导航意图并清空旧确认，返回递增标识供后续异步动作检查是否过期。
   * EN: Starts a new navigation intent, clears prior confirmation, and returns a monotonically increasing token for later stale-intent checks.
   */
  begin() {
    /**
     * 新导航意图使旧的确认请求失效，避免异步回调跳转到过期目标。
     * EN: New navigation invalidates older confirmation so late callbacks cannot jump to stale targets.
     */
    this.intent++;
    this.pending = null;
    this.changed(null);
    return this.intent;
  }
  /**
   * 比较异步动作携带的意图标识与当前标识，决定它是否仍有权执行导航。
   * EN: Compares an asynchronous action token with the current intent to decide whether it may still navigate.
   */
  current(intent: number) {
    return intent === this.intent;
  }
  /**
   * 返回 true 表示动作已执行，false 表示意图失效或等待用户处理当前导入预览。
   * EN: Return true for executed action; false for stale intent or pending preview confirmation.
   */
  request(
    action: () => void,
    options: { intent?: number; leaving?: boolean; bypass?: boolean; label?: string } = {},
  ) {
    const intent = options.intent ?? this.begin();
    if (!this.current(intent)) return false;
    const source = this.context(),
      owner = this.lifecycle();
    /**
     * 仅拦截当前项目的待处理导入；普通导航及明确绕过的动作立即执行。
     * EN: Intercept only current-project pending imports; ordinary or explicitly bypassed navigation executes immediately.
     */
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
  /**
   * 通过建立新意图撤销当前离开确认及其旧回调，保留页面现有编辑。
   * EN: Revokes the pending leave confirmation and old callbacks by starting a new intent while retaining current page edits.
   */
  cancel() {
    this.begin();
  }
  /**
   * 重新核验来源后执行原目的动作；来源变化时只撤销旧确认，不影响当前页面的新预览。
   * EN: Revalidate origin before executing destination. Changed origin revokes old confirmation without touching a new preview.
   */
  confirm() {
    const pending = this.pending,
      context = this.context(),
      owner = this.lifecycle();
    if (!pending || !this.current(pending.intent)) return false;
    /**
     * 确认前复核项目、运行、空间和界面代次，避免丢弃另一页面的新预览。
     * EN: Recheck project/run/space/UI epoch before discarding to avoid removing another page's preview.
     */
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
