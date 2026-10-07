declare global {
  interface Window {
    elysia?: { chooseDirectory(): Promise<string | null>; openUsage(): Promise<void> };
  }
}
export function manageUsage() {
  if (window.elysia) void window.elysia.openUsage();
  else window.open('https://chatgpt.com/settings/usage', '_blank', 'noopener,noreferrer');
}
