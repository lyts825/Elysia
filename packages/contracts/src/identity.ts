// 生成实体标识、时间戳及稳定序列化和摘要。
import { createHash, randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
// 对对象键排序并忽略未定义的属性，使等价对象产生相同的摘要输入。
export function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
