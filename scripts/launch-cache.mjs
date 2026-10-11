import { fileURLToPath } from 'node:url';
import path from 'node:path';
import cache from './launch-cache.cjs';

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
