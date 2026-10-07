const { app, BrowserWindow, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdirSync, appendFileSync } = require('node:fs');
const { attachServices } = require('./services.cjs');
const root = path.resolve(__dirname, '../..');
const data = path.resolve(
  process.env.ELYSIA_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Elysia'),
);
app.setName('Elysia');
app.setPath('userData', path.join(data, 'desktop'));
app.setAppUserModelId('local.elysia.desktop');
app.enableSandbox();
let window,
  backend,
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
  app.quit();
}
if (!app.requestSingleInstanceLock()) {
  if (process.send) process.send({ type: 'desktop-focused' }, () => app.quit());
  else app.quit();
} else {
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
      Menu.setApplicationMenu(null);
      window = new BrowserWindow({
        title: 'Elysia',
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
      window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      const desktopService = attachServices(window, data, () => uiOrigin);
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault();
          void shutdown();
        }
      });
      await window.loadFile(path.join(__dirname, 'starting.html'));
      window.show();
      const dev = process.env.ELYSIA_DEV === '1';
      backend = spawn(
        process.env.ELYSIA_NODE_BINARY || 'node',
        dev ? ['--import', 'tsx', 'apps/server/src/index.ts'] : ['apps/server/dist/apps/server/src/index.js'],
        {
          cwd: root,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, ELYSIA_DATA_DIR: data, ELYSIA_DESKTOP: '1' },
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
        try {
          const origin = new URL(message.origin).origin;
          uiOrigin = origin;
          log(`ready v${message.version} port=${message.port} preferred=${message.preferredPort}`);
          const allowed = (url, main) => {
            try {
              const parsed = new URL(url);
              return (
                parsed.origin === origin &&
                (main ? parsed.pathname === '/' : parsed.pathname.startsWith('/preview/'))
              );
            } catch {
              return false;
            }
          };
          window.webContents.on('will-frame-navigate', (event) => {
            if (!allowed(event.url, event.isMainFrame)) event.preventDefault();
          });
          window.webContents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
            if (!allowed(url, isMainFrame)) event.preventDefault();
          });
          await window.loadURL(message.bootstrapUrl);
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
      dialog.showErrorBox('Elysia', error.message);
      void shutdown();
    });
}
