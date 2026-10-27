/* 定义浏览器界面与桌面宿主之间可用的桥接能力。 */
declare global {
  interface Window {
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
      onTaskNotification?(
        callback: (value: { surface: 'native' | 'terminal'; taskId: string }) => void,
      ): () => void;
    };
  }
}
export function manageUsage() {
  if (window.elysia) void window.elysia.openUsage();
  else window.open('https://chatgpt.com/settings/usage', '_blank', 'noopener,noreferrer');
}
