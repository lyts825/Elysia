/**
 * 处理阅读进度检查点及其状态。
 * EN: Manages reading checkpoints and their state.
 *
 * 按界面客户端与认证范围隔离阅读位置，通过白名单元数据及容量限制恢复浏览器会话状态。滚动恢复先于后续保存，避免初始布局事件覆盖已有位置。
 * EN: Isolate reading positions by surface client and authentication scope, restoring bounded whitelist metadata from session storage. Restore scroll before enabling saves to protect prior positions from initial layout events.
 */
import { useLayoutEffect, useRef } from 'react';
import type { SurfaceClient } from './api';

type CheckpointStore = {
  values: Map<string, object>;
  bound?: boolean;
  scope?: string;
  surface?: string;
  storageKey?: string;
  timer?: ReturnType<typeof setTimeout>;
};
const stores = new WeakMap<SurfaceClient, CheckpointStore>();
const pending = new Set<CheckpointStore>();
const limit = 192;
const maxPayload = 512 * 1024;
const prefix = 'elysia.reading.v1:';
const encodings = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030'];
const views = ['page', 'source', 'diff', 'activity'];
/**
 * 校验检查点中的 UUID 标识，仅接受标准分组的十六进制形式，阻止无效实体引用进入恢复数据。
 * EN: Validate UUID-shaped hexadecimal identifiers before admitting entity references into restored checkpoints.
 */
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
/**
 * 校验受长度限制的字符串，并排除控制字符；用于可持久化的名称、键和其他短文本。
 * EN: Validate bounded strings and reject control characters for persisted names, keys, and short text fields.
 */
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value);
/**
 * 仅接受非负安全整数，保证分页位置、计数和滚动偏移可可靠地序列化和比较。
 * EN: Accept nonnegative safe integers so positions, counts, and offsets can be serialized and compared reliably.
 */
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/**
 * 允许空版本或 64 位十六进制版本摘要；恢复时用摘要判断内容是否仍属于原版本。
 * EN: Accept null or a 64-character hexadecimal version digest used to associate restored state with its original content.
 */
const version = (value: unknown) =>
  value == null || (typeof value === 'string' && /^[\da-f]{64}$/i.test(value));
/**
 * 校验检查点中的相对路径，拒绝绝对路径、盘符及父目录跳转，保持恢复范围位于当前资料目录内。
 * EN: Validate relative checkpoint paths, rejecting absolute paths, drive prefixes, and parent traversal to retain directory scope.
 */
const path = (value: unknown): value is string =>
  text(value, 1000) &&
  !!value &&
  !/^(?:[a-z]:|[\\/])/i.test(value) &&
  !value.split(/[\\/]/).some((part) => part === '..');
/**
 * 解析列表修订令牌的三元组结构，校验整数、时间值和变更标记；非法 JSON 或字段直接判为无效。
 * EN: Parse the revision-token triple and validate its integer, time, and change marker; reject malformed JSON or fields.
 */
const revision = (value: unknown) => {
  if (!text(value, 128)) return false;
  try {
    const parts: unknown = JSON.parse(value);
    return (
      Array.isArray(parts) &&
      parts.length === 3 &&
      integer(parts[0]) &&
      typeof parts[1] === 'number' &&
      Number.isFinite(parts[1]) &&
      parts[1] >= 0 &&
      ['', 'A', 'M', 'D'].includes(parts[2])
    );
  } catch {
    return false;
  }
};

/**
 * 只识别自己的元数据键；任意对象、正文和 API 响应
 * EN: Recognize only our metadata keys. Arbitrary objects, content and API responses
 */
/**
 * 不能通过此通用内存接口成为持久检查点。
 * EN: cannot become persisted checkpoints through this generic in-memory interface.
 */
function kind(key: string, depth = 0): string | undefined {
  /**
   * 按类型识别允许持久化的元数据键，并限制嵌套解析深度。
   * EN: Validate permitted metadata by key type and bound nested parsing depth.
   */
  if (depth > 3 || !text(key, 12000)) return;
  for (const suffix of [':task', ':target', ':source-scroll']) {
    if (key.endsWith(suffix)) {
      const base = kind(key.slice(0, -suffix.length), depth + 1);
      return base === 'selection' && suffix !== ':source-scroll'
        ? suffix.slice(1)
        : base === 'workspace-scroll' && suffix === ':source-scroll'
          ? 'scroll'
          : undefined;
    }
  }
  let parts: unknown[];
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value)) return;
    parts = value;
  } catch {
    return;
  }
  const [tag, run, task, file, workspace, baseline] = parts;
  if (parts.length === 2 && uuid(run)) {
    if (tag === 'preview-dock') return 'dock';
    if (tag === 'preview-selection') return 'selection';
    if (tag === 'preview-preferences') return 'preferences';
  }
  if (
    tag === 'workspace-file' &&
    parts.length === 6 &&
    uuid(run) &&
    uuid(task) &&
    path(file) &&
    text(workspace, 4096) &&
    (baseline === null || text(baseline, 160))
  )
    return 'position';
  if (tag === 'artifact' && parts.length === 3 && uuid(run) && uuid(task)) return 'artifact';
  if (
    tag === 'file-page' &&
    parts.length === 4 &&
    typeof run === 'string' &&
    kind(run, depth + 1) === 'artifact' &&
    typeof task === 'string' &&
    /^\/artifacts\/[\da-f-]{36}\/preview$/i.test(task) &&
    encodings.includes(file as string)
  )
    return 'page';
  if (
    tag === 'content-view' &&
    parts.length === 3 &&
    typeof run === 'string' &&
    kind(run, depth + 1) === 'artifact' &&
    path(task)
  )
    return 'content';
  if (typeof tag !== 'string') return;
  const base = kind(tag, depth + 1);
  if (
    base === 'position' &&
    [6, 7].includes(parts.length) &&
    revision(run) &&
    version(task) &&
    views.includes(file as string) &&
    integer(workspace) &&
    encodings.includes(baseline as string) &&
    (parts.length === 6 || parts[6] === 'scroll')
  )
    return parts.length === 6 ? 'workspace-scroll' : 'scroll';
  if (base === 'artifact' && parts.length === 3 && run === 'outer' && version(task)) return 'scroll';
  if (
    base === 'content' &&
    parts.length === 5 &&
    version(run) &&
    integer(task) &&
    encodings.includes(file as string) &&
    ['document', 'source'].includes(workspace as string)
  )
    return 'scroll';
}
/**
 * 按检查点类别提取允许持久化的元数据，逐项校验字段、版本和历史长度。通过白名单重建对象，避免把任意页面状态或正文内容写入浏览器恢复区。
 * EN: Rebuild persisted metadata from a per-kind whitelist, validating fields, versions, and bounded history; arbitrary UI state or document bodies cannot enter browser recovery.
 */
function metadata(key: string, value: unknown): object | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  /**
   * 检查对象是否只含当前类型允许的键，拒绝混入其他检查点类型的字段。
   * EN: Require every object key to belong to the current checkpoint schema, rejecting fields from other checkpoint types.
   */
  const fields = (allowed: string[]) => Object.keys(record).every((field) => allowed.includes(field));
  /**
   * 限制历史位置最多 128 项且均为非负安全整数，避免损坏缓存或异常历史无限膨胀。
   * EN: Require at most 128 nonnegative safe-integer history positions to bound corrupted or oversized recovery data.
   */
  const history = () =>
    Array.isArray(record.history) && record.history.length <= 128 && record.history.every(integer);
  /**
   * 校验偏移对应的内容版本；非零偏移必须附带有效摘要，防止把旧位置应用到未知正文。
   * EN: Validate the content version paired with an offset; nonzero offsets require a valid digest before restoration.
   */
  const checkedVersion = () =>
    (record.version === undefined || (typeof record.version === 'string' && version(record.version))) &&
    (record.offset === 0 || typeof record.version === 'string');
  switch (kind(key)) {
    case 'dock':
      if (
        fields(['view', 'artifactId', 'requestId', 'wide']) &&
        ['workspace', 'artifacts'].includes(record.view as string) &&
        (record.artifactId === undefined || uuid(record.artifactId)) &&
        (record.requestId === undefined || record.requestId === '' || uuid(record.requestId)) &&
        typeof record.wide === 'boolean'
      )
        return { ...record };
      break;
    case 'selection':
      if (
        Object.keys(record).length <= 64 &&
        Object.entries(record).every(([task, file]) => uuid(task) && path(file))
      )
        return { ...record };
      break;
    case 'task':
      if (fields(['taskId']) && uuid(record.taskId)) return { taskId: record.taskId };
      break;
    case 'target':
      if (fields(['requestId']) && uuid(record.requestId)) return { requestId: record.requestId };
      break;
    case 'preferences':
      if (
        fields(['view', 'auto', 'viewport']) &&
        views.includes(record.view as string) &&
        typeof record.auto === 'boolean' &&
        ['desktop', 'mobile'].includes(record.viewport as string)
      )
        return { ...record };
      break;
    case 'artifact':
      if (fields(['encoding']) && encodings.includes(record.encoding as string)) return { ...record };
      break;
    case 'position':
      if (
        fields(['revision', 'offset', 'history', 'encoding', 'version', 'view']) &&
        revision(record.revision) &&
        integer(record.offset) &&
        history() &&
        encodings.includes(record.encoding as string) &&
        checkedVersion() &&
        (record.view === undefined || views.includes(record.view as string))
      )
        return { ...record, history: [...(record.history as number[])] };
      break;
    case 'page':
      if (
        fields(['scope', 'offset', 'history', 'version', 'revision']) &&
        integer(record.offset) &&
        history() &&
        checkedVersion() &&
        integer(record.revision)
      )
        return {
          offset: record.offset,
          history: [...(record.history as number[])],
          version: record.version,
          revision: record.revision,
        };
      break;
    case 'content':
      if (
        fields(['mode', 'wrap']) &&
        ['document', 'source'].includes(record.mode as string) &&
        typeof record.wrap === 'boolean'
      )
        return { ...record };
      break;
    case 'scroll':
      if (
        fields(['top', 'left']) &&
        [record.top, record.left].every(
          (number) =>
            typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 2 ** 31,
        )
      )
        return { ...record };
  }
}
/**
 * 按 SurfaceClient 惰性建立独立检查点容器。WeakMap 随客户端释放关联数据，防止不同界面的阅读状态串用。
 * EN: Lazily allocate a checkpoint store per SurfaceClient; WeakMap lifetime and client identity isolate reading state across surfaces.
 */
function state(client: SurfaceClient) {
  let store = stores.get(client);
  if (!store) stores.set(client, (store = { values: new Map() }));
  return store;
}
/**
 * 只序列化白名单元数据，按最近使用顺序在总容量内保留条目；失败继续以内存位置工作。
 * EN: Serialize whitelisted metadata only, retaining recent entries within total capacity; failures leave in-memory position usable.
 */
function flush(store: CheckpointStore) {
  if (store.timer) clearTimeout(store.timer);
  store.timer = undefined;
  pending.delete(store);
  if (!store.storageKey) return;
  const entries = [...store.values].flatMap(([key, value]) => {
    const checked = metadata(key, value);
    return checked ? [[key, checked] as const] : [];
  });
  const envelope = { schema: 1, scope: store.scope, surface: store.surface };
  let size = JSON.stringify({ ...envelope, entries: [] }).length;
  const retained: typeof entries = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index],
      bytes = JSON.stringify(entry).length + 1;
    if (size + bytes > maxPayload) continue;
    size += bytes;
    retained.unshift(entry);
  }
  const serialized = JSON.stringify({ ...envelope, entries: retained });
  try {
    sessionStorage.setItem(store.storageKey, serialized);
  } catch {
    /**
     * 内存状态仍可使用。
     * EN: Memory remains usable.
     */
  }
}
let listening = false;
/**
 * 以 150 毫秒防抖合并滚动写入，并只注册一次离页和隐藏监听；离开页面前立即刷出尚未落盘的位置。
 * EN: Debounce scroll persistence by 150 ms and install leave/hidden listeners once so pending positions flush before the page is left.
 */
function schedule(store: CheckpointStore) {
  /**
   * 合并短时间内的滚动更新；页面隐藏或退出时立即写出待保存检查点。
   * EN: Coalesce scroll bursts; flush pending checkpoints immediately on page hide/exit.
   */
  if (!store.storageKey || store.timer) return;
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    /**
     * 遍历待写容器并调用其刷盘逻辑，集中处理页面隐藏或关闭前的最后一次保存。
     * EN: Flush every pending store during the final save triggered by page hiding or departure.
     */
    const flushPending = () => {
      for (const item of [...pending]) flush(item);
    };
    window.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushPending();
    });
  }
  pending.add(store);
  store.timer = setTimeout(() => flush(store), 150);
}

/**
 * 认证后才允许导入会话存储。入口或数据范围改变先刷新旧存储，再清空内存；
 * 新副本必须同时匹配 schema、scope、surface 和各条目的元数据约束。
 * EN: Import session storage only after authentication. On surface/scope changes flush old storage then clear memory. New copies must match schema/scope/surface and entry-specific metadata constraints.
 */
export function bindReadingCheckpointScope(client: SurfaceClient, scope: string | undefined): void {
  /**
   * 仅认证后绑定作用域；切换入口或数据范围时先清空旧内存状态。
   * EN: Bind scope only after authentication and clear old memory when surface/data scope changes.
   */
  const store = state(client);
  const checkedScope = text(scope, 256) && !!scope.trim() ? scope : undefined;
  if (store.bound && store.scope === checkedScope && store.surface === client.surface) return;
  flush(store);
  store.values.clear();
  store.bound = true;
  store.scope = checkedScope;
  store.surface = client.surface;
  store.storageKey = checkedScope ? prefix + JSON.stringify([client.surface, checkedScope]) : undefined;
  if (!store.storageKey) return;
  try {
    const serialized = sessionStorage.getItem(store.storageKey);
    if (!serialized || serialized.length > maxPayload) return;
    const value = JSON.parse(serialized);
    if (
      value.schema !== 1 ||
      value.scope !== checkedScope ||
      value.surface !== client.surface ||
      !Array.isArray(value.entries) ||
      value.entries.length > limit
    )
      return;
    for (const entry of value.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue;
      const checked = metadata(entry[0], entry[1]);
      if (checked) store.values.set(entry[0], checked);
    }
  } catch {
    /**
     * 损坏或不可用存储从空检查点开始。
     * EN: Corrupt or unavailable storage starts with an empty checkpoint.
     */
  }
}
/**
 * 读取指定键的检查点并更新最近访问顺序；返回值按调用方类型解释，容量淘汰优先保留近期阅读位置。
 * EN: Read a typed checkpoint and refresh its recency, allowing capacity eviction to retain recently accessed reading positions.
 */
export function readingCheckpoint<T extends object>(client: SurfaceClient, key: string): T | undefined {
  /**
   * 读取时将条目移到最近使用位置，使容量淘汰保留近期阅读位置。
   * EN: Move read entries to most-recent use so capacity eviction preserves recent reading positions.
   */
  const store = state(client),
    value = store.values.get(key);
  if (value) {
    store.values.delete(key);
    store.values.set(key, value);
  }
  return value as T | undefined;
}
/**
 * 保存最近使用的阅读元数据；绑定范围后的记录经过按键类型校验，不接受任意正文。
 * EN: Save recent reading metadata. Bound-scope records are checked by key type and cannot contain arbitrary bodies.
 */
export function saveReadingCheckpoint<T extends object>(client: SurfaceClient, key: string, value: T) {
  /**
   * 已绑定的作用域只接受经过元数据校验的内容，避免把正文写入检查点。
   * EN: Accept validated metadata only after scope binding, keeping bodies out of checkpoints.
   */
  const store = state(client),
    checked = store.bound ? metadata(key, value) : value;
  if (!checked) return;
  store.values.delete(key);
  store.values.set(key, checked);
  while (store.values.size > limit) store.values.delete(store.values.keys().next().value!);
  schedule(store);
}
/**
 * 移除指定阅读位置；只有实际删除了条目才安排持久化，减少无效浏览器写入。
 * EN: Remove a checkpoint and schedule persistence only when an entry was actually deleted.
 */
export function forgetReadingCheckpoint(client: SurfaceClient, key: string) {
  const store = state(client);
  if (store.values.delete(key)) schedule(store);
}

export type ReadingPosition = {
  revision: string;
  offset: number;
  history: number[];
  encoding: string;
  version?: string;
  view?: string;
};
/**
 * 视图正文 ready 后按客户端、键和实际 DOM 节点恢复一次滚动位置。
 * 恢复前的 scroll 事件被忽略，避免初始布局把有效检查点覆盖为零。
 * EN: Restore scrolling once after body readiness, keyed by client/key/actual node. Ignore early scroll events so initial layout cannot replace a good checkpoint with zero.
 */
export function useReadingScroll<T extends HTMLElement = HTMLDivElement>(
  client: SurfaceClient,
  key: string,
  ready: boolean,
) {
  /**
   * 视图准备好后恢复一次滚动位置，再允许滚动事件更新检查点。
   * EN: Restore once after readiness, then allow scrolling to update checkpoints.
   */
  const ref = useRef<T>(null);
  const restored = useRef<{ client: SurfaceClient; key: string; node: T } | undefined>(undefined);
  useLayoutEffect(() => {
    const node = ref.current;
    if (
      !ready ||
      !node ||
      (restored.current?.client === client && restored.current.key === key && restored.current.node === node)
    )
      return;
    const saved = readingCheckpoint<{ top: number; left: number }>(client, key);
    node.scrollTop = saved?.top || 0;
    node.scrollLeft = saved?.left || 0;
    restored.current = { client, key, node };
  }, [client, key, ready]);
  return {
    ref,
    /**
     * 仅在节点、客户端和键均匹配已完成的恢复时保存滚动位置，避免恢复前的零偏移覆盖原检查点。
     * EN: Save scroll offsets only after restoration for the same node, client, and key, protecting existing checkpoints from initial zero offsets.
     */
    onScroll: () => {
      const node = ref.current;
      if (
        !ready ||
        !node ||
        restored.current?.client !== client ||
        restored.current.key !== key ||
        restored.current.node !== node
      )
        return;
      saveReadingCheckpoint(client, key, { top: node.scrollTop, left: node.scrollLeft });
    },
  };
}
