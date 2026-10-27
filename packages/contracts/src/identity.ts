// 生成实体标识、时间戳及稳定序列化和摘要。
import { createHash, randomUUID } from 'node:crypto';

/** 为新实体生成 UUID；不会从用户输入或可预测计数派生。 */
export const id = () => randomUUID();
/** 统一使用 UTC ISO 时间戳供持久记录比较和展示。 */
export const now = () => new Date().toISOString();
// 对对象键排序并忽略未定义的属性，使等价对象产生相同的摘要输入。
// 数组保留顺序，数组中的 undefined 会表示为 null；此函数适用于可 JSON 序列化的数据。
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
/** 返回字符串 UTF-8 字节或原始 Buffer 的 SHA-256 小写摘要。 */
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
