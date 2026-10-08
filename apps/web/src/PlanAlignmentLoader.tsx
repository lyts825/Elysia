import { Component, useEffect, useState, type ComponentType, type ReactNode, type Ref } from 'react';
import { PLAN_ALIGNMENT_API_VERSION, type PlanAlignmentProps } from './features/plan-alignment/types';
import entryUrl from 'virtual:elysia-plan-alignment';
import './features/plan-alignment/plan-alignment.css';

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

class PanelBoundary extends Component<{ children: ReactNode; retry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <LoadFailure retry={this.props.retry} /> : this.props.children;
  }
}
function LoadFailure({ retry }: { retry: () => void }) {
  return (
    <div className="plan-card" role="alert">
      <h3>计划模块加载失败</h3>
      <p>计划记录已保留，请重试加载。</p>
      <button className="secondary" onClick={retry}>
        重试加载
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
    <div ref={props.anchorRef} className="plan-module">
      {failed ? (
        <LoadFailure retry={retry} />
      ) : Panel ? (
        <PanelBoundary key={generation + ':' + props.detail.run.id + ':' + plan.version} retry={retry}>
          <Panel {...props} />
        </PanelBoundary>
      ) : (
        <div className="plan-card" role="status" aria-busy="true">
          正在加载计划对齐…
        </div>
      )}
    </div>
  );
}
