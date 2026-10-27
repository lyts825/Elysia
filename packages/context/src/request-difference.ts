// 比较连续请求的结构变化，不推断供应商缓存原因。
import { stable } from '../../contracts/src/identity.js';
/** 比较当前对象拥有的顶层字段；首次请求或字段差异均不证明缓存失效原因。 */
export function requestDifference(
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
) {
  if (!previous) return { changes: ['首次请求'], cause: 'unknown' };
  return {
    changes: Object.keys(current).filter((k) => stable(current[k]) !== stable(previous[k])),
    cause: '结构差异已观测；缓存失效原因未经供应商确认',
  };
}
