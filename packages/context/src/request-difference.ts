import { stable } from '../../contracts/src/identity.js';
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
