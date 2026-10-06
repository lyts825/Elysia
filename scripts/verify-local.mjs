import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const entry = '.local-tests/verify.ts';
if (!existsSync(entry)) {
  console.error(
    '缺少本地验收材料 .local-tests/verify.ts。按 docs/EXECUTION.md 第十一节准备用例；未执行验收。',
  );
  process.exit(2);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', entry], { stdio: 'inherit' });
process.exit(result.status ?? 1);
