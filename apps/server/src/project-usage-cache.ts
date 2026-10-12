import type { ProjectUsageRun, ProjectUsageSummary } from '../../../packages/contracts/src/project-usage.js';

export type UsageSnapshot = {
  summary: Omit<ProjectUsageSummary, 'runs' | 'page'>;
  runs: { position: number; value: ProjectUsageRun }[];
};
/** Payload accounting is serialized bytes, not a claim about V8 heap or process RSS. */
export class ProjectUsageCache {
  private entries = new Map<string, { version: string; bytes: number; value: UsageSnapshot }>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  static readonly maximumBytes = 16 * 1024 * 1024;
  static readonly maximumProjects = 4;

  private remove(projectId: string) {
    const entry = this.entries.get(projectId);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(projectId);
  }
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
  stats() {
    return { entries: this.entries.size, serializedBytes: this.bytes, hits: this.hits, misses: this.misses };
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

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
