const { app, BrowserWindow, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdirSync, appendFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { attachServices } = require('./services.cjs');
const { allowedLocalNavigation } = require('./navigation.cjs');
const { createStartupDiagnostics } = require('./startup-diagnostics.cjs');
const { waitForLaunchBuild } = require('./launch-handshake.cjs');
const root = path.resolve(__dirname, '../..');
const iconPath = path.join(
  root,
  'assets',
  'brand',
  process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png',
);
const data = path.resolve(
  process.env.ELYSIA_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Elysia'),
);
app.setName('Elysia');
app.setPath('userData', path.join(data, 'desktop'));
app.setAppUserModelId('local.elysia.desktop');
app.enableSandbox();
let window,
  backend,
  diagnostics,
  uiOrigin,
  quitting = false,
  ready = false;
const logFile = path.join(root, '.elysia-runtime', 'desktop.log');
mkdirSync(path.dirname(logFile), { recursive: true });
const log = (text) => appendFileSync(logFile, new Date().toISOString() + ' ' + text + '\n');
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
  app.quit();
}
if (!app.requestSingleInstanceLock()) {
  if (process.send) process.send({ type: 'desktop-focused' }, () => app.quit());
  else app.quit();
} else {
  const launchBuild = waitForLaunchBuild(process, process.env.ELYSIA_LAUNCH_HANDSHAKE === '1');
  // Attach immediately: a launcher failure may arrive before Electron's ready event.
  launchBuild.catch(() => {});
  app.on('second-instance', () => {
    if (window) {
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
      window = new BrowserWindow({
        title: 'Elysia',
        icon: iconPath,
        width: 1480,
        height: 960,
        minWidth: 1000,
        minHeight: 680,
        backgroundColor: '#f6f7fa',
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
          relaunchCommand: `"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')}" "${path.join(root, 'Start-Elysia.vbs')}"`,
          relaunchDisplayName: 'Elysia',
        });
      }
      window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      const startingUrl = pathToFileURL(path.join(__dirname, 'starting.html')).href;
      const allowed = (url, main) =>
        uiOrigin
          ? allowedLocalNavigation(url, window.webContents.getURL(), uiOrigin, main)
          : main && url === startingUrl;
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
      window.show();
      diagnostics.mark('window-visible');
      const dev = process.env.ELYSIA_DEV === '1';
      backend = spawn(
        process.env.ELYSIA_NODE_BINARY || 'node',
        dev
          ? ['--import', 'tsx', 'apps/server/src/index.ts']
          : [prepared?.build.server || 'apps/server/dist/apps/server/src/index.js'],
        {
          cwd: root,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: {
            ...process.env,
            ELYSIA_DATA_DIR: data,
            ELYSIA_DESKTOP: '1',
            ...(prepared
              ? { ELYSIA_WEB_ROOT: prepared.build.web, ELYSIA_RESOURCE_ROOT: prepared.build.resources }
              : {}),
          },
        },
      );
      let failed = false;
      const fail = (message) => {
        if (failed || quitting) return;
        failed = true;
        log(message);
        if (process.send) process.send({ type: 'desktop-error', message });
        dialog.showErrorBox(
          'Elysia 启动失败',
          message + '\n\n如果已有命令行服务，请先执行 pnpm stop，再重新打开。日志：' + logFile,
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
        diagnostics.mark('backend-ready');
        try {
          const origin = new URL(message.origin).origin;
          uiOrigin = origin;
          log(`ready v${message.version} port=${message.port} preferred=${message.preferredPort}`);
          await window.loadURL(message.bootstrapUrl);
          diagnostics.mark('web-loaded');
          ready = true;
          window.setTitle(`Elysia · ${message.version}`);
          window.show();
          window.focus();
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
