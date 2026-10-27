// 提供路径包含关系与实际路径解析，供工作区边界检查使用。
import path from 'node:path';
import { promises as fs } from 'node:fs';
/** 判断 target 是否为 root 自身或其后代；调用前由上层解析实际路径。 */
export function contained(root: string, target: string) {
  // 使用相对路径判断边界，避免把同名前缀的相邻目录误认为子目录。
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
/** 解析已有路径的符号链接；目标不存在时保留末尾名称并递归解析其现有祖先。 */
export async function resolved(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    // 目标尚不存在时，先解析最近的现有祖先，再逐层还原剩余名称。
    const parent = path.dirname(target);
    if (parent === target) throw e;
    return path.join(await resolved(parent), path.basename(target));
  }
}
