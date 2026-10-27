/* 管理工作台草稿缓存、服务端同步与本地恢复。 */
import { ApiError, defaultSurfaceClient, type SurfaceClient } from './api';

export type CacheEntry = { value: string | boolean; revision: number };
export type WorkbenchIssue = {
  key: string;
  kind: 'conflict' | 'network' | 'timeout' | 'missing' | 'too-large' | 'permission' | 'protocol' | 'http';
  message: string;
  retryable: boolean;
};
export type WorkbenchRecoveryState = {
  status: 'idle' | 'verified' | 'memory-only';
  message: string;
  windowSlotStable: boolean;
  pendingCount: number;
};
export type WorkbenchSnapshot = {
  entries: Record<string, CacheEntry>;
  status: 'loading' | 'saved' | 'saving' | 'error';
  error: string;
  readError: string;
  pendingKeys: string[];
  issues: WorkbenchIssue[];
  recovery: WorkbenchRecoveryState;
};
export const createWorkbenchSnapshot = (): WorkbenchSnapshot => ({
  entries: {},
  status: 'loading',
  error: '',
  readError: '',
  pendingKeys: [],
  issues: [],
  recovery: { status: 'idle', message: '尚未读取草稿。', windowSlotStable: false, pendingCount: 0 },
});
export type WorkbenchInspection = {
  key: string;
  token: string;
  local: CacheEntry;
  remote: CacheEntry | null;
};
type Inspection = WorkbenchInspection & { generation: number; change: number; owner: number };
type WorkbenchRead = { scope: string; entries: Record<string, CacheEntry>; partial?: boolean };
const preferenceKeys = new Set([
  'collapsed:sidebar',
  'collapsed:projects',
  'collapsed:chats',
  'collapsed:pinned',
  'settings:selected-terminal-profile',
]);
// 白名单限定可缓存的偏好和草稿键，避免将任意服务数据混入恢复存储。
const validKey = (key: string) =>
  key.length <= 240 &&
  (preferenceKeys.has(key) ||
    key === 'draft:chat' ||
    key === 'draft:setup:chat' ||
    /^draft:setup:project:[^:\s/\\]+$/.test(key) ||
    /^draft:project-board:[^:\s/\\]+$/.test(key) ||
    /^draft:project-intelligence:[^:\s/\\]+$/.test(key) ||
    /^draft:project-schedules:[^:\s/\\]+$/.test(key) ||
    /^draft:working-state:[^:\s/\\]+:[a-f0-9-]{36}$/.test(key) ||
    /^draft:(?:handoff|delivery-review|source-resolutions):[^:\s/\\]+$/.test(key) ||
    /^(draft:(project|run)|collapsed:project|pinned:run|unread:run):[^:\s/\\]+$/.test(key) ||
    /^settings:selected-terminal-profile:[^:\s/\\]+$/.test(key) ||
    /^draft:terminal-(continuation|recovery|communication|send|resolution):[^:\s/\\]+(?::[a-f0-9-]{36})?$/.test(
      key,
    ));
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
  private windowSlotStable = false;
  constructor(
    private changed: (snapshot: WorkbenchSnapshot) => void,
    private client: SurfaceClient = defaultSurfaceClient,
  ) {
    // 恢复副本按浏览器窗口隔离；无法稳定保存窗口标识时仍允许内存工作。
    this.recoverySlot = (() => {
      try {
        const saved = sessionStorage.getItem(client.surfaceStorageKey('elysia.workbench.window'));
        if (saved) {
          this.windowSlotStable = true;
          return saved;
        }
        const slot = crypto.randomUUID();
        sessionStorage.setItem(client.surfaceStorageKey('elysia.workbench.window'), slot);
        this.windowSlotStable =
          sessionStorage.getItem(client.surfaceStorageKey('elysia.workbench.window')) === slot;
        return slot;
      } catch {
        return crypto.randomUUID();
      }
    })();
  }
  private entries: Record<string, CacheEntry> = {};
  private dirty = new Set<string>();
  private issues = new Map<string, WorkbenchIssue>();
  private retryKeys = new Set<string>();
  private inspections = new Map<string, Inspection>();
  private inspectionRequests = new Map<string, number>();
  private changes = new Map<string, number>();
  private owners = new Map<string, number>();
  private resolving = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private runningGeneration: number | undefined;
  private loading = false;
  private readFailed = false;
  private retrying = false;
  private stopped = false;
  private readError = '';
  private recoveryState: WorkbenchRecoveryState = createWorkbenchSnapshot().recovery;
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

  private get running() {
    return this.runningGeneration === this.generation;
  }
  private touch(key: string) {
    this.changes.set(key, (this.changes.get(key) || 0) + 1);
    this.inspections.delete(key);
    this.inspectionRequests.set(key, (this.inspectionRequests.get(key) || 0) + 1);
  }
  private publish() {
    const issues = [...this.issues.values()].map((issue) => ({ ...issue }));
    this.changed({
      entries: { ...this.entries },
      status:
        this.readFailed || issues.length
          ? 'error'
          : !this.preferenceLoaded
            ? 'loading'
            : this.dirty.size
              ? 'saving'
              : 'saved',
      error: this.readError || issues[0]?.message || '',
      readError: this.readError,
      pendingKeys: [...this.dirty],
      issues,
      recovery: { ...this.recoveryState, pendingCount: this.dirty.size },
    });
  }
  private backup() {
    let failure = '';
    try {
      if (!this.scope) throw Error('尚未确认草稿所属工作区');
      const key = `elysia.workbench.v1:${this.scope}:${this.recoverySlot}`;
      const raw = JSON.stringify({
        entries: Object.fromEntries([...this.dirty].map((key) => [key, this.entries[key]])),
        pending: [...this.dirty],
        conflicts: [...this.issues.values()]
          .filter((issue) => issue.kind === 'conflict')
          .map((issue) => issue.key),
      });
      localStorage.setItem(key, raw);
      if (localStorage.getItem(key) !== raw) throw Error('浏览器恢复副本读回不一致');
      try {
        this.windowSlotStable =
          sessionStorage.getItem(this.client.surfaceStorageKey('elysia.workbench.window')) ===
          this.recoverySlot;
      } catch {
        this.windowSlotStable = false;
      }
      if (!this.windowSlotStable) throw Error('浏览器窗口恢复标识不可用');
    } catch {
      failure = '浏览器恢复副本未核验，可能是空间不足、存储不可用或窗口恢复标识失效。';
    }
    this.recoveryState = {
      status: !this.dirty.size ? 'idle' : failure ? 'memory-only' : 'verified',
      message: !this.dirty.size
        ? failure
          ? '当前没有待保存内容。' + failure
          : '当前没有待保存内容。'
        : failure
          ? '待保存内容目前仅能在本窗口内存中确认，请导出原稿。' + failure
          : '待保存内容已写入并读回核验浏览器恢复副本。',
      windowSlotStable: this.windowSlotStable,
      pendingCount: this.dirty.size,
    };
  }
  private recovery() {
    try {
      const raw = localStorage.getItem(`elysia.workbench.v1:${this.scope}:${this.recoverySlot}`) || '{}';
      if (raw.length > 16 * 1024 * 1024) throw Error('恢复副本过大');
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as {
            entries?: Record<string, CacheEntry>;
            pending?: string[];
            conflicts?: string[];
          })
        : {};
    } catch {
      this.recoveryState = {
        status: this.dirty.size ? 'memory-only' : 'idle',
        message: '浏览器恢复副本无法读取，请保留本窗口内容并导出原稿。',
        pendingCount: this.dirty.size,
        windowSlotStable: this.windowSlotStable,
      };
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
    this.issues.clear();
    this.retryKeys.clear();
    this.inspections.clear();
    this.inspectionRequests.clear();
    this.changes.clear();
    this.owners.clear();
    this.resolving.clear();
    this.loadedKeys.clear();
    this.activeKeys.clear();
    this.failedKeys.clear();
    this.keyRequests.clear();
    this.preferenceRequest = undefined;
    this.preferenceLoaded = false;
    this.preferenceFailed = false;
    this.readFailed = false;
    this.loading = false;
    this.readCount = 0;
    this.readError = '';
    this.recoveryState = { ...createWorkbenchSnapshot().recovery, windowSlotStable: this.windowSlotStable };
    const recovered = this.recovery();
    for (const key of (Array.isArray(recovered.pending) ? recovered.pending : []).slice(0, 4096)) {
      const entry = recovered.entries?.[key];
      if (typeof key !== 'string' || !validKey(key) || !validEntry(entry)) continue;
      this.entries[key] = entry;
      this.dirty.add(key);
      if (Array.isArray(recovered.conflicts) && recovered.conflicts.includes(key)) this.conflict(key);
    }
    if (this.dirty.size) this.backup();
    this.publish();
  }
  async load(overwrite = false) {
    if (this.preferenceRequest) return this.preferenceRequest;
    if (this.preferenceLoaded && !overwrite) return;
    const generation = this.generation;
    const request = this.read('/workbench?view=preferences', undefined).then(() => {
      if (generation !== this.generation || this.stopped) return;
      this.preferenceLoaded = true;
      this.publish();
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
      const request = this.read('/workbench?keys=' + encodeURIComponent(batch.join(',')), batch);
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
  private async read(path: string, keys: string[] | undefined) {
    const generation = this.generation;
    const owners = new Map(this.owners);
    const sameOwner = (key: string) => (owners.get(key) || 0) === (this.owners.get(key) || 0);
    const controller = new AbortController();
    this.readers.add(controller);
    this.readCount++;
    this.loading = true;
    try {
      const result = await this.client.api<WorkbenchRead>(path, undefined, undefined, controller.signal);
      if (controller.signal.aborted || generation !== this.generation || this.stopped) return;
      if (this.scope && this.scope !== result.scope) throw Error('工作台来源已变化，请重新连接。');
      const needsRecovery = !this.scope;
      if (needsRecovery && /^[a-f0-9]{64}$/.test(result.scope)) this.scope = result.scope;
      if (!this.scope || this.scope !== result.scope) throw Error('工作台隔离信息无法读取。');
      const previous = this.entries;
      this.entries = result.partial ? { ...previous } : {};
      for (const [key, entry] of Object.entries(result.entries))
        if (
          validKey(key) &&
          validEntry(entry) &&
          sameOwner(key) &&
          (!previous[key] || previous[key].revision <= entry.revision)
        )
          this.entries[key] = entry;
      if (result.partial && keys)
        for (const key of keys)
          if (sameOwner(key) && !result.entries[key] && !this.dirty.has(key)) delete this.entries[key];
      if (result.partial && !keys)
        for (const key of Object.keys(previous))
          if (sameOwner(key) && !key.startsWith('draft:') && !result.entries[key] && !this.dirty.has(key))
            delete this.entries[key];
      const recovered = needsRecovery ? this.recovery() : {};
      for (const key of new Set([
        ...this.dirty,
        ...(Array.isArray(recovered?.pending) ? recovered.pending : []),
      ])) {
        const entry = previous[key] || recovered?.entries?.[key];
        if (!validKey(key) || (!previous[key] && !validEntry(entry))) continue;
        this.dirty.add(key);
        if (!sameOwner(key) || (result.partial && !(keys ? keys.includes(key) : !key.startsWith('draft:')))) {
          this.entries[key] = entry;
          continue;
        }
        this.entries[key] = { ...entry };
        if (entry.value !== result.entries[key]?.value) {
          this.dirty.add(key);
          if ((result.entries[key]?.revision || 0) !== entry.revision || recovered.conflicts?.includes(key))
            this.conflict(key);
        } else {
          this.entries[key] = { ...result.entries[key] };
          this.dirty.delete(key);
          this.issues.delete(key);
          this.touch(key);
        }
      }
      if (keys)
        for (const key of keys) {
          if (!sameOwner(key)) continue;
          this.loadedKeys.add(key);
          this.failedKeys.delete(key);
        }
      else this.preferenceFailed = false;
      this.readFailed = this.preferenceFailed || this.failedKeys.size > 0;
      if (!this.readFailed) this.readError = '';
      this.backup();
      this.publish();
      if (this.dirty.size) this.schedule();
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation || this.stopped) return;
      if (keys) {
        for (const key of keys) if (sameOwner(key)) this.failedKeys.add(key);
      } else this.preferenceFailed = true;
      this.readFailed = this.preferenceFailed || this.failedKeys.size > 0;
      if (this.readFailed)
        this.readError = '读取草稿与偏好失败：' + (error instanceof Error ? error.message : '本机读取失败');
      this.backup();
      this.publish();
      throw error;
    } finally {
      this.readers.delete(controller);
      if (generation === this.generation) {
        this.readCount--;
        this.loading = this.readCount > 0;
        if (!this.loading && !this.readFailed && this.dirty.size) this.schedule();
      }
    }
  }
  get(key: string) {
    return this.entries[key]?.value;
  }
  set(key: string, value: string | boolean) {
    if (this.entries[key]?.value === value) return;
    this.entries[key] = { value, revision: this.entries[key]?.revision || 0 };
    this.dirty.add(key);
    this.touch(key);
    if (this.issues.get(key)?.kind === 'too-large') this.retryKeys.add(key);
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
      this.issues.delete(key);
      this.retryKeys.delete(key);
      this.failedKeys.delete(key);
      this.loadedKeys.delete(key);
      this.activeKeys.delete(key);
      this.owners.set(key, (this.owners.get(key) || 0) + 1);
      this.touch(key);
    }
    this.readFailed = this.preferenceFailed || this.failedKeys.size > 0;
    if (!this.readFailed) this.readError = '';
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
      const intelligence = /^draft:project-intelligence:(.+)$/.exec(key);
      if (intelligence) return !projectIds.has(intelligence[1]);
      const schedules = /^draft:project-schedules:(.+)$/.exec(key);
      if (schedules) return !projectIds.has(schedules[1]);
      const workingState = /^draft:working-state:([^:]+):[^:]+$/.exec(key);
      if (workingState) return runsComplete && !runIds.has(workingState[1]);
      const run = /^(?:draft|pinned|unread):run:(.+)$/.exec(key);
      const terminalDraft =
        /^draft:terminal-(?:continuation|recovery|communication|send|resolution):([^:]+)(?::[^:]+)?$/.exec(
          key,
        );
      const handoffDraft = /^draft:(?:handoff|delivery-review|source-resolutions):([^:]+)$/.exec(key);
      if (handoffDraft) return runsComplete && !runIds.has(handoffDraft[1]);
      if (terminalDraft) return runsComplete && !runIds.has(terminalDraft[1]);
      return run ? runsComplete && !runIds.has(run[1]) : false;
    });
    if (obsolete.length) this.remove(obsolete);
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.stopped) return;
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
    this.runningGeneration = this.generation;
    const generation = this.generation;
    try {
      while (this.dirty.size && !this.stopped && generation === this.generation) {
        const key = [...this.dirty].find(
          (key) => !this.resolving.has(key) && (!this.issues.has(key) || this.retryKeys.has(key)),
        );
        if (!key) break;
        if (key.startsWith('draft:') && !this.loadedKeys.has(key)) {
          try {
            await this.readKeys([key]);
          } catch {
            return;
          }
          if (this.readFailed || generation !== this.generation || this.stopped) return;
          if (!this.dirty.has(key) || (this.issues.has(key) && !this.retryKeys.has(key))) continue;
        }
        const sent = this.entries[key];
        const owner = this.owners.get(key) || 0;
        this.retryKeys.delete(key);
        try {
          const saved = await this.writeEntry(key, sent.value, sent.revision);
          if (generation !== this.generation || this.stopped) return;
          // Deletion or new typing during an in-flight save must never restore an old value.
          if (!this.entries[key] || owner !== (this.owners.get(key) || 0)) continue;
          if (!validEntry(saved) || saved.value !== sent.value || saved.revision <= sent.revision)
            throw new ApiError('保存结果无法核验，请重新读取此项。', 'protocol');
          this.entries[key] = { value: this.entries[key].value, revision: saved.revision };
          if (this.entries[key].value === sent.value) this.dirty.delete(key);
          this.issues.delete(key);
          this.touch(key);
          this.backup();
          this.publish();
        } catch (error) {
          if (generation !== this.generation || this.stopped) return;
          if (!this.entries[key] || owner !== (this.owners.get(key) || 0)) continue;
          this.issues.set(key, this.classify(key, error));
          this.inspections.delete(key);
          this.backup();
          this.publish();
        }
      }
      this.publish();
    } finally {
      if (this.runningGeneration === generation) this.runningGeneration = undefined;
      if (generation !== this.generation && this.dirty.size) this.schedule();
    }
  }
  async retry(key?: string) {
    if (this.retrying || this.running || this.loading) return;
    this.retrying = true;
    const generation = this.generation;
    try {
      if (this.readFailed || !this.preferenceLoaded) await this.retryReads();
      if (generation !== this.generation || this.stopped) return;
      const keys = [...this.issues.values()]
        .filter((issue) => (!key || issue.key === key) && issue.retryable && issue.kind !== 'conflict')
        .map((issue) => issue.key);
      if (keys.length) await this.readKeys(keys, true);
      if (generation !== this.generation || this.stopped) return;
      for (const item of keys) {
        const issue = this.issues.get(item);
        if (issue?.retryable && issue.kind !== 'conflict') this.retryKeys.add(item);
      }
      await this.flush();
    } catch {
      // The failed read or write retains its own actionable issue.
    } finally {
      this.retrying = false;
    }
  }
  async retryReads() {
    if (this.stopped) return;
    const generation = this.generation;
    if (this.preferenceFailed || !this.preferenceLoaded) await this.load(true);
    if (generation !== this.generation || this.stopped) return;
    const keys = [
      ...new Set([...this.failedKeys, ...[...this.dirty].filter((key) => !this.loadedKeys.has(key))]),
    ];
    if (keys.length) await this.readKeys(keys, true);
  }
  retryRecovery() {
    try {
      const key = this.client.surfaceStorageKey('elysia.workbench.window');
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, this.recoverySlot);
    } catch {
      this.windowSlotStable = false;
    }
    this.backup();
    this.publish();
  }
  exportPending() {
    return {
      format: 'elysia-workbench-unsaved' as const,
      version: 1 as const,
      scope: this.scope,
      exportedAt: new Date().toISOString(),
      entries: Object.fromEntries([...this.dirty].map((key) => [key, { ...this.entries[key] }])),
      pending: [...this.dirty],
    };
  }
  private conflict(key: string) {
    this.issues.set(key, {
      key,
      kind: 'conflict',
      message: '服务端已有不同版本。当前内容已保留，请单独核对并选择此项；重试不会覆盖冲突。',
      retryable: false,
    });
    this.retryKeys.delete(key);
    this.inspections.delete(key);
  }
  private classify(key: string, error: unknown): WorkbenchIssue {
    const message = error instanceof Error ? error.message : '无法保存此项';
    if (error instanceof ApiError) {
      if (error.status === 409) return { key, kind: 'conflict', message, retryable: false };
      if (error.code === 'READ_TIMEOUT' || error.code === 'WRITE_TIMEOUT')
        return { key, kind: 'timeout', message, retryable: true };
      if (error.kind === 'network') return { key, kind: 'network', message, retryable: true };
      if (error.status === 404) return { key, kind: 'missing', message, retryable: false };
      if (error.status === 413) return { key, kind: 'too-large', message, retryable: false };
      if (error.status === 401 || error.status === 403)
        return { key, kind: 'permission', message, retryable: false };
      if (error.kind === 'protocol') return { key, kind: 'protocol', message, retryable: true };
      return { key, kind: 'http', message, retryable: (error.status || 0) >= 500 || error.status === 429 };
    }
    return { key, kind: 'network', message, retryable: true };
  }
  private async writeEntry(key: string, value: string | boolean, expectedRevision: number) {
    const controller = new AbortController();
    this.readers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new ApiError(
            '保存请求超时，结果尚未确认。原稿已保留，重试前会核对服务端。',
            'network',
            undefined,
            'WRITE_TIMEOUT',
          ),
        );
        controller.abort();
      }, 15000);
    });
    try {
      return await Promise.race([
        this.client.api<CacheEntry>(
          `/workbench/${encodeURIComponent(key)}`,
          { value, expectedRevision },
          'PUT',
          controller.signal,
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      this.readers.delete(controller);
    }
  }
  private async readInspection(key: string, generation: number) {
    const controller = new AbortController();
    this.readers.add(controller);
    try {
      const result = await this.client.api<WorkbenchRead>(
        '/workbench?keys=' + encodeURIComponent(key),
        undefined,
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted || generation !== this.generation || this.stopped)
        throw Error('草稿所属工作区已变化，请重新核对此项。');
      if (!this.scope || result.scope !== this.scope)
        throw Error('工作台来源已变化，已保留本地原稿，请重新连接。');
      if (!result.entries || typeof result.entries !== 'object' || Array.isArray(result.entries))
        throw Error('服务端草稿无法读取，已保留本地原稿。');
      const entry = result.entries[key];
      if (entry !== undefined && !validEntry(entry)) throw Error('服务端草稿格式无法核验，已保留本地原稿。');
      return entry ? { ...entry } : null;
    } finally {
      this.readers.delete(controller);
    }
  }
  async inspectIssue(key: string): Promise<WorkbenchInspection> {
    const local = this.entries[key];
    if (this.stopped || !this.scope || !local || !this.dirty.has(key) || !this.issues.has(key))
      throw Error('此项已变化或已保存，请重新打开待保存列表。');
    const generation = this.generation;
    const change = this.changes.get(key) || 0;
    const owner = this.owners.get(key) || 0;
    const request = (this.inspectionRequests.get(key) || 0) + 1;
    this.inspectionRequests.set(key, request);
    this.inspections.delete(key);
    const remote = await this.readInspection(key, generation);
    if (
      generation !== this.generation ||
      change !== (this.changes.get(key) || 0) ||
      owner !== (this.owners.get(key) || 0) ||
      request !== this.inspectionRequests.get(key) ||
      !this.dirty.has(key)
    )
      throw Error('读取期间本地内容已变化，请重新核对此项。');
    const inspection: Inspection = {
      key,
      token: crypto.randomUUID(),
      local: { ...local },
      remote,
      generation,
      change,
      owner,
    };
    this.inspections.set(key, inspection);
    return { key, token: inspection.token, local: { ...local }, remote: remote ? { ...remote } : null };
  }
  private requireInspection(key: string, token: string) {
    const inspection = this.inspections.get(key);
    const local = this.entries[key];
    if (
      this.stopped ||
      !inspection ||
      inspection.token !== token ||
      inspection.generation !== this.generation ||
      inspection.change !== (this.changes.get(key) || 0) ||
      inspection.owner !== (this.owners.get(key) || 0) ||
      !local ||
      !this.dirty.has(key) ||
      local.value !== inspection.local.value ||
      local.revision !== inspection.local.revision
    )
      throw Error('核对后的本地内容或所属工作区已变化，请重新核对此项。');
    return inspection;
  }
  async resolveIssue(key: string, token: string, choice: 'local' | 'remote') {
    const inspection = this.requireInspection(key, token);
    if (this.resolving.has(key) || this.running) throw Error('正在保存草稿，请稍后重新核对此项。');
    this.resolving.add(key);
    try {
      if (choice === 'remote') {
        if (!inspection.remote)
          throw Error('服务端没有可采用的内容，请保留或导出本地原稿并核对所属项目或任务。');
        const remote = await this.readInspection(key, inspection.generation);
        this.requireInspection(key, token);
        if (
          !remote ||
          remote.revision !== inspection.remote.revision ||
          remote.value !== inspection.remote.value
        ) {
          this.conflict(key);
          this.backup();
          this.publish();
          throw Error('核对后服务端内容再次变化，已保留本地原稿，请重新核对此项。');
        }
        this.entries[key] = remote;
        this.dirty.delete(key);
        this.issues.delete(key);
        this.touch(key);
      } else {
        const sent = inspection.local;
        const expectedRevision = inspection.remote?.revision || 0;
        try {
          const saved = await this.writeEntry(key, sent.value, expectedRevision);
          if (
            inspection.generation !== this.generation ||
            this.stopped ||
            inspection.owner !== (this.owners.get(key) || 0)
          )
            throw Error('所属工作区或草稿已变化，本次保存结果未在当前草稿中采用，请重新核对。');
          if (!validEntry(saved) || saved.value !== sent.value || saved.revision <= expectedRevision)
            throw new ApiError('保存结果无法核验，请重新读取此项。', 'protocol');
          if (!this.entries[key]) throw Error('当前草稿已移除，本次保存结果需重新核对。');
          this.entries[key] = { value: this.entries[key].value, revision: saved.revision };
          if (this.entries[key].value === sent.value) this.dirty.delete(key);
          this.issues.delete(key);
          this.touch(key);
        } catch (error) {
          if (
            inspection.generation === this.generation &&
            !this.stopped &&
            inspection.owner === (this.owners.get(key) || 0) &&
            this.entries[key]
          ) {
            this.issues.set(key, this.classify(key, error));
            this.inspections.delete(key);
            this.backup();
            this.publish();
          }
          throw error;
        }
      }
      this.retryKeys.delete(key);
      this.backup();
      this.publish();
    } finally {
      if (inspection.generation === this.generation) this.resolving.delete(key);
      if (this.dirty.size) this.schedule();
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.backup();
    for (const reader of this.readers) reader.abort();
    this.inspections.clear();
  }
}

export const newDraftKey = (projectId: string) => (projectId ? `draft:project:${projectId}` : 'draft:chat');
export const runSetupDraftKey = (projectId: string) =>
  projectId ? `draft:setup:project:${projectId}` : 'draft:setup:chat';
