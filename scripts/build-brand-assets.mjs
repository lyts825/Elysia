/**
 * 通过 Electron 启动品牌资源渲染流程。
 * EN: Start the Electron process that renders brand assets.
 *
 * 使用项目固定的 Electron 渲染环境调用资源生成脚本，退出码反映生成结果；资源样式和尺寸由实际渲染脚本定义。
 * EN: Invoke asset generation in the project Electron environment and propagate its result; the rendering script defines artwork and dimensions.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const environment = { ...process.env };
// 资源渲染需要真正的 Electron 窗口环境，不能继承 Node 模式。
// EN: Rendering requires an actual Electron window environment, so remove inherited Node-only mode.
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require('electron'),
  [fileURLToPath(new URL('./render-brand-assets.cjs', import.meta.url))],
  {
    env: environment,
    windowsHide: true,
    stdio: 'inherit',
  },
);
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
