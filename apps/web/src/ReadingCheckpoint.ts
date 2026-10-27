/* 处理阅读进度检查点及其状态。 */
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
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const version = (value: unknown) =>
  value == null || (typeof value === 'string' && /^[\da-f]{64}$/i.test(value));
const path = (value: unknown): value is string =>
  text(value, 1000) &&
  !!value &&
  !/^(?:[a-z]:|[\\/])/i.test(value) &&
  !value.split(/[\\/]/).some((part) => part === '..');
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

// Recognize only our metadata keys. Arbitrary objects, content and API responses
// cannot become persisted checkpoints through this generic in-memory interface.
function kind(key: string, depth = 0): string | undefined {
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
function metadata(key: string, value: unknown): object | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const fields = (allowed: string[]) => Object.keys(record).every((field) => allowed.includes(field));
  const history = () =>
    Array.isArray(record.history) && record.history.length <= 128 && record.history.every(integer);
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
function state(client: SurfaceClient) {
  let store = stores.get(client);
  if (!store) stores.set(client, (store = { values: new Map() }));
  return store;
}
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
    /* Memory remains usable. */
  }
}
let listening = false;
function schedule(store: CheckpointStore) {
  if (!store.storageKey || store.timer) return;
  if (!listening && typeof window !== 'undefined') {
    listening = true;
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

// Call only after this client's session has authenticated. A changed server/data
// scope drops the old in-memory selection; storage is never imported beforehand.
export function bindReadingCheckpointScope(client: SurfaceClient, scope: string | undefined): void {
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
    /* Corrupt or unavailable storage starts with an empty checkpoint. */
  }
}
export function readingCheckpoint<T extends object>(client: SurfaceClient, key: string): T | undefined {
  const store = state(client),
    value = store.values.get(key);
  if (value) {
    store.values.delete(key);
    store.values.set(key, value);
  }
  return value as T | undefined;
}
export function saveReadingCheckpoint<T extends object>(client: SurfaceClient, key: string, value: T) {
  const store = state(client),
    checked = store.bound ? metadata(key, value) : value;
  if (!checked) return;
  store.values.delete(key);
  store.values.set(key, checked);
  while (store.values.size > limit) store.values.delete(store.values.keys().next().value!);
  schedule(store);
}
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
export function useReadingScroll<T extends HTMLElement = HTMLDivElement>(
  client: SurfaceClient,
  key: string,
  ready: boolean,
) {
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
