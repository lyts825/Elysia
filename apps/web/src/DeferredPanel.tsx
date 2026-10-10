import React, { Component, Suspense, type ComponentType, type ReactNode } from 'react';

class PanelBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div role="alert" className="field-help">
          {this.props.label}加载失败。
          <button className="quiet-button" onClick={() => location.reload()}>
            重新加载界面
          </button>
        </div>
      );
    return this.props.children;
  }
}
/** Optional panels load only when visible; a failed chunk leaves the conversation usable. */
export function deferredPanel<P extends object>(load: () => Promise<ComponentType<P>>, label: string) {
  const View = React.lazy(async () => ({ default: await load() }));
  return function DeferredPanel(props: P) {
    return (
      <PanelBoundary label={label}>
        <Suspense
          fallback={
            <p className="field-help" role="status">
              正在准备{label}…
            </p>
          }
        >
          <View {...props} />
        </Suspense>
      </PanelBoundary>
    );
  };
}
