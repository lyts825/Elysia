/**
 * 调用本地验收入口；缺少验收材料时明确返回失败。
 * EN: Invoke local acceptance checks and fail explicitly when their local materials are absent.
 *
 * 复用被忽略目录中的本地验证材料并汇总退出状态；缺失材料不伪装为通过，也不把测试产物纳入正式源码。
 * EN: Reuse ignored local acceptance materials and aggregate exit status; missing checks do not count as passes and test artifacts stay outside formal source.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const entry = '.local-tests/verify.ts';
// 验收材料只保存在本地；缺失时返回非零状态，不能将其视为验收通过。
// EN: Keep acceptance materials local. Missing materials produce a nonzero exit and must not be
// reported as passed.
if (!existsSync(entry)) {
  console.error(
    '缺少本地验收材料 .local-tests/verify.ts。按 docs/EXECUTION.md 的验证入口与验收条件准备用例；未执行验收。',
  );
  process.exit(2);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', entry], { stdio: 'inherit' });
process.exit(result.status ?? 1);
