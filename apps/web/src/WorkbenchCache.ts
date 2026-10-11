import { defaultSurfaceClient, type SurfaceClient } from './api';

export type CacheEntry = { value: string | boolean; revision: number };
type Snapshot = {
  entries: Record<string, CacheEntry>;
  status: 'loading' | 'saved' | 'saving' | 'error';
  error: string;
};
type WorkbenchRead = { scope: string; entries: Record<string, CacheEntry>; partial?: boolean };
const preferenceKeys = new Set([
  'collapsed:sidebar',
  'collapsed:projects',
  'collapsed:chats',
  'collapsed:pinned',
  'settings:selected-terminal-profile',
]);
const validKey = (key: string) =>
  key.length <= 240 &&
  (preferenceKeys.has(key) ||
    key === 'draft:chat' ||
    key === 'draft:setup:chat' ||
    /^draft:setup:project:[^:\s/\\]+$/.test(key) ||
    /^draft:project-board:[^:\s/\\]+$/.test(key) ||
    /^draft:(?:handoff|delivery-review|source-resolutions):[^:\s/\\]+$/.test(key) ||
    /^(draft:(project|run)|collapsed:project|pinned:run|unread:run):[^:\s/\\]+$/.test(key) ||
    /^settings:selected-terminal-profile:[^:\s/\\]+$/.test(key) ||
    /^draft:terminal-(continuation|recovery):[^:\s/\\]+(?::[a-f0-9-]{36})?$/.test(key));
const validEntry = (entry: unknown): entry is CacheEntry => {
  if (!entry || typeof entry !== 'object') return false;
  const value = entry as CacheEntry;
  return (
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    (typeof value.value === 'boolean' || (typeof value.value === 'string' && value.value.length <= 200000))
  );
};

// Keep an immediate browser recovery copy and serialize per-key writes to the local service.
// Only unsaved values override the server when reopening; old saved copies never do.
export class WorkbenchCache {
  private scope = '';
  private recoverySlot: string;
  constructor(
    private changed: (snapshot: Snapshot) => void,
    private client: SurfaceClient = defaultSurfaceClient,
  ) {
    this.recoverySlot = (() => {
      try {
        const saved = sessionStorage.getItem(client.surfaceStorageKey('elysia.workbench.window'));
        if (saved) return saved;
        const slot = crypto.randomUUID();
        sessionStorage.setItem(client.surfaceStorageKey('elysia.workbench.window'), slot);
        return slot;
      } catch {
        return crypto.randomUUID();
      }
    })();
  }
  private entries: Record<string, CacheEntry> = {};
  private dirty = new Set<string>();
  private conflicts = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private loading = false;
  private readFailed = false;
  private retrying = false;
  private stopped = false;
  private status: Snapshot['status'] = 'loading';
  private error = '';
  private generation = 0;
  private readCount = 0;
  private preferenceLoaded = false;
  private preferenceFailed = false;
  private preferenceRequest: Promise<void> | undefined;
  private loadedKeys = new Set<string>();
  private activeKeys = new Set<string>();
  private failedKeys = new Set<string>();
  private keyRequests = new Map<string, Promise<void>>();
  private readers = new Set<AbortController>();

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
  private recovery() {
    try {
      const raw = localStorage.getItem(`elysia.workbench.v1:${this.scope}:${this.recoverySlot}`) || '{}';
      if (raw.length > 16 * 1024 * 1024) return {};
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as {
            entries?: Record<string, CacheEntry>;
            pending?: string[];
            conflicts?: string[];
          })
        : {};
    } catch {
      return {};
    }
  }
  /** Called only after session authentication, before any draft read or editing. */
  bindScope(scope: string | undefined) {
    if (!scope || !/^[a-f0-9]{64}$/.test(scope) || this.scope === scope) return;
    this.backup();
    for (const reader of this.readers) reader.abort();
    this.generation++;
    this.scope = scope;
    this.entries = {};
    this.dirty.clear();
    this.conflicts.clear();
    this.loadedKeys.clear();
    this.activeKeys.clear();
    this.failedKeys.clear();
    this.keyRequests.clear();
    this.preferenceRequest = undefined;
    this.preferenceLoaded = false;
    this.preferenceFailed = false;
    this.readFailed = false;
    this.status = 'loading';
    this.error = '';
    const recovered = this.recovery();
    for (const key of (Array.isArray(recovered.pending) ? recovered.pending : []).slice(0, 4096)) {
      const entry = recovered.entries?.[key];
      if (typeof key !== 'string' || !validKey(key) || !validEntry(entry)) continue;
      this.entries[key] = entry;
      this.dirty.add(key);
      if (Array.isArray(recovered.conflicts) && recovered.conflicts.includes(key)) this.conflicts.add(key);
    }
    this.publish();
  }
  async load(overwrite = false) {
    if (this.preferenceRequest) return this.preferenceRequest;
    if (this.preferenceLoaded && !overwrite) return;
    const generation = this.generation;
    const request = this.read('/workbench?view=preferences', undefined, overwrite).then(() => {
      if (generation !== this.generation || this.stopped) return;
      this.preferenceLoaded = true;
      if (this.dirty.size) this.schedule();
    });
    this.preferenceRequest = request;
    try {
      await request;
    } finally {
      if (this.preferenceRequest === request) this.preferenceRequest = undefined;
    }
  }
  async ensureKeys(keys: string[], overwrite = false) {
    const wanted = [...new Set(keys.filter((key) => typeof key === 'string' && validKey(key)))];
    this.activeKeys = new Set(wanted);
    await this.readKeys(wanted, overwrite);
  }
  async ensureKey(key: string, reload = false) {
    this.activeKeys.add(key);
    if (reload) this.loadedKeys.delete(key);
    await this.readKeys([key]);
  }
  private async readKeys(keys: string[], overwrite = false) {
    const wanted = [...new Set(keys.filter((key) => typeof key === 'string' && validKey(key)))];
    const newKeys = wanted.filter(
      (key) => (overwrite || !this.loadedKeys.has(key)) && !this.keyRequests.has(key),
    );
    for (let offset = 0; offset < newKeys.length; offset += 64) {
      const batch = newKeys.slice(offset, offset + 64);
      const request = this.read('/workbench?keys=' + encodeURIComponent(batch.join(',')), batch, overwrite);
      for (const key of batch) this.keyRequests.set(key, request);
      void request
        .finally(() => {
          for (const key of batch) if (this.keyRequests.get(key) === request) this.keyRequests.delete(key);
        })
        .catch(() => {});
    }
    await Promise.all([
      ...new Set(wanted.map((key) => this.keyRequests.get(key)).filter((request) => !!request)),
    ]);
  }
  private async read(path: string, keys: string[] | undefined, overwrite: boolean) {
    const generation = this.generation;
    const controller = new AbortController();
    this.readers.add(controller);
    this.readCount++;
    this.loading = true;
    try {
      const result = await this.client.api<WorkbenchRead>(path, undefined, undefined, controller.signal);
      if (controller.signal.aborted || generation !== this.generation) return;
      if (this.scope && this.scope !== result.scope) throw Error('工作台来源已变化，请重新连接。');
      if (!this.scope && /^[a-f0-9]{64}$/.test(result.scope)) this.scope = result.scope;
      if (!this.scope || this.scope !== result.scope) throw Error('工作台隔离信息无法读取。');
      const previous = this.entries;
      this.entries = result.partial ? { ...previous } : {};
      for (const [key, entry] of Object.entries(result.entries))
        if (
          validKey(key) &&
          validEntry(entry) &&
          (!previous[key] || previous[key].revision <= entry.revision)
        )
          this.entries[key] = entry;
      if (result.partial && keys)
        for (const key of keys) if (!result.entries[key] && !this.dirty.has(key)) delete this.entries[key];
      if (result.partial && !keys)
        for (const key of Object.keys(previous))
          if (!key.startsWith('draft:') && !result.entries[key] && !this.dirty.has(key))
            delete this.entries[key];
      const recovered = this.recovery();
      for (const key of new Set([
        ...this.dirty,
        ...(Array.isArray(recovered?.pending) ? recovered.pending : []),
      ])) {
        const entry = previous[key] || recovered?.entries?.[key];
        if (!validKey(key) || !validEntry(entry)) continue;
        this.dirty.add(key);
        if (result.partial && !Object.hasOwn(result.entries, key) && !keys?.includes(key)) {
          this.entries[key] = entry;
          continue;
        }
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
      if (keys)
        for (const key of keys) {
          this.loadedKeys.add(key);
          this.failedKeys.delete(key);
        }
      else this.preferenceFailed = false;
      this.readFailed = this.preferenceFailed || this.failedKeys.size > 0;
      this.error = this.readFailed
        ? this.error || '读取草稿与偏好失败，请重试。'
        : this.conflicts.size
          ? '另一窗口已保存更新；当前草稿已保留，点击重试保存将保存当前内容。'
          : '';
      this.status = this.readFailed || this.conflicts.size ? 'error' : this.dirty.size ? 'saving' : 'saved';
      this.backup();
      this.publish();
      if (this.dirty.size) this.schedule();
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      if (keys) for (const key of keys) this.failedKeys.add(key);
      else this.preferenceFailed = true;
      this.readFailed = true;
      this.error = '读取草稿与偏好失败：' + (error instanceof Error ? error.message : '本机读取失败');
      this.status = 'error';
      this.backup();
      this.publish();
      throw error;
    } finally {
      this.readers.delete(controller);
      this.readCount--;
      this.loading = this.readCount > 0;
      if (!this.loading && !this.readFailed && this.dirty.size) this.schedule();
    }
  }
  get(key: string) {
    return this.entries[key]?.value;
  }
  set(key: string, value: string | boolean) {
    if (this.entries[key]?.value === value) return;
    this.entries[key] = { value, revision: this.entries[key]?.revision || 0 };
    this.dirty.add(key);
    if (!this.conflicts.size && !this.readFailed && this.scope) {
      this.status = 'saving';
      this.error = '';
    }
    this.backup();
    this.publish();
    if (this.scope && key.startsWith('draft:') && !this.loadedKeys.has(key))
      void this.readKeys([key]).catch(() => {});
    this.schedule();
  }
  remove(keys: string[]) {
    for (const key of keys) {
      delete this.entries[key];
      this.dirty.delete(key);
      this.conflicts.delete(key);
    }
    if (!this.dirty.size && !this.readFailed) {
      this.status = 'saved';
      this.error = '';
    }
    this.backup();
    this.publish();
  }
  prune(projectIds: Set<string>, runIds: Set<string>, runsComplete = true) {
    const obsolete = Object.keys(this.entries).filter((key) => {
      const selection = /^settings:selected-terminal-profile:(.+)$/.exec(key);
      if (selection) return selection[1] !== 'home' && !projectIds.has(selection[1]);
      const match = /^(?:draft|collapsed):project:(.+)$/.exec(key);
      if (match) return !projectIds.has(match[1]);
      const setup = /^draft:setup:project:(.+)$/.exec(key);
      if (setup) return !projectIds.has(setup[1]);
      const board = /^draft:project-board:(.+)$/.exec(key);
      if (board) return !projectIds.has(board[1]);
      const run = /^(?:draft|pinned|unread):run:(.+)$/.exec(key);
      const terminalDraft = /^draft:terminal-(?:continuation|recovery):([^:]+)(?::[^:]+)?$/.exec(key);
      const handoffDraft = /^draft:(?:handoff|delivery-review|source-resolutions):([^:]+)$/.exec(key);
      if (handoffDraft) return runsComplete && !runIds.has(handoffDraft[1]);
      if (terminalDraft) return runsComplete && !runIds.has(terminalDraft[1]);
      return run ? runsComplete && !runIds.has(run[1]) : false;
    });
    if (obsolete.length) this.remove(obsolete);
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 250);
  }
  async flush() {
    clearTimeout(this.timer);
    if (
      this.running ||
      this.loading ||
      this.readFailed ||
      this.stopped ||
      !this.scope ||
      !this.preferenceLoaded
    )
      return;
    this.running = true;
    const generation = this.generation;
    try {
      while (this.dirty.size && !this.stopped && generation === this.generation) {
        const key = [...this.dirty].find((key) => !this.conflicts.has(key));
        if (!key) break;
        if (key.startsWith('draft:') && !this.loadedKeys.has(key)) {
          try {
            await this.readKeys([key]);
          } catch {
            return;
          }
          if (this.readFailed) return;
        }
        const sent = this.entries[key];
        try {
          const saved = await this.client.api<CacheEntry>(
            `/workbench/${encodeURIComponent(key)}`,
            {
              value: sent.value,
              expectedRevision: sent.revision,
            },
            'PUT',
          );
          if (generation !== this.generation) return;
          // Deletion or new typing during an in-flight save must never restore an old value.
          if (!this.entries[key]) continue;
          this.entries[key] = { value: this.entries[key].value, revision: saved.revision };
          if (this.entries[key].value === sent.value) this.dirty.delete(key);
          this.backup();
        } catch (error) {
          if (generation !== this.generation) return;
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
      if (generation !== this.generation && this.dirty.size) this.schedule();
    }
  }
  async retry() {
    if (this.retrying || this.running || this.loading) return;
    this.retrying = true;
    try {
      await this.load(true);
      const keys = [...new Set([...this.activeKeys, ...this.failedKeys, ...this.dirty])];
      await this.readKeys(keys, true);
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
    for (const reader of this.readers) reader.abort();
  }
}

export const newDraftKey = (projectId: string) => (projectId ? `draft:project:${projectId}` : 'draft:chat');
export const runSetupDraftKey = (projectId: string) =>
  projectId ? `draft:setup:project:${projectId}` : 'draft:setup:chat';
