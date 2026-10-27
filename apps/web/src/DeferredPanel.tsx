/* 按需加载面板组件并处理加载状态。 */
import React, { Component, Suspense, useId, type ComponentType, type ReactNode } from 'react';
import './deferred-panel.css';

function PanelFeedback({ label, failed = false }: { label: string; failed?: boolean }) {
  const scopeId = useId();
  return (
    <section
      className="deferred-panel-feedback"
      data-state={failed ? 'failed' : 'loading'}
      role={failed ? 'alert' : 'status'}
      aria-busy={!failed}
    >
      <div className="deferred-panel-message">
        <p className="deferred-panel-state">{failed ? '面板加载失败' : '正在准备面板'}</p>
        <h3 className="deferred-panel-label" tabIndex={0}>
          {label}
        </h3>
        {failed && <p id={scopeId}>重新加载会更新整个界面。</p>}
      </div>
      {failed && (
        <button
          type="button"
          className="secondary"
          aria-describedby={scopeId}
          onClick={() => location.reload()}
        >
          重新加载整个界面
        </button>
      )}
    </section>
  );
}

class PanelBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  // 将面板加载或渲染失败限制在局部边界，不中断外层会话。
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <PanelFeedback label={this.props.label} failed />;
    return this.props.children;
  }
}
/**
 * 创建一个共享 React.lazy 包装器，使可选面板只有挂载时才加载代码。
 * Suspense 展示读取状态，错误边界隔离 chunk 或渲染失败；恢复入口明确重载整个页面，
 * 不把局部失败传播为外层会话崩溃。
 */
export function deferredPanel<P extends object>(load: () => Promise<ComponentType<P>>, label: string) {
  // 缓存 React.lazy 包装器；面板显示前只展示加载状态。
  const View = React.lazy(async () => ({ default: await load() }));
  return function DeferredPanel(props: P) {
    return (
      <PanelBoundary label={label}>
        <Suspense fallback={<PanelFeedback label={label} />}>
          <View {...props} />
        </Suspense>
      </PanelBoundary>
    );
  };
}
