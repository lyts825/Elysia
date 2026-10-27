/** 缓存交付读取结果并维护缓存状态。 */
import type { Store } from '../../../packages/storage/src/index.js';

type Entry = { value: unknown; bytes: number };
type Cache = { epoch: string | undefined; entries: Map<string, Entry>; bytes: number };
const caches = new WeakMap<Store, Cache>();
const marker = 'delivery-read-cache:epoch:v1';
const maximumBytes = 16 * 1024 * 1024;

/** The random transaction token also invalidates same-revision repairs and rolled-back writes.
 * Cached values are read-only internal snapshots, bounded to four entries and 16 MiB
 * of serialized payload per Store (not a bound on V8 heap or temporary allocations). */
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

/** 按存储实例和键缓存交付快照；数据库标记变化时清空缓存，最多保留 4 项和 16 MiB。 */
/** A committed or uncommitted database change is visible in the same snapshot as this token.
 * A rollback restores its old token; a later write gets a fresh token, never a reused counter. */
export function cachedDeliveryRead<T>(store: Store, key: string, read: () => T): T {
  const epoch = () =>
    (
      store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(marker) as
        | { value: string }
        | undefined
    )?.value;
  const before = epoch();
  if (!before) return read();
  let cache = caches.get(store);
  if (!cache || cache.epoch !== before) {
    cache = { epoch: before, entries: new Map(), bytes: 0 };
    caches.set(store, cache);
  }
  const found = cache.entries.get(key);
  if (found) {
    cache.entries.delete(key);
    cache.entries.set(key, found);
    return found.value as T;
  }
  const value = read();
  // A legacy projection refresh can itself write. Never cache a mixed generation.
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
