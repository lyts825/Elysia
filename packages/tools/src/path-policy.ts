import path from 'node:path';
import { promises as fs } from 'node:fs';
export function contained(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export async function resolved(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    const parent = path.dirname(target);
    if (parent === target) throw e;
    return path.join(await resolved(parent), path.basename(target));
  }
}
