declare global {
  interface Window {
    elysia?: {
      chooseDirectory(): Promise<string | null>;
      openUsage(): Promise<void>;
      readStartup?(): Promise<unknown>;
      saveStartup?(value: import('./StartupPreferences').StartupPreferences): Promise<unknown>;
      importStartupMedia?(): Promise<import('./StartupPreferences').StartupMedia | null>;
    };
  }
}
export function manageUsage() {
  if (window.elysia) void window.elysia.openUsage();
  else window.open('https://chatgpt.com/settings/usage', '_blank', 'noopener,noreferrer');
}
