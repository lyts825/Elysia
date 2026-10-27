// 协调应用启动、构建及桌面进程。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildLaunch } from './launch-build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const launchStartedAt = performance.timeOrigin + performance.now(),
  launchId = randomUUID(),
  launchMarks = [];
const markLaunch = (stage) =>
  launchMarks.push({
    stage,
    status: 'ok',
    elapsedMs: Math.round((performance.timeOrigin + performance.now() - launchStartedAt) * 10) / 10,
  });
process.chdir(root);
try {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor !== 24 || nodeMinor < 15) throw new Error('请先安装 Node.js 24.15 或更高版本的 24 LTS');
  let electron;
  try {
    electron = require('electron');
  } catch {
    throw new Error('缺少 Electron 启动依赖，请先执行 pnpm install --frozen-lockfile，再重新打开。');
  }
  const runtime = path.join(root, '.elysia-runtime');
  mkdirSync(runtime, { recursive: true });
  const environment = {
    ...process.env,
    ELYSIA_NODE_BINARY: process.execPath,
    ELYSIA_DEV: process.argv.includes('--dev') ? '1' : '0',
    ELYSIA_LAUNCH_ID: launchId,
    ELYSIA_LAUNCH_STARTED_AT: String(launchStartedAt),
    ELYSIA_LAUNCH_HANDSHAKE: '1',
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const output = openSync(path.join(runtime, 'desktop-launch.log'), 'a');
  const child = spawn(electron, ['apps/desktop/main.cjs'], {
    cwd: root,
    detached: true,
    windowsHide: false,
    stdio: ['ignore', output, output, 'ipc'],
    env: environment,
  });
  closeSync(output);
  try {
    await new Promise((resolve, reject) => {
      let building = false,
        finished = false;
      const timeout = setTimeout(
        () => finish(new Error('桌面窗口启动超时，请查看 desktop-launch.log')),
        300000,
      );
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      child.on('message', (message) => {
        if (message?.type === 'desktop-build-request' && !building && !finished) {
          building = true;
          try {
            // The actual Electron owner holds its lock throughout the build and backend startup.
            const build = buildLaunch(root, markLaunch);
            if (!child.connected) throw new Error('桌面启动进程已退出，未启动新服务');
            child.send({ type: 'desktop-build-ready', build, marks: launchMarks });
          } catch (error) {
            if (child.connected) child.send({ type: 'desktop-build-error', message: error.message });
            finish(error);
          }
        }
        if (['desktop-ready', 'desktop-focused'].includes(message?.type)) finish();
        if (message?.type === 'desktop-error') finish(new Error(message.message));
      });
      child.once('error', finish);
      child.once('exit', (code) => finish(new Error('桌面进程在就绪前退出：' + code)));
    });
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
  console.log('已启动 Elysia 独立桌面窗口。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
