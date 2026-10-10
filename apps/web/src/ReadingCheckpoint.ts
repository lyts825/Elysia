import { useLayoutEffect, useRef } from 'react';
import type { SurfaceClient } from './api';

// Keep small reading metadata for this client lifetime, never document contents.
// A permanently bound client also isolates different surfaces and server sessions.
const stores = new WeakMap<SurfaceClient, Map<string, object>>();
const limit = 192;
export function readingCheckpoint<T extends object>(client: SurfaceClient, key: string): T | undefined {
  const store = stores.get(client),
    value = store?.get(key);
  if (value) {
    store!.delete(key);
    store!.set(key, value);
  }
  return value as T | undefined;
}
export function saveReadingCheckpoint<T extends object>(client: SurfaceClient, key: string, value: T) {
  let store = stores.get(client);
  if (!store) stores.set(client, (store = new Map()));
  store.delete(key);
  store.set(key, value);
  while (store.size > limit) store.delete(store.keys().next().value!);
}
export function forgetReadingCheckpoint(client: SurfaceClient, key: string) {
  stores.get(client)?.delete(key);
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
  const restored = useRef('');
  useLayoutEffect(() => {
    const node = ref.current;
    if (!ready || !node || restored.current === key) return;
    const saved = readingCheckpoint<{ top: number; left: number }>(client, key);
    node.scrollTop = saved?.top || 0;
    node.scrollLeft = saved?.left || 0;
    restored.current = key;
  }, [client, key, ready]);
  return {
    ref,
    onScroll: () => {
      const node = ref.current;
      if (!ready || !node || restored.current !== key) return;
      saveReadingCheckpoint(client, key, { top: node.scrollTop, left: node.scrollLeft });
    },
  };
}
