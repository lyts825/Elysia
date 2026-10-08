import { api } from './api';

export type CacheEntry = { value: string | boolean; revision: number };
type Snapshot = {
  entries: Record<string, CacheEntry>;
  status: 'loading' | 'saved' | 'saving' | 'error';
  error: string;
};

// Keep an immediate browser recovery copy and serialize per-key writes to the local service.
// Only unsaved values override the server when reopening; old saved copies never do.
export class WorkbenchCache {
  private scope = '';
  private recoverySlot = (() => {
    try {
      const saved = sessionStorage.getItem('elysia.workbench.window');
      if (saved) return saved;
      const slot = crypto.randomUUID();
      sessionStorage.setItem('elysia.workbench.window', slot);
      return slot;
    } catch {
      return 'single-window';
    }
  })();
  private entries: Record<string, CacheEntry> = {};
  private dirty = new Set<string>();
  private conflicts = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private loading = false;
  private retrying = false;
  private stopped = false;
  private status: Snapshot['status'] = 'loading';
  private error = '';
  constructor(private changed: (snapshot: Snapshot) => void) {}

  private publish() {
    this.changed({ entries: { ...this.entries }, status: this.status, error: this.error });
  }
  private backup() {
    if (!this.scope) return;
    try {
      localStorage.setItem(
        `elysia.workbench.v1:${this.scope}:${this.recoverySlot}`,
        JSON.stringify({
          entries: Object.fromEntries([...this.dirty].map((key) => [key, this.entries[key]])),
          pending: [...this.dirty],
          conflicts: [...this.conflicts],
        }),
      );
    } catch {
      // Server persistence remains available when browser storage is disabled/full.
    }
  }
  async load(overwrite = false) {
    this.loading = true;
    try {
      const result = await api<{ scope: string; entries: Record<string, CacheEntry> }>('/workbench');
      this.scope = result.scope;
      const previous = this.entries;
      this.entries = { ...result.entries };
      let recovered: { entries?: Record<string, CacheEntry>; pending?: string[]; conflicts?: string[] } = {};
      try {
        recovered = JSON.parse(
          localStorage.getItem(`elysia.workbench.v1:${this.scope}:${this.recoverySlot}`) || '{}',
        );
      } catch {
        // A damaged recovery copy must not prevent loading the persisted drafts.
      }
      for (const key of new Set([
        ...this.dirty,
        ...(Array.isArray(recovered?.pending) ? recovered.pending : []),
      ])) {
        const entry = previous[key] || recovered?.entries?.[key];
        if (!entry || !['string', 'boolean'].includes(typeof entry.value)) continue;
        this.entries[key] = { value: entry.value, revision: result.entries[key]?.revision || 0 };
        if (entry.value !== result.entries[key]?.value) {
          this.dirty.add(key);
          if (
            !overwrite &&
            ((result.entries[key]?.revision || 0) > entry.revision || recovered.conflicts?.includes(key))
          )
            this.conflicts.add(key);
          else this.conflicts.delete(key);
        } else {
          this.dirty.delete(key);
          this.conflicts.delete(key);
        }
      }
      this.error = this.conflicts.size
        ? '另一窗口已保存更新；当前草稿已保留，点击重试保存将保存当前内容。'
        : '';
      this.status = this.conflicts.size ? 'error' : this.dirty.size ? 'saving' : 'saved';
      this.backup();
      this.publish();
      if (this.dirty.size) this.schedule();
    } finally {
      this.loading = false;
    }
  }
  get(key: string) {
    return this.entries[key]?.value;
  }
  set(key: string, value: string | boolean) {
    if (this.entries[key]?.value === value) return;
    this.entries[key] = { value, revision: this.entries[key]?.revision || 0 };
    this.dirty.add(key);
    if (!this.conflicts.size) {
      this.status = 'saving';
      this.error = '';
    }
    this.backup();
    this.publish();
    this.schedule();
  }
  remove(keys: string[]) {
    for (const key of keys) {
      delete this.entries[key];
      this.dirty.delete(key);
      this.conflicts.delete(key);
    }
    if (!this.dirty.size) {
      this.status = 'saved';
      this.error = '';
    }
    this.backup();
    this.publish();
  }
  prune(projectIds: Set<string>, runIds: Set<string>) {
    const obsolete = Object.keys(this.entries).filter((key) => {
      const match = /^(?:draft|collapsed):project:(.+)$/.exec(key);
      if (match) return !projectIds.has(match[1]);
      const run = /^(?:draft|pinned|unread):run:(.+)$/.exec(key);
      return run ? !runIds.has(run[1]) : false;
    });
    if (obsolete.length) this.remove(obsolete);
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 250);
  }
  async flush() {
    clearTimeout(this.timer);
    if (this.running || this.loading || this.stopped || !this.scope) return;
    this.running = true;
    try {
      while (this.dirty.size && !this.stopped) {
        const key = [...this.dirty].find((key) => !this.conflicts.has(key));
        if (!key) break;
        const sent = this.entries[key];
        try {
          const saved = await api<CacheEntry>(
            `/workbench/${encodeURIComponent(key)}`,
            {
              value: sent.value,
              expectedRevision: sent.revision,
            },
            'PUT',
          );
          // Deletion or new typing during an in-flight save must never restore an old value.
          if (!this.entries[key]) continue;
          this.entries[key] = { value: this.entries[key].value, revision: saved.revision };
          if (this.entries[key].value === sent.value) this.dirty.delete(key);
          this.backup();
        } catch (error) {
          if (!this.entries[key]) continue;
          this.error = error instanceof Error ? error.message : '无法保存草稿';
          this.conflicts.add(key);
          this.status = 'error';
          this.publish();
          return;
        }
      }
      this.status = this.conflicts.size ? 'error' : this.dirty.size ? 'saving' : 'saved';
      this.publish();
    } finally {
      this.running = false;
    }
  }
  async retry() {
    if (this.retrying || this.running || this.loading) return;
    this.retrying = true;
    try {
      await this.load(true);
      await this.flush();
    } catch (error) {
      this.error = error instanceof Error ? error.message : '无法保存草稿';
      this.status = 'error';
      this.publish();
    } finally {
      this.retrying = false;
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.backup();
  }
}

export const newDraftKey = (projectId: string) => (projectId ? `draft:project:${projectId}` : 'draft:chat');
