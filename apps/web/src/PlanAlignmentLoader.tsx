/* 加载计划对齐功能并展示其状态。 */
import { Component, useEffect, useId, useState, type ComponentType, type ReactNode, type Ref } from 'react';
import { PLAN_ALIGNMENT_API_VERSION, type PlanAlignmentProps } from './features/plan-alignment/types';
import entryUrl from 'virtual:elysia-plan-alignment';
import './features/plan-alignment/plan-alignment.css';
import './plan-alignment-loader.css';

type Panel = ComponentType<PlanAlignmentProps>;
let pending: Promise<Panel> | undefined;
let attempt = 0;
function loadPanel(): Promise<Panel> {
  const url = new URL(entryUrl, location.href);
  if (url.origin !== location.origin) return Promise.reject(new Error('计划模块来源无效'));
  if (attempt) url.searchParams.set('retry', String(attempt));
  return (pending ??= import(/* @vite-ignore */ url.href)
    .then((module) => {
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

class PanelBoundary extends Component<
  { children: ReactNode; retry: () => void; version: number; taskCount: number },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <LoadFailure retry={this.props.retry} version={this.props.version} taskCount={this.props.taskCount} />
    ) : (
      this.props.children
    );
  }
}
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

export function PlanAlignmentLoader(props: PlanAlignmentProps & { anchorRef?: Ref<HTMLDivElement> }) {
  const [Panel, setPanel] = useState<Panel | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const plan = props.detail.run.plan;
  useEffect(() => {
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
