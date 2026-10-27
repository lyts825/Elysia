/**
 * 加载计划对齐功能并展示其状态。
 * 动态加载计划确认功能并校验模块接口，按代次重试且隔离加载或渲染失败；计划执行交给功能面板和服务端。
 * EN: Loads the plan-alignment feature and its state. Dynamically loads the plan-confirmation feature, validates its interface, retries by generation, and contains load/render failure; the feature panel and server own plan execution.
 */
import { Component, useEffect, useId, useState, type ComponentType, type ReactNode, type Ref } from 'react';
import { PLAN_ALIGNMENT_API_VERSION, type PlanAlignmentProps } from './features/plan-alignment/types';
import entryUrl from 'virtual:elysia-plan-alignment';
import './features/plan-alignment/plan-alignment.css';
import './plan-alignment-loader.css';

type Panel = ComponentType<PlanAlignmentProps>;
let pending: Promise<Panel> | undefined;
let attempt = 0;
/**
 * 加载同源固定内置面板并校验模块身份。并发共享 Promise；失败移除缓存并递增 URL
 * 查询参数，让浏览器不复用失败的模块加载结果。此重试只加载界面，不改写计划。
 * EN: Load a fixed same-origin panel and validate identity. Share in-flight Promise; evict failures and advance URL query to avoid reusing a failed import. Retry loads UI only, not a plan mutation.
 */
function loadPanel(): Promise<Panel> {
  /**
   * 仅从同源入口导入；并发请求共享 Promise，失败后改变 URL 以允许重试。
   * EN: Import from same origin only; share concurrency and change the URL after failure for retry.
   */
  const url = new URL(entryUrl, location.href);
  if (url.origin !== location.origin) return Promise.reject(new Error('计划模块来源无效'));
  if (attempt) url.searchParams.set('retry', String(attempt));
  return (pending ??= import(/* @vite-ignore */ url.href)
    .then((module) => {
      /**
       * 动态模块必须匹配固定身份和接口版本，才交给页面渲染。
       * EN: Validate fixed module identity and interface version before rendering.
       */
      if (
        module.manifest.id !== 'plan-alignment' ||
        module.manifest.apiVersion !== PLAN_ALIGNMENT_API_VERSION ||
        typeof module.PlanAlignmentPanel !== 'function'
      )
        throw new Error('计划模块版本不兼容');
      return module.PlanAlignmentPanel;
    })
    .catch((error) => {
      pending = undefined;
      attempt++;
      throw error;
    }));
}

/**
 * 将面板渲染异常隔离为可重试状态；key 中的运行与计划版本使新计划重建错误边界。
 * EN: Contain render failure in a retryable boundary; run/plan version in its key rebuilds it for new plans.
 */
class PanelBoundary extends Component<
  { children: ReactNode; retry: () => void; version: number; taskCount: number },
  { failed: boolean }
> {
  state = { failed: false };
  /**
   * 把动态计划模块的渲染异常标记为局部失败，以保留外层任务界面。
   * EN: Marks a render exception in the dynamic plan module as a local failure while preserving the surrounding task interface.
   */
  static getDerivedStateFromError() {
    return { failed: true };
  }
  /**
   * 失败时展示带计划版本和任务数量的重试入口，否则显示已加载子树。
   * EN: Shows retry feedback with plan version and task count after a failure; otherwise renders the loaded children.
   */
  render() {
    return this.state.failed ? (
      <LoadFailure retry={this.props.retry} version={this.props.version} taskCount={this.props.taskCount} />
    ) : (
      this.props.children
    );
  }
}
/**
 * 显示可访问的计划模块加载失败状态，保留版本及任务数量帮助核对，并提供重试回调。
 * EN: Renders accessible plan-module failure feedback with version and task count for context and exposes the retry callback.
 */
function LoadFailure({
  retry,
  version,
  taskCount,
}: {
  retry: () => void;
  version: number;
  taskCount: number;
}) {
  const scopeId = useId();
  return (
    <div className="plan-card plan-module-feedback" data-state="failed" role="alert">
      <h3>计划模块加载失败</h3>
      <div className="plan-module-source">
        <p className="plan-module-version">已读计划版本 {version}</p>
        <p className="plan-module-count">{taskCount} 项计划任务</p>
      </div>
      <p id={scopeId}>计划记录仍保留，重试会重新加载此计划界面。</p>
      <button type="button" className="secondary" aria-describedby={scopeId} onClick={retry}>
        重新加载计划模块
      </button>
    </div>
  );
}

/**
 * 仅任务存在计划时懒加载确认界面；加载期间显示已读计划身份，错误不会移除计划记录。
 * EN: Lazy-load confirmation only when a task has a plan; show loaded identity while waiting and retain plan records on error.
 */
export function PlanAlignmentLoader(props: PlanAlignmentProps & { anchorRef?: Ref<HTMLDivElement> }) {
  const [Panel, setPanel] = useState<Panel | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const plan = props.detail.run.plan;
  useEffect(() => {
    /**
     * 运行 ID、计划有无或运行类型变化后忽略旧结果；聊天及无计划的运行不加载面板。
     * EN: Ignore old results after run ID, plan presence, or type changes; chat and planless runs do not load the panel.
     */
    if (!plan || props.detail.run.kind === 'chat') return;
    let current = true;
    setFailed(false);
    loadPanel()
      .then((panel) => {
        if (current) setPanel(() => panel);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [generation, props.detail.run.id, !!plan, props.detail.run.kind]);
  if (!plan || props.detail.run.kind === 'chat') return null;
  /**
   * 清空已加载组件及错误，并增加加载代次；新代次触发重新读取模块且隔离旧加载结果。
   * EN: Clears the loaded component and failure state and advances the loading generation, triggering a new module read isolated from older results.
   */
  const retry = () => {
    setPanel(null);
    setFailed(false);
    setGeneration((value) => value + 1);
  };
  return (
    <div ref={props.anchorRef} className="plan-module" tabIndex={-1} aria-label="计划确认">
      {failed ? (
        <LoadFailure retry={retry} version={plan.version} taskCount={plan.tasks.length} />
      ) : Panel ? (
        <PanelBoundary
          key={generation + ':' + props.detail.run.id + ':' + plan.version}
          retry={retry}
          version={plan.version}
          taskCount={plan.tasks.length}
        >
          <Panel {...props} />
        </PanelBoundary>
      ) : (
        <div className="plan-card plan-module-feedback" data-state="loading" role="status" aria-busy="true">
          <h3>正在准备计划确认</h3>
          <div className="plan-module-source">
            <p className="plan-module-version">已读计划版本 {plan.version}</p>
            <p className="plan-module-count">{plan.tasks.length} 项计划任务</p>
          </div>
          <p>加载完成后可核对当前计划。</p>
        </div>
      )}
    </div>
  );
}
