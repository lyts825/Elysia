/**
 * 启动 Electron 主进程并协调桌面窗口与本地服务。
 * EN: Start the Electron main process and coordinate the desktop window with the local backend.
 *
 * 负责单实例、启动握手、窗口导航及服务装配；渲染层通过预加载桥申请桌面能力，避免直接访问主进程实现。
 * EN: Own single-instance startup, build handshakes, navigation, and service assembly; renderer access goes through the preload bridge.
 */
const { app, BrowserWindow, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdirSync, appendFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { attachServices } = require('./services.cjs');
const { allowedLocalNavigation } = require('./navigation.cjs');
const { createStartupDiagnostics } = require('./startup-diagnostics.cjs');
const { createBackendSupervisor, backendReadyLocation } = require('./backend-supervisor.cjs');
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
// EN: Use the selected data directory for Electron and application data, while keeping desktop
// preferences in a separate desktop subdirectory.
app.setName('Elysia');
app.setPath('userData', path.join(data, 'desktop'));
app.setAppUserModelId('local.elysia.desktop');
app.enableSandbox();
let window,
  backend,
  diagnostics,
  uiOrigin,
  buildLease,
  supervisor,
  backendVersion,
  quitting = false,
  ready = false;
const logFile = packaged
  ? path.join(data, 'logs', 'desktop.log')
  : path.join(root, '.elysia-runtime', 'desktop.log');
mkdirSync(path.dirname(logFile), { recursive: true });
/**
 * 向桌面日志追加带ISO时间戳的一行诊断文本。
 * EN: Append one ISO-timestamped diagnostic line to the desktop log.
 */
const log = (text) => appendFileSync(logFile, new Date().toISOString() + ' ' + text + '\n');
/**
 * 只执行一次关闭流程，先通知仍连接的后端安全退出，再尽力刷新诊断和关闭构建租约。
 * quitting 同时让窗口及 app 的关闭事件放行，避免安全关闭过程中递归触发新的关闭流程。
 * EN: Run shutdown once: request safe backend termination, then attempt to flush diagnostics and
 * close the build lease. The quitting flag also lets window and app close events proceed without
 * recursively starting another shutdown.
 */
async function shutdown() {
  if (quitting) return;
  quitting = true;
  supervisor?.stop();
  if (window && !window.isDestroyed()) window.setTitle('Elysia · 正在安全停止…');
  const child = backend;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      try {
        if (child.connected) child.send({ type: 'shutdown' }, (error) => error && resolve());
        else resolve();
      } catch {
        resolve();
      }
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
// EN: Notify the launcher when a new instance fails to acquire the lock; the second-instance event
// activates the existing window.
if (!app.requestSingleInstanceLock()) {
  if (process.send) process.send({ type: 'desktop-focused' }, () => app.quit());
  else app.quit();
} else {
  const launchBuild = packaged
    ? Promise.resolve().then(() => require('./packaged.cjs').packagedBuild(root))
    : waitForLaunchBuild(process, process.env.ELYSIA_LAUNCH_HANDSHAKE === '1');
  // 安装包直接核验内置资源，源码启动等待启动器返回摘要构建；立即观察握手失败，因为错误可能早于 Electron ready 事件到达。
  // EN: Packaged launches verify bundled resources; source launches await the launcher build keyed by
  // its input digest. Observe handshake rejection immediately because launcher failure can precede
  // Electron readiness.
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
      // EN: Use context isolation and sandboxing; expose native capabilities only through the preload
      // bridge.
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
      // 标题由主进程呈现服务健康状态，页面更新不得覆盖恢复或待人工处理提示。
      // EN: Keep supervisor status in the native title even when the page changes its own title.
      window.on('page-title-updated', (event) => event.preventDefault());
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
      // EN: Deny browser permissions, new windows, and webviews by default. Resource previews follow the
      // restricted navigation policy.
      window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      const startingUrl = pathToFileURL(path.join(__dirname, 'starting.html')).href;
      /**
       * 根据后端是否已就绪选择启动页或本地导航白名单。
       * EN: Choose the fixed startup page or local navigation policy according to backend readiness.
       */
      const allowed = (url, main) =>
        uiOrigin
          ? allowedLocalNavigation(url, window.webContents.getURL(), uiOrigin, main)
          : main && url === startingUrl;
      // 服务尚未就绪时只能打开固定启动页；就绪后切换为本地服务的导航白名单。
      // EN: Before the backend is ready, allow only the fixed startup page. Afterwards, enforce the
      // local-service navigation allowlist.
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
      // EN: Show a lightweight window before starting the backend. Preference and media reads do not gate
      // service creation.
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
        // EN: Use the bundled Node runtime and resource paths for distributions; remove inherited Node
        // settings that could alter startup or module resolution.
        backendEnvironment.ELYSIA_DEV = '0';
        delete backendEnvironment.NODE_OPTIONS;
        delete backendEnvironment.NODE_PATH;
        delete backendEnvironment.ELECTRON_RUN_AS_NODE;
      }
      let failed = false;
      const failInitial = () => {
        if (failed || quitting) return;
        failed = true;
        const message = '本机服务未能完成启动或安全握手';
        if (process.send && process.connected) process.send({ type: 'desktop-error', message }, () => {});
        dialog.showErrorBox(
          'Elysia 启动失败',
          message + '\n\n请先安全关闭其他 Elysia 服务，再重新打开。日志：' + logFile,
        );
        void shutdown();
      };
      const attention = {
        'heartbeat-timeout': '心跳无响应，未自动终止进程',
        'ipc-unavailable': '服务通信异常，未自动终止进程',
        'recovery-failed': '服务恢复失败，请检查日志后重新打开',
        'restart-limit': '5 分钟内已重启 3 次，请检查日志后重新打开',
      };
      supervisor = createBackendSupervisor({
        restart: () => startBackend(),
        onStopped: () => void shutdown(),
        onState: (state) => {
          if (quitting || window.isDestroyed()) return;
          // 仅记录受控状态码，不能记录 IPC 正文、凭据回执或含 bootstrap 的导航错误。
          // EN: Log fixed state codes, never IPC payloads, credentials, or bootstrap-bearing load errors.
          log(
            `backend-supervisor state=${state.status} reason=${state.reason}${state.attempt ? ` attempt=${state.attempt}` : ''}`,
          );
          if (state.reason === 'initial-start-failed') return failInitial();
          const suffix =
            state.status === 'healthy'
              ? `${backendVersion} · 服务正常`
              : state.status === 'attention'
                ? `需人工处理 · ${attention[state.reason] || '本机服务异常'}`
                : state.status === 'recovering'
                  ? `服务恢复中${state.attempt ? `（第 ${state.attempt} 次）` : ''}…`
                  : state.status === 'starting'
                    ? '正在启动本机服务…'
                    : '正在安全停止…';
          window.setTitle('Elysia · ' + suffix);
        },
      });
      /**
       * 每次恢复使用相同构建、数据目录和原恢复流程，重新取得认证；不改变任务授权或停止记录。
       * EN: Restart the same build/data directory through normal recovery and obtain new authentication.
       * Never alter task permissions, execution holds, or uncertain operations here.
       */
      function startBackend() {
        if (quitting || window.isDestroyed()) return;
        const child = spawn(
          packaged ? prepared.build.node : process.env.ELYSIA_NODE_BINARY || 'node',
          dev
            ? ['--import', 'tsx', 'apps/server/src/index.ts']
            : [prepared?.build.server || 'apps/server/dist/apps/server/src/index.js'],
          { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: backendEnvironment },
        );
        backend = child;
        supervisor.attach(child);
        if (child.pid) buildLease?.backend(child.pid);
        let receivedReady = false,
          childReady = false;
        child.stderr.on('data', (value) => {
          if (supervisor.isCurrent(child)) log(value.toString());
        });
        child.stdout.on('data', (value) => {
          if (supervisor.isCurrent(child)) log(value.toString());
        });
        child.on('error', () => {
          if (childReady) supervisor.unavailable(child);
          else supervisor.failed(child);
        });
        child.on('exit', (code, signal) => supervisor.exited(child, code, signal));
        child.on('disconnect', () => supervisor.unavailable(child));
        child.on('message', async (message) => {
          if (!supervisor.isCurrent(child) || quitting || !message || typeof message !== 'object') return;
          if (message.type === 'health-pong') return supervisor.heartbeat(child, message.id);
          if (message.type === 'backend-stopping') return supervisor.stopping(child);
          if (message.type === 'desktop-request' && typeof message.id === 'string') {
            // 异步回执只返回发起请求且仍然有效的子进程，不能随 backend 变量转交给新进程。
            // EN: Return asynchronous credential replies only to the still-current requesting child.
            let reply;
            try {
              reply = { value: await desktopService(message) };
            } catch (error) {
              reply = { error: error.message };
            }
            if (supervisor.isCurrent(child) && child.connected) {
              try {
                child.send({ type: 'desktop-response', id: message.id, ...reply }, () => {});
              } catch {}
            }
            return;
          }
          if (message.type === 'startup-error') return supervisor.failed(child);
          if (message.type !== 'ready' || receivedReady) return;
          receivedReady = true;
          try {
            const location = backendReadyLocation(message, packaged ? prepared.manifest.version : undefined);
            diagnostics.mark('backend-ready');
            const bootstrap = new URL(location.bootstrapUrl);
            // 同窗口、同端口优先保留已有草稿存储和入口；仅携带已识别的入口参数。
            // EN: Reuse the window and preferred ports to retain stored drafts; preserve only the known surface query.
            if (ready && new URL(window.webContents.getURL()).searchParams.get('surface') === 'terminal')
              bootstrap.searchParams.set('surface', 'terminal');
            uiOrigin = location.origin;
            backendEnvironment.ELYSIA_PORT = String(location.port);
            if (dev) backendEnvironment.ELYSIA_WEB_PORT = new URL(location.origin).port;
            log(`ready v${location.version} port=${location.port} preferred=${location.preferredPort}`);
            await window.loadURL(bootstrap.href);
            if (!supervisor.isCurrent(child) || quitting || window.isDestroyed()) return;
            diagnostics.mark('web-loaded');
            backendVersion = location.version;
            childReady = supervisor.ready(child);
            if (!childReady) return;
            const initial = !ready;
            ready = true;
            if (initial && !hiddenLaunch) {
              window.show();
              window.focus();
            }
            if (initial && process.send && process.connected)
              process.send({ type: 'desktop-ready', port: location.port }, () => {});
          } catch {
            supervisor.failed(child);
          }
        });
      }
      startBackend();
    })
    .catch((error) => {
      if (process.send && process.connected) process.send({ type: 'desktop-error', message: error.message });
      dialog.showErrorBox('Elysia', error.message);
      void shutdown();
    });
}
