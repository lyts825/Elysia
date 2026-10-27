// 启动 Electron 主进程并协调桌面窗口与本地服务。
const { app, BrowserWindow, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdirSync, appendFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { attachServices } = require('./services.cjs');
const { allowedLocalNavigation } = require('./navigation.cjs');
const { createStartupDiagnostics } = require('./startup-diagnostics.cjs');
const { waitForLaunchBuild } = require('./launch-handshake.cjs');
const { createBuildLease } = require('../../scripts/launch-cache.cjs');
const root = path.resolve(__dirname, '../..');
const packaged = app.isPackaged;
const hiddenLaunch = process.env.ELYSIA_DESKTOP_HIDDEN === '1';
const iconPath = path.join(
  root,
  'assets',
  'brand',
  process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png',
);
const data = path.resolve(
  process.env.ELYSIA_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Elysia'),
);
// Electron 配置与业务数据共用所选数据目录，但桌面偏好单独放入 desktop 子目录。
app.setName('Elysia');
app.setPath('userData', path.join(data, 'desktop'));
app.setAppUserModelId('local.elysia.desktop');
app.enableSandbox();
let window,
  backend,
  diagnostics,
  uiOrigin,
  buildLease,
  quitting = false,
  ready = false;
const logFile = packaged
  ? path.join(data, 'logs', 'desktop.log')
  : path.join(root, '.elysia-runtime', 'desktop.log');
mkdirSync(path.dirname(logFile), { recursive: true });
const log = (text) => appendFileSync(logFile, new Date().toISOString() + ' ' + text + '\n');
/**
 * 只执行一次关闭流程，先通知仍连接的后端安全退出，再尽力刷新诊断和关闭构建租约。
 * quitting 同时让窗口及 app 的关闭事件放行，避免安全关闭过程中递归触发新的关闭流程。
 */
async function shutdown() {
  if (quitting) return;
  quitting = true;
  if (window && !window.isDestroyed()) window.setTitle('Elysia · 正在安全停止…');
  if (backend && backend.exitCode === null) {
    await new Promise((resolve) => {
      backend.once('exit', resolve);
      if (backend.connected) backend.send({ type: 'shutdown' });
      else resolve();
    });
  }
  if (diagnostics)
    await Promise.race([diagnostics.flush(), new Promise((resolve) => setTimeout(resolve, 500))]);
  try {
    buildLease?.close();
  } catch (error) {
    log('构建保留记录未正常关闭：' + error.message);
  }
  app.quit();
}
// 新实例未取得锁时通知启动器，已有窗口由 second-instance 事件激活。
if (!app.requestSingleInstanceLock()) {
  if (process.send) process.send({ type: 'desktop-focused' }, () => app.quit());
  else app.quit();
} else {
  const launchBuild = packaged
    ? Promise.resolve().then(() => require('./packaged.cjs').packagedBuild(root))
    : waitForLaunchBuild(process, process.env.ELYSIA_LAUNCH_HANDSHAKE === '1');
  // 安装包直接校验内置资源；源码启动等待启动器返回按输入摘要保存的构建。
  // Attach immediately: a launcher failure may arrive before Electron's ready event.
  launchBuild.catch(() => {});
  app.on('second-instance', () => {
    if (window && !hiddenLaunch) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault();
      void shutdown();
    }
  });
  app.on('window-all-closed', () => void shutdown());
  app
    .whenReady()
    .then(async () => {
      const prepared = await launchBuild;
      if (prepared && !packaged) buildLease = createBuildLease(prepared.build.directory);
      let launchMarks = prepared?.marks;
      if (!prepared) {
        try {
          launchMarks = JSON.parse((process.env.ELYSIA_LAUNCH_MARKS || '').slice(0, 4096));
        } catch {}
      }
      diagnostics = createStartupDiagnostics(data, {
        id: process.env.ELYSIA_LAUNCH_ID,
        startedAt: process.env.ELYSIA_LAUNCH_STARTED_AT,
        build: prepared?.build.mode || process.env.ELYSIA_LAUNCH_BUILD,
        marks: launchMarks,
      });
      Menu.setApplicationMenu(null);
      // 页面使用隔离上下文和沙箱；本机能力只能经 preload 暴露的接口访问。
      window = new BrowserWindow({
        title: 'Elysia',
        icon: iconPath,
        width: 1480,
        height: 960,
        minWidth: 1000,
        minHeight: 680,
        backgroundColor: '#faf8f9',
        show: false,
        webPreferences: {
          partition: 'elysia-desktop',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          spellcheck: false,
          preload: path.join(__dirname, 'preload.cjs'),
        },
      });
      if (process.platform === 'win32') {
        window.setAppDetails({
          appId: 'local.elysia.desktop',
          appIconPath: iconPath,
          appIconIndex: 0,
          relaunchCommand: packaged
            ? `"${process.execPath}"`
            : `"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')}" "${path.join(root, 'Start-Elysia.vbs')}"`,
          relaunchDisplayName: 'Elysia',
        });
      }
      // 默认拒绝浏览器权限、新窗口和 webview；资源预览由受限导航规则控制。
      window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      const startingUrl = pathToFileURL(path.join(__dirname, 'starting.html')).href;
      const allowed = (url, main) =>
        uiOrigin
          ? allowedLocalNavigation(url, window.webContents.getURL(), uiOrigin, main)
          : main && url === startingUrl;
      // 服务尚未就绪时只能打开固定启动页；就绪后切换为本地服务的导航白名单。
      window.webContents.on('will-frame-navigate', (event) => {
        if (!allowed(event.url, event.isMainFrame)) event.preventDefault();
      });
      window.webContents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
        if (!allowed(url, isMainFrame)) event.preventDefault();
      });
      const desktopService = attachServices(window, data, () => uiOrigin, { diagnostics });
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault();
          void shutdown();
        }
      });
      await window.loadFile(path.join(__dirname, 'starting.html'));
      // 先展示轻量窗口再启动后端；偏好和媒体加载不会阻塞服务创建。
      if (!hiddenLaunch) window.show();
      diagnostics.mark('window-visible', hiddenLaunch ? 'skipped' : 'ok');
      const dev = !packaged && process.env.ELYSIA_DEV === '1';
      const backendEnvironment = {
        ...process.env,
        ELYSIA_DATA_DIR: data,
        ELYSIA_DESKTOP: '1',
        ...(prepared
          ? { ELYSIA_WEB_ROOT: prepared.build.web, ELYSIA_RESOURCE_ROOT: prepared.build.resources }
          : {}),
      };
      if (packaged) {
        // 发行版使用随包 Node 和资源路径，不继承可改变模块解析或启动行为的 Node 配置。
        backendEnvironment.ELYSIA_DEV = '0';
        delete backendEnvironment.NODE_OPTIONS;
        delete backendEnvironment.NODE_PATH;
        delete backendEnvironment.ELECTRON_RUN_AS_NODE;
      }
      backend = spawn(
        packaged ? prepared.build.node : process.env.ELYSIA_NODE_BINARY || 'node',
        dev
          ? ['--import', 'tsx', 'apps/server/src/index.ts']
          : [prepared?.build.server || 'apps/server/dist/apps/server/src/index.js'],
        {
          cwd: root,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: backendEnvironment,
        },
      );
      if (backend.pid) buildLease?.backend(backend.pid);
      let failed = false;
      // 后端错误、退出与加载失败可能竞争，只展示一次失败并进入统一关闭流程。
      const fail = (message) => {
        if (failed || quitting) return;
        failed = true;
        log(message);
        if (process.send) process.send({ type: 'desktop-error', message });
        dialog.showErrorBox(
          'Elysia 启动失败',
          message + '\n\n请先安全关闭其他 Elysia 服务，再重新打开。日志：' + logFile,
        );
        void shutdown();
      };
      backend.stderr.on('data', (value) => log(value.toString()));
      backend.stdout.on('data', (value) => log(value.toString()));
      backend.on('error', (error) => fail(error.message));
      backend.on('exit', (code) => {
        if (!quitting) {
          if (!ready || code) fail('本机服务已退出，状态码 ' + code);
          else void shutdown();
        }
      });
      backend.on('message', async (message) => {
        if (message?.type === 'desktop-request' && typeof message.id === 'string') {
          // 后端不能直接使用 Electron 安全存储/系统浏览器，通过带 ID 的请求回执桥调用。
          try {
            const value = await desktopService(message);
            if (backend.connected) backend.send({ type: 'desktop-response', id: message.id, value });
          } catch (error) {
            if (backend.connected)
              backend.send({ type: 'desktop-response', id: message.id, error: error.message });
          }
          return;
        }
        if (message.type === 'startup-error') return fail(message.message);
        if (message.type !== 'ready') return;
        // 安装包禁止连接到与清单版本不一致的服务，避免前后端协议混用。
        if (packaged && message.version !== prepared.manifest.version)
          return fail('分发包与本机服务版本不一致');
        diagnostics.mark('backend-ready');
        try {
          const origin = new URL(message.origin).origin;
          uiOrigin = origin;
          log(`ready v${message.version} port=${message.port} preferred=${message.preferredPort}`);
          await window.loadURL(message.bootstrapUrl);
          // 页面加载完成后才向启动器报告 ready，避免把后端启动当作整个桌面已就绪。
          diagnostics.mark('web-loaded');
          ready = true;
          window.setTitle(`Elysia · ${message.version}`);
          if (!hiddenLaunch) {
            window.show();
            window.focus();
          }
          if (process.send) process.send({ type: 'desktop-ready', port: message.port });
        } catch (error) {
          fail(error.message);
        }
      });
    })
    .catch((error) => {
      if (process.send && process.connected) process.send({ type: 'desktop-error', message: error.message });
      dialog.showErrorBox('Elysia', error.message);
      void shutdown();
    });
}
