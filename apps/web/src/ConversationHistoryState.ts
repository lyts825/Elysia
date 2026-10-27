/**
 * 管理对话历史的检查点与读取状态。
 * 按入口和工作台作用域保存会话阅读检查点，限制时效、条数与锚点格式；sessionStorage失败时只保留内存副本。
 * EN: Manages conversation reading checkpoints and history state. Stores conversation reading checkpoints by surface/workbench with age, count, and anchor validation; sessionStorage failure leaves the in-memory copy available.
 */
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
/**
 * 识别UUID格式的运行或消息标识；作为类型守卫拒绝缓存中的任意字符串。
 * EN: Recognizes UUID-shaped run or message IDs; the type guard rejects arbitrary strings from cached input.
 */
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
/**
 * 允许空分页游标或合法UUID；用于恢复前校验历史窗口边界。
 * EN: Accepts an absent cursor or a valid UUID, validating history-window boundaries before restoration.
 */
const validCursor = (value: unknown) => value === undefined || value === null || validId(value);
/**
 * 从不可信缓存解码阅读检查点；校验时效、跟随状态、窗口游标和锚点，无法安全恢复时返回undefined。
 * EN: Decodes a reading checkpoint from untrusted cache input, checking age, follow state, window cursors, and anchor; returns undefined when restoration is unsafe.
 */
function checkpoint(value: unknown): ConversationHistoryCheckpoint | undefined {
  /**
   * 浏览器缓存不是可信输入；失效、超前当前时间 60 秒以上或锚点不合法时不恢复。
   * EN: Browser cache is untrusted. Do not restore expired checkpoints, timestamps more than 60 seconds ahead, or invalid anchors.
   */
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

/**
 * 保存本窗口中每个运行的阅读锚点与是否跟随最新消息，不保存消息正文。
 * 认证范围和入口共同隔离 sessionStorage；最多保留 50 个运行、30 天内的有效检查点，
 * 浏览器副本损坏或不可用时只放弃位置恢复，不阻止会话读取。
 * EN: Save reading anchors and follow-latest mode per run in this window, not message bodies. Authentication scope and surface isolate sessionStorage. Retain at most 50 runs with valid checkpoints from the past 30 days. A corrupt or unavailable browser copy disables restoration only, not conversation reads.
 */
export class ConversationHistoryState {
  private scope = '';
  private entries = new Map<string, ConversationHistoryCheckpoint>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /**
   * 页面退出时同步刷出待保存的阅读位置；使用稳定实例回调便于解除监听。
   * EN: Flushes pending reading positions when the page hides; a stable instance callback allows listener removal.
   */
  private readonly pageHide = () => this.flush();
  /**
   * 仅在文档转为隐藏时落盘，减少切后台或关闭页面导致的阅读位置丢失。
   * EN: Persists positions when the document becomes hidden, reducing losses on backgrounding or page closure.
   */
  private readonly visibility = () => {
    if (document.visibilityState === 'hidden') this.flush();
  };
  /**
   * 注入入口级存储键生成器并注册页面生命周期监听；实际工作区在bindScope时绑定，stop负责解除监听。
   * EN: Injects surface-scoped storage-key generation and registers page lifecycle listeners. bindScope selects the workspace and stop removes the listeners.
   */
  constructor(private client: Pick<SurfaceClient, 'surfaceStorageKey'>) {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.pageHide);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibility);
  }
  /**
   * 按当前工作区和入口生成版本化sessionStorage键，隔离不同入口及工作区的阅读历史。
   * EN: Builds a versioned sessionStorage key for the active workspace and surface, isolating their reading histories.
   */
  private key() {
    return this.client.surfaceStorageKey(`elysia.conversation.history.v1:${this.scope}`);
  }
  /**
   * 切换到合法且不同的工作区：先刷出旧位置再读取并校验新缓存；坏缓存忽略，不跨作用域复用。
   * EN: Switches to a different valid workspace by flushing old positions before reading and validating the new cache. Invalid cached data is ignored rather than reused across scopes.
   */
  bindScope(scope: string | undefined) {
    /**
     * 先落盘旧作用域，再清空内存并读取新作用域，避免不同工作区共享阅读位置。
     * EN: Flush the old scope before clearing memory and loading the new one, preventing reading positions from being shared across workspaces.
     */
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
      /**
       * 浏览器副本不可用或损坏时，不阻止对话读取。
       * EN: An unavailable or corrupt browser copy never blocks the conversation.
       */
    }
  }
  /**
   * 每次返回前重验时效并复制嵌套锚点，调用方不能直接修改缓存内部对象。
   * EN: Revalidate age before each return and clone the nested anchor so callers cannot mutate the cache internals.
   */
  get(runId: string) {
    const value = checkpoint(this.entries.get(runId));
    return value ? { ...value, ...(value.anchor ? { anchor: { ...value.anchor } } : {}) } : undefined;
  }
  /**
   * 接受已经定位的阅读状态；非跟随模式必须有合法锚点，连续滚动写入合并到 150 毫秒。
   * EN: Accept a located reading state. Non-following mode requires a valid anchor; coalesce successive scroll writes over 150 milliseconds.
   */
  set(runId: string, value: Omit<ConversationHistoryCheckpoint, 'updatedAt'>) {
    if (this.stopped || !this.scope || !validId(runId)) return;
    const next = checkpoint({ ...value, updatedAt: Date.now() });
    if (!next) return;
    this.entries.delete(runId);
    this.entries.set(runId, next);
    /**
     * Map 按最近更新顺序淘汰旧记录，并合并短时间内的连续滚动写入。
     * EN: Evict Map entries in recent-update order and coalesce writes generated by a short scrolling burst.
     */
    while (this.entries.size > maxRuns) this.entries.delete(this.entries.keys().next().value!);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }
  /**
   * 删除指定运行的内存阅读检查点并立即落盘，避免已移除会话再次恢复旧位置。
   * EN: Deletes the specified runs from in-memory reading checkpoints and persists immediately so removed conversations cannot restore stale positions.
   */
  remove(runIds: string[]) {
    for (const runId of runIds) this.entries.delete(runId);
    this.flush();
  }
  /**
   * 取消防抖并把数量有界的检查点写入当前sessionStorage；存储失败被容错，内存位置继续保留。
   * EN: Cancels debouncing and persists a bounded set of checkpoints to the active sessionStorage key. Storage failures are tolerated while positions remain in memory.
   */
  flush() {
    clearTimeout(this.timer);
    if (!this.scope) return;
    try {
      sessionStorage.setItem(
        this.key(),
        JSON.stringify({ version: 1, entries: [...this.entries].reverse().slice(0, maxRuns) }),
      );
    } catch {
      /**
       * 浏览器存储不可用时仍在内存中保留位置。
       * EN: Keep positions in memory if browser storage is unavailable.
       */
    }
  }
  /**
   * 结束检查点管理：刷出最后位置、标记停止并解除页面监听，供组件卸载时收束资源。
   * EN: Ends checkpoint management by flushing the last positions, marking the instance stopped, and detaching page listeners during component teardown.
   */
  stop() {
    /**
     * 卸载时保存最后位置并解除全局监听，避免遗留计时器或监听器。
     * EN: Save the final position and detach global listeners on unmount, leaving no timer or listener behind.
     */
    this.flush();
    this.stopped = true;
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.pageHide);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibility);
  }
}
