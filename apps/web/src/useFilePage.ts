import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { PreviewFile } from '../../../packages/contracts/src/preview';

export type FilePreviewContent = Pick<
  PreviewFile,
  'path' | 'text' | 'kind' | 'mediaType' | 'page' | 'encoding' | 'encodingSource' | 'resourceUrl'
> & {
  resourceBase?: string | null;
  directory?: boolean;
  entries?: { path: string; name: string; directory: boolean; size?: number }[];
  truncated?: boolean;
};

const start = (scope: string) => ({
  scope,
  offset: 0,
  version: undefined as string | undefined,
  history: [] as number[],
  revision: 0,
});

export function useFilePage(endpoint: string, encoding: string, refresh: number) {
  const scope = JSON.stringify([endpoint, encoding, refresh]);
  const [position, setPosition] = useState(() => start(scope));
  const current = position.scope === scope ? position : start(scope);
  // Retire the old cursor even when the new file/encoding fails to load.
  if (position.scope !== scope) setPosition(current);
  const key = JSON.stringify([scope, current.offset, current.version, current.revision]);
  const [result, setResult] = useState<{
    scope: string;
    key: string;
    value?: FilePreviewContent;
    error?: string;
    loading: boolean;
  }>({ scope: '', key: '', loading: true });
  const [notice, setNotice] = useState<{ scope: string; text: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const loading = result.key !== key || result.loading;
  const value = result.scope === scope ? result.value : undefined;
  const error = result.key === key ? result.error : undefined;
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    request.current = controller;
    pending.current = true;
    setResult((old) => ({ scope, key, loading: true, value: old.scope === scope ? old.value : undefined }));
    const query = new URLSearchParams({ encoding, offset: String(current.offset), limit: String(64 * 1024) });
    if (current.version) query.set('version', current.version);
    api<FilePreviewContent>(
      endpoint + (endpoint.includes('?') ? '&' : '?') + query,
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (alive && !controller.signal.aborted) setResult({ scope, key, value, loading: false });
      })
      .catch((error: unknown) => {
        if (!alive || controller.signal.aborted) return;
        if (error instanceof ApiError && error.code === 'FILE_CHANGED' && current.version) {
          setNotice({ scope, text: '文件已变化，已重新读取开头。' });
          setPosition({ ...start(scope), revision: current.revision + 1 });
        } else
          setResult({
            scope,
            key,
            error: error instanceof Error ? error.message : '读取失败，请重试。',
            loading: false,
          });
      })
      .finally(() => {
        if (request.current === controller) {
          request.current = null;
          pending.current = false;
        }
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [key, scope, endpoint, encoding, current.offset, current.version, current.revision]);
  const move = (offset: number, history: number[]) => {
    if (loading || pending.current || !value?.page) return;
    const total = value.page.totalBytes;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= total || offset === value.page.offset)
      return;
    pending.current = true;
    setPosition({
      scope,
      offset,
      version: value.page.version,
      history: history.slice(-128),
      revision: current.revision,
    });
  };
  return {
    value,
    error,
    loading,
    notice: notice?.scope === scope ? notice.text : '',
    hasPrevious: current.history.length > 0,
    previous: () => {
      const history = current.history.slice();
      const offset = history.pop();
      if (offset !== undefined) move(offset, history);
    },
    next: () => {
      if (value?.page?.nextOffset != null)
        move(value.page.nextOffset, [...current.history, value.page.offset]);
    },
    jump: (offset: number) => move(offset, value?.page ? [...current.history, value.page.offset] : []),
    restart: () => {
      request.current?.abort();
      setPosition({ ...start(scope), revision: current.revision + 1 });
    },
  };
}
