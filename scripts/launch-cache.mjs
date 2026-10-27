/**
 * 提供启动构建缓存的命令行管理入口。
 * EN: Provide a read-only command-line entry for launch-cache inspection.
 *
 * 将缓存信息和清理预览输出到控制台，不在查看或预览过程中执行删除，实际入口参数由本脚本校验。
 * EN: Validate CLI arguments and display cache information or cleanup previews without deleting during inspection.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import cache from './launch-cache.cjs';

// list 与 preview 均只读；参数校验后输出缓存检查结果，不执行清理。
// EN: Both list and preview validate arguments and print inspection results without performing
// cleanup.
const [action, ...args] = process.argv.slice(2);
if (!['list', 'preview'].includes(action))
  throw new Error(
    '用法：node scripts/launch-cache.mjs list|preview [--keep 2] [--root 仓库路径]；只读，不支持删除',
  );
let root = fileURLToPath(new URL('..', import.meta.url)),
  keep = 2;
const seen = new Set();
for (let index = 0; index < args.length; index++) {
  const key = args[index],
    value = args[++index];
  if (!['--root', '--keep'].includes(key) || !value || seen.has(key))
    throw new Error('未知或重复的缓存预览参数');
  seen.add(key);
  if (key === '--root') root = path.resolve(value);
  else keep = Number(value);
}
console.log(JSON.stringify({ action, ...cache.inspectBuildCache(root, keep) }, null, 2));
