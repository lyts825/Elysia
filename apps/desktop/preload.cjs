// 通过 Electron 预加载桥向页面暴露桌面能力。
const { contextBridge, ipcRenderer } = require('electron');
// 暴露显式允许的 IPC 方法，不向页面暴露 Node 或 Electron 对象。
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
    onTaskNotification: (callback) => {
      const receive = (_event, value) => {
        if (
          typeof callback !== 'function' ||
          !value ||
          !['native', 'terminal'].includes(value.surface) ||
          typeof value.taskId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.taskId)
        )
          return;
        callback({ surface: value.surface, taskId: value.taskId });
      };
      ipcRenderer.on('elysia:notification-open', receive);
      return () => ipcRenderer.removeListener('elysia:notification-open', receive);
    },
  });
}
