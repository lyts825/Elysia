/**
 * 按需加载面板组件并处理加载状态。
 * 为可选面板复用React.lazy、Suspense及错误边界，统一加载和恢复提示；局部模块失败保留外层会话。
 * EN: Loads optional panel components on demand and handles loading state. Shares React.lazy, Suspense, and an error boundary for optional panels with consistent loading/recovery feedback, containing local failures within the conversation UI.
 */
import React, { Component, Suspense, useId, type ComponentType, type ReactNode } from 'react';
import './deferred-panel.css';

/**
 * 显示可访问的面板加载或失败状态；失败提供页面重载入口，读取中保持aria-busy。
 * EN: Renders accessible loading or failure feedback for a panel; failure offers a page reload while loading keeps aria-busy set.
 */
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
  /**
   * 将面板加载或渲染失败限制在局部边界，不中断外层会话。
   * EN: Contain panel loading or rendering failures within a local boundary rather than interrupting the surrounding conversation.
   */
  state = { failed: false };
  /**
   * 把子树渲染或懒加载异常转换为边界失败状态，由render显示恢复入口。
   * EN: Converts a child render or lazy-loading exception into boundary failure state so render can show recovery controls.
   */
  static getDerivedStateFromError() {
    return { failed: true };
  }
  /**
   * 按错误边界状态选择局部失败反馈或原始子树，避免可选面板异常扩散到外层。
   * EN: Selects local failure feedback or the original children based on boundary state, containing failures in an optional panel.
   */
  render() {
    if (this.state.failed) return <PanelFeedback label={this.props.label} failed />;
    return this.props.children;
  }
}
/**
 * 创建一个共享 React.lazy 包装器，使可选面板只有挂载时才加载代码。
 * Suspense 展示读取状态，错误边界隔离 chunk 或渲染失败；恢复入口明确重载整个页面，
 * 不把局部失败传播为外层会话崩溃。
 * EN: Create one shared React.lazy wrapper so optional panel code loads only when mounted. Suspense presents loading state and an error boundary isolates chunk or render failures. Recovery explicitly reloads the page rather than turning a local failure into a conversation crash.
 */
export function deferredPanel<P extends object>(load: () => Promise<ComponentType<P>>, label: string) {
  /**
   * 缓存 React.lazy 包装器；面板显示前只展示加载状态。
   * EN: Cache the React.lazy wrapper and show loading state until the panel is available.
   */
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
