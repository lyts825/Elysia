/* 管理对话历史的检查点与读取状态。 */
import type { SurfaceClient } from './api';
import type { HistoryAnchor } from './HistoryScroll';

export type ConversationHistoryCheckpoint = {
  anchor?: HistoryAnchor;
  following: boolean;
  before?: string | null;
  around?: string | null;
  updatedAt: number;
};
const maxRuns = 50;
const maxAge = 30 * 24 * 60 * 60 * 1000;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const validCursor = (value: unknown) => value === undefined || value === null || validId(value);
function checkpoint(value: unknown): ConversationHistoryCheckpoint | undefined {
  if (!value || typeof value !== 'object') return;
  const saved = value as ConversationHistoryCheckpoint;
  if (
    typeof saved.following !== 'boolean' ||
    !Number.isFinite(saved.updatedAt) ||
    saved.updatedAt > Date.now() + 60000 ||
    Date.now() - saved.updatedAt > maxAge ||
    !validCursor(saved.before) ||
    !validCursor(saved.around)
  )
    return;
  const anchor = saved.anchor;
  if (anchor && (!validId(anchor.id) || !Number.isFinite(anchor.offset) || Math.abs(anchor.offset) > 1000000))
    return;
  if (!saved.following && !anchor) return;
  return {
    following: saved.following,
    ...(anchor ? { anchor: { id: anchor.id, offset: anchor.offset } } : {}),
    ...(saved.before !== undefined ? { before: saved.before } : {}),
    ...(saved.around !== undefined ? { around: saved.around } : {}),
    updatedAt: saved.updatedAt,
  };
}

/** Reading positions stay in this browser window; no message text is stored. */
export class ConversationHistoryState {
  private scope = '';
  private entries = new Map<string, ConversationHistoryCheckpoint>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly pageHide = () => this.flush();
  private readonly visibility = () => {
    if (document.visibilityState === 'hidden') this.flush();
  };
  constructor(private client: Pick<SurfaceClient, 'surfaceStorageKey'>) {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.pageHide);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibility);
  }
  private key() {
    return this.client.surfaceStorageKey(`elysia.conversation.history.v1:${this.scope}`);
  }
  bindScope(scope: string | undefined) {
    if (this.stopped || !scope || !/^[a-f0-9]{64}$/.test(scope) || scope === this.scope) return;
    this.flush();
    this.scope = scope;
    this.entries.clear();
    try {
      const raw = sessionStorage.getItem(this.key());
      if (!raw || raw.length > 1024 * 1024) return;
      const saved = JSON.parse(raw);
      if (saved?.version !== 1 || !Array.isArray(saved.entries)) return;
      for (const item of saved.entries.slice(0, maxRuns)) {
        if (!Array.isArray(item) || !validId(item[0])) continue;
        const value = checkpoint(item[1]);
        if (value) this.entries.set(item[0], value);
      }
    } catch {
      // An unavailable or corrupt browser copy never blocks the conversation.
    }
  }
  get(runId: string) {
    const value = checkpoint(this.entries.get(runId));
    return value ? { ...value, ...(value.anchor ? { anchor: { ...value.anchor } } : {}) } : undefined;
  }
  set(runId: string, value: Omit<ConversationHistoryCheckpoint, 'updatedAt'>) {
    if (this.stopped || !this.scope || !validId(runId)) return;
    const next = checkpoint({ ...value, updatedAt: Date.now() });
    if (!next) return;
    this.entries.delete(runId);
    this.entries.set(runId, next);
    while (this.entries.size > maxRuns) this.entries.delete(this.entries.keys().next().value!);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }
  remove(runIds: string[]) {
    for (const runId of runIds) this.entries.delete(runId);
    this.flush();
  }
  flush() {
    clearTimeout(this.timer);
    if (!this.scope) return;
    try {
      sessionStorage.setItem(
        this.key(),
        JSON.stringify({ version: 1, entries: [...this.entries].reverse().slice(0, maxRuns) }),
      );
    } catch {
      // Keep positions in memory if browser storage is unavailable.
    }
  }
  stop() {
    this.flush();
    this.stopped = true;
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.pageHide);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibility);
  }
}
