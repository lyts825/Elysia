const { contextBridge, ipcRenderer } = require('electron');
// Only the trusted top-level workbench receives native capabilities.
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('elysia', {
    chooseDirectory: () => ipcRenderer.invoke('elysia:choose-directory'),
    openUsage: () => ipcRenderer.invoke('elysia:open-usage'),
    readStartup: () => ipcRenderer.invoke('elysia:startup-read'),
    readStartupMedia: (media) => ipcRenderer.invoke('elysia:startup-media', media),
    saveStartup: (value, upload) => ipcRenderer.invoke('elysia:startup-save', value, upload),
    importStartupMedia: () => ipcRenderer.invoke('elysia:startup-import'),
    markStartupStage: (value) => ipcRenderer.invoke('elysia:startup-mark', value),
    readStartupDiagnostics: () => ipcRenderer.invoke('elysia:startup-diagnostics'),
    readTaskNotifications: () => ipcRenderer.invoke('elysia:notifications-read'),
    setTaskNotifications: (value) => ipcRenderer.invoke('elysia:notifications-set', value),
    notifyTaskStatus: (value) => ipcRenderer.invoke('elysia:notifications-status', value),
  });
}
