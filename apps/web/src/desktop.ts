/**
 * 定义浏览器界面与桌面宿主之间可用的桥接能力。
 * 声明宿主暴露的目录选择、启动偏好、诊断与任务通知接口，并为用量页提供浏览器回退；只调用已存在桥接能力。
 * EN: Defines browser-to-desktop host bridge capabilities. Declares host directory selection, startup preferences, diagnostics, and task-notification interfaces with a browser fallback for usage settings, using only available bridge capabilities.
 */
declare global {
  interface Window {
    /**
     * 桌面预加载脚本可提供该桥；普通浏览器没有 elysia 对象。
     * EN: Desktop preload may supply the bridge; ordinary browsers have no elysia object.
     */
    elysia?: {
      chooseDirectory(): Promise<string | null>;
      openUsage(): Promise<void>;
      readStartup?(): Promise<{ config: unknown; issue: string; bootVisualShown: boolean }>;
      readStartupMedia?(media: import('./StartupPreferences').StartupMedia): Promise<string>;
      saveStartup?(
        value: import('./StartupPreferences').StartupPreferences,
        upload?: { media: import('./StartupPreferences').StartupMedia; dataUrl: string },
      ): Promise<unknown>;
      importStartupMedia?(): Promise<import('./StartupPreferences').StartupMediaUpload | null>;
      markStartupStage?(value: {
        stage: import('./StartupDiagnostics').StartupStage;
        status: import('./StartupDiagnostics').StartupStageStatus;
        surface?: 'native' | 'terminal';
        atEpoch: number;
      }): Promise<void>;
      readStartupDiagnostics?(): Promise<import('./StartupDiagnostics').StartupDiagnosticSnapshot>;
      readTaskNotifications?(): Promise<{ native: boolean; terminal: boolean; available: boolean }>;
      setTaskNotifications?(value: {
        surface: 'native' | 'terminal';
        enabled: boolean;
      }): Promise<{ native: boolean; terminal: boolean; available: boolean }>;
      notifyTaskStatus?(value: {
        surface: 'native' | 'terminal';
        taskId: string;
        status: 'DONE' | 'WAITING' | 'FAILED' | 'UNCERTAIN';
        revision: number;
      }): Promise<boolean>;
      /**
       * 注册桌面通知点击监听；返回的函数必须在组件清理时调用。
       * EN: Register notification-click listener and call returned cleanup when component releases it.
       */
      onTaskNotification?(
        callback: (value: { surface: 'native' | 'terminal'; taskId: string }) => void,
      ): () => void;
    };
  }
}
/**
 * 桌面环境由宿主打开用量页；浏览器环境使用隔离的新标签。
 * EN: Desktop host opens usage settings; browser fallback opens an isolated new tab.
 */
export function manageUsage() {
  if (window.elysia) void window.elysia.openUsage();
  else window.open('https://chatgpt.com/settings/usage', '_blank', 'noopener,noreferrer');
}
