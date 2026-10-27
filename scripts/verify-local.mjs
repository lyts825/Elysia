// 调用本地验收入口；缺少验收材料时明确返回失败。
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const entry = '.local-tests/verify.ts';
// 验收材料只保存在本地；缺失时返回非零状态，不能将其视为验收通过。
if (!existsSync(entry)) {
  console.error(
    '缺少本地验收材料 .local-tests/verify.ts。按 docs/EXECUTION.md 第十一节准备用例；未执行验收。',
  );
  process.exit(2);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', entry], { stdio: 'inherit' });
process.exit(result.status ?? 1);
