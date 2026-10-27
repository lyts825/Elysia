/**
 * 缓存项目使用量快照并提供分页读取。
 * 完整快照按冻结版本分页，LRU 用项目数/序列化字节限额，超大项不缓存；缓存计数不是进程内存，分页不缩小统计范围。
 * EN: Caches project usage snapshots and serves pages. Pages complete frozen snapshots under project-count/serialized-byte LRU limits, skipping oversized items; cache bytes are not process memory and paging never narrows totals.
 */
import type { ProjectUsageRun, ProjectUsageSummary } from '../../../packages/contracts/src/project-usage.js';

export type UsageSnapshot = {
  summary: Omit<ProjectUsageSummary, 'runs' | 'page'>;
  runs: { position: number; value: ProjectUsageRun }[];
};
/**
 * 容量按序列化字节计算，不代表 V8 堆大小或进程 RSS。 按项目和版本缓存用量快照，并跟踪容量及命中情况。
 * EN: Payload accounting is serialized bytes, not a claim about V8 heap or process RSS. Caches usage by project and revision and tracks capacity and hits.
 */
export class ProjectUsageCache {
  private entries = new Map<string, { version: string; bytes: number; value: UsageSnapshot }>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  static readonly maximumBytes = 16 * 1024 * 1024;
  static readonly maximumProjects = 4;

  /**
   * 移除项目缓存并扣减其序列化字节占用；不存在时不改变计数。
   * EN: Removes a project cache entry and subtracts its serialized-byte charge; missing entries leave counters unchanged.
   */
  private remove(projectId: string) {
    const entry = this.entries.get(projectId);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(projectId);
  }
  /**
   * 版本必须完全匹配，过期项立即淘汰；命中项移到末尾延长其 LRU 保留。
   * EN: Requires exact revision matches and evicts expired entries; hits move to the end to extend LRU retention.
   */
  get(projectId: string, version: string) {
    const entry = this.entries.get(projectId);
    if (!entry || entry.version !== version) {
      if (entry) this.remove(projectId);
      this.misses++;
      return;
    }
    this.hits++;
    this.entries.delete(projectId);
    this.entries.set(projectId, entry);
    return entry.value;
  }
  /**
   * 按序列化字节和项目数淘汰旧项；单项过大只跳过缓存，不能截断用量快照。
   * EN: Evicts old entries by serialized bytes and project count; an oversized snapshot is left uncached rather than truncated.
   */
  put(projectId: string, value: UsageSnapshot) {
    this.remove(projectId);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > ProjectUsageCache.maximumBytes) return;
    while (
      this.entries.size >= ProjectUsageCache.maximumProjects ||
      this.bytes + bytes > ProjectUsageCache.maximumBytes
    )
      this.remove(this.entries.keys().next().value!);
    this.entries.set(projectId, { version: value.summary.version, bytes, value });
    this.bytes += bytes;
  }
  /**
   * 返回缓存自身计数，serializedBytes 不代表整个进程内存占用。
   * EN: Reports cache-local counters; serializedBytes is not total process memory.
   */
  stats() {
    return { entries: this.entries.size, serializedBytes: this.bytes, hits: this.hits, misses: this.misses };
  }
  /**
   * 释放所有快照并将当前字节占用清零，不修改历史命中统计。
   * EN: Drops all snapshots and resets current bytes without changing historical hit counters.
   */
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

/**
 * 按运行 ID 游标从用量快照中读取一页；未知游标返回 undefined。
 * EN: Pages a usage snapshot by run-ID cursor; an unknown cursor returns undefined.
 */
export function usageSnapshotPage(snapshot: UsageSnapshot, before?: string): ProjectUsageSummary | undefined {
  const boundary = before ? snapshot.runs.findIndex((run) => run.value.runId === before) : -1;
  if (before && boundary < 0) return;
  const start = before ? boundary + 1 : 0;
  const selected = snapshot.runs.slice(start, start + 20),
    hasMore = start + selected.length < snapshot.runs.length;
  return structuredClone({
    ...snapshot.summary,
    runs: selected.map((run) => run.value),
    page: {
      total: snapshot.runs.length,
      limit: 20,
      before: before ?? null,
      hasMore,
      nextBefore: selected.at(-1)?.value.runId ?? null,
    },
  });
}
