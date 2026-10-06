import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, ELYSIA_DEV: '1' },
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts'], {
    stdio: 'inherit',
  }),
];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const p of children) p.kill('SIGTERM');
  process.exitCode = code;
}
for (const p of children) p.on('exit', (code) => stop(code || 0));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
