const { contextBridge, ipcRenderer } = require('electron');
// Only the trusted top-level workbench receives native capabilities.
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('elysia', {
    chooseDirectory: () => ipcRenderer.invoke('elysia:choose-directory'),
    openUsage: () => ipcRenderer.invoke('elysia:open-usage'),
    readStartup: () => ipcRenderer.invoke('elysia:startup-read'),
    saveStartup: (value) => ipcRenderer.invoke('elysia:startup-save', value),
    importStartupMedia: () => ipcRenderer.invoke('elysia:startup-import'),
  });
}
