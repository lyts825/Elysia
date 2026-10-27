/**
 * 通过 Electron 预加载桥向页面暴露桌面能力。
 * EN: Expose approved desktop capabilities to pages through the Electron preload bridge.
 *
 * 按明确的 IPC 通道提供小型能力接口，并返回事件退订函数；页面不获得任意主进程调用入口。
 * EN: Expose small capability methods over explicit IPC channels and return unsubscribe functions for events instead of providing arbitrary main-process invocation.
 */
const { contextBridge, ipcRenderer } = require('electron');
// 只向可信顶层工作台暴露明确允许的 IPC 方法，不向页面暴露 Node 或 Electron 对象。
// EN: Expose explicit IPC methods only to the trusted top-level workbench, without exposing Node or
// Electron objects.
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('elysia', {
    /** 打开目录选择器，返回选择路径或取消结果。 EN: Open the directory picker and return its path or cancellation. */
    chooseDirectory: () => ipcRenderer.invoke('elysia:choose-directory'),
    /** 请求主进程打开固定用量页面。 EN: Ask the main process to open the fixed usage page. */
    openUsage: () => ipcRenderer.invoke('elysia:open-usage'),
    /** 读取启动偏好及问题提示，不修改配置。 EN: Read startup preferences and issues without changing configuration. */
    readStartup: () => ipcRenderer.invoke('elysia:startup-read'),
    /** 按已保存媒体身份读取本地data URL。 EN: Read a local media data URL using its saved identity. */
    readStartupMedia: (media) => ipcRenderer.invoke('elysia:startup-media', media),
    /** 转发偏好和可选上传，主进程校验后保存。 EN: Forward preferences and optional upload for main-process validation and persistence. */
    saveStartup: (value, upload) => ipcRenderer.invoke('elysia:startup-save', value, upload),
    /** 由系统文件选择器导入待保存动画。 EN: Import an animation through the system picker as an unsaved upload. */
    importStartupMedia: () => ipcRenderer.invoke('elysia:startup-import'),
    /** 上报页面允许的启动阶段，主进程仍验证来源。 EN: Report an allowed renderer startup stage; the main process still validates origin. */
    markStartupStage: (value) => ipcRenderer.invoke('elysia:startup-mark', value),
    /** 读取有界启动诊断记录。 EN: Read bounded startup diagnostic records. */
    readStartupDiagnostics: () => ipcRenderer.invoke('elysia:startup-diagnostics'),
    /** 读取两入口通知偏好及系统支持状态。 EN: Read surface notification preferences and operating-system support. */
    readTaskNotifications: () => ipcRenderer.invoke('elysia:notifications-read'),
    /** 保存单入口通知开关，失败通过Promise拒绝。 EN: Persist one surface notification toggle, rejecting the promise on failure. */
    setTaskNotifications: (value) => ipcRenderer.invoke('elysia:notifications-set', value),
    /** 提交任务版本通知，去重与展示由主进程执行。 EN: Submit a task-revision notification for main-process deduplication and display. */
    notifyTaskStatus: (value) => ipcRenderer.invoke('elysia:notifications-status', value),
    /** 订阅安全通知定位事件并返回取消订阅函数。 EN: Subscribe to validated notification navigation events and return an unsubscribe function. */
    onTaskNotification: (callback) => {
      /**
       * 核对通知入口与任务UUID后仅将安全定位字段交给页面回调。
       * EN: Validate notification surface/task UUID and pass only safe navigation fields to the page callback.
       */
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
