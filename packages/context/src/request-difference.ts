/**
 * 比较连续请求的结构变化，不推断供应商缓存原因。
 * 只描述顶层结构差异，不把字段相同或变化解释为真实缓存命中原因。
 *
 * EN: Compares successive request structure without inferring provider cache causes.
 * Describes top-level structural differences without interpreting equality/change as provider-cache evidence.
 */
import { stable } from '../../contracts/src/identity.js';
/**
 * 比较当前对象拥有的顶层字段；首次请求或字段差异均不证明缓存失效原因。
 *
 * EN: Compares top-level fields owned by the current object; neither first requests nor changed fields establish why caching failed.
 */
export function requestDifference(
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
) {
  if (!previous) return { changes: ['首次请求'], cause: 'unknown' };
  /**
   * 只比较 current 拥有的字段，删除的旧字段不列入 changes；这是一份局部结构差异说明。
   *
   * EN: Only fields owned by current appear in changes; removed old fields are not listed, so this is a partial structural comparison.
   */
  return {
    changes: Object.keys(current).filter((k) => stable(current[k]) !== stable(previous[k])),
    cause: '结构差异已观测；缓存失效原因未经供应商确认',
  };
}
