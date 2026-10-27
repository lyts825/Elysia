/**
 * 缓存交付读取结果并维护缓存状态。
 * 通过数据库失效标记协调交付摘要缓存，触发器只追踪影响读取结果的变化；缓存可重建且不是权威正文。
 * EN: Caches delivery-read snapshots and tracks their validity. Coordinates summary caches through database invalidation markers; triggers track relevant changes and rebuildable caches are not authoritative bodies.
 */
import type { Store } from '../../../packages/storage/src/index.js';

type Entry = { value: unknown; bytes: number };
type Cache = { epoch: string | undefined; entries: Map<string, Entry>; bytes: number };
const caches = new WeakMap<Store, Cache>();
const marker = 'delivery-read-cache:epoch:v1';
const maximumBytes = 16 * 1024 * 1024;

/**
 * 随机事务token也使同版本修复和回滚写入失效。缓存是只读内部快照，每个Store最多4项、序列化负载16 MiB；这不是V8堆或临时分配的上限。
 * EN: The random transaction token also invalidates same-revision repairs and rolled-back writes. Cached values are read-only internal snapshots, bounded to four entries and 16 MiB of serialized payload per Store (not a bound on V8 heap or temporary allocations).
 */
export function initializeDeliveryReadCache(store: Store) {
  store.db.exec(`
    INSERT OR IGNORE INTO storage_meta(key,value) VALUES('${marker}',lower(hex(randomblob(16))));
  `);
  for (const table of [
    'runs',
    'tasks',
    'artifacts',
    'artifact_delivery_metadata_v1',
    'delivery_review_history_v1',
  ]) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      store.db.exec(`
        CREATE TRIGGER IF NOT EXISTS delivery_read_cache_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table}
        BEGIN UPDATE storage_meta SET value=lower(hex(randomblob(16))) WHERE key='${marker}'; END;
      `);
    }
  }
}

/**
 * 按存储实例和键缓存交付快照；数据库标记变化时清空缓存，最多保留 4 项和 16 MiB。 已提交或未提交的数据库变化与token处于同一事务视图。回滚恢复旧token，后续写入生成新token而不复用计数。
 * EN: Caches snapshots by Store and key. Database-marker changes clear the cache, bounded to four entries and 16 MiB. A committed or uncommitted database change is visible in the same snapshot as this token. A rollback restores its old token; a later write gets a fresh token, never a reused counter.
 */
export function cachedDeliveryRead<T>(store: Store, key: string, read: () => T): T {
  /**
   * 读取派生交付读取缓存的存储 epoch；缺失时返回 undefined，以便调用方重新构建。
   * EN: Reads the delivery cache epoch from storage, returning undefined when absent so callers can rebuild.
   */
  const epoch = () =>
    (
      store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(marker) as
        | { value: string }
        | undefined
    )?.value;
  /**
   * token 与当前数据库事务视图一起变化；回滚后旧 token 恢复，不会误复用中间写入的缓存。
   * EN: The token changes with the current transaction view; rollback restores its old value and prevents reuse of intermediate-write snapshots.
   */
  const before = epoch();
  if (!before) return read();
  let cache = caches.get(store);
  if (!cache || cache.epoch !== before) {
    cache = { epoch: before, entries: new Map(), bytes: 0 };
    caches.set(store, cache);
  }
  /**
   * 命中后移动到末尾，容量淘汰始终先移除最近未使用的完整快照。
   * EN: Moves cache hits to the end so capacity eviction removes the least recently used complete snapshot first.
   */
  const found = cache.entries.get(key);
  if (found) {
    cache.entries.delete(key);
    cache.entries.set(key, found);
    return found.value as T;
  }
  const value = read();
  /**
   * 旧投影刷新本身可能写库，不缓存混合代际结果。
   * EN: A legacy projection refresh can itself write. Never cache a mixed generation.
   */
  if (epoch() !== before) return value;
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > maximumBytes) return value;
  while (cache.entries.size >= 4 || cache.bytes + bytes > maximumBytes) {
    const oldest = cache.entries.keys().next().value!;
    cache.bytes -= cache.entries.get(oldest)!.bytes;
    cache.entries.delete(oldest);
  }
  cache.entries.set(key, { value, bytes });
  cache.bytes += bytes;
  return value;
}
